// Thin client for the India Post (CEPT) external customer APIs.
// Tokens are valid for 15 minutes, so they are cached and refreshed on expiry or on a 401.

export class IndiaPostError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'IndiaPostError';
    this.status = status;
    this.body = body;
  }
}

const TOKEN_SAFETY_MARGIN_MS = 60_000;

export class IndiaPostClient {
  constructor({ baseUrl, username, password, fetchImpl = fetch, timeoutMs = 30_000 }) {
    if (!username || !password) throw new IndiaPostError('India Post username/password are not configured');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.loginPromise = null;
  }

  async login() {
    // The approach document says /v1/access/login, the developer portal shows /v1/access/Login.
    const paths = this.loginPath ? [this.loginPath] : ['/v1/access/login', '/v1/access/Login'];
    let res;
    let body;
    for (const path of paths) {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = await readBody(res);
      if (res.status !== 404 && res.status !== 405) {
        this.loginPath = path;
        break;
      }
    }
    if (!res.ok || !body?.success || !body?.data?.access_token) {
      throw new IndiaPostError(`India Post login failed: ${describe(body) || res.status}`, { status: res.status, body });
    }
    const expiresIn = Number(body.data.expires_in) || 15 * 60;
    this.token = body.data.access_token;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000 - TOKEN_SAFETY_MARGIN_MS;
    return this.token;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    // Share one in-flight login between concurrent callers.
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async request(method, path, { query, json, accept = 'application/json', retry = true } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const token = await this.getToken();
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 401 && retry) {
      this.token = null;
      return this.request(method, path, { query, json, accept, retry: false });
    }
    return res;
  }

  async requestJson(method, path, options) {
    const res = await this.request(method, path, options);
    const body = await readBody(res);
    if (!res.ok || body?.success === false) {
      throw new IndiaPostError(`India Post ${method} ${path} failed: ${describe(body) || res.status}`, {
        status: res.status,
        body,
      });
    }
    return body;
  }

  /** Post offices under a pincode. */
  pincodeSearch(pincode) {
    return this.requestJson('GET', '/v1/pincode-search', { query: { pincode, 'office-type': 'post' } });
  }

  /** Tracking for up to 500 articles booked under this customer. */
  /**
   * Tracking for up to 500 articles. Uses the Bulk Tracking API; if the account isn't subscribed to it,
   * switches (and stays) on "Track single article" (GET /v1/tracking/{trackingNumber}), one call per article.
   * Always returns items in the bulk format.
   */
  async trackBulk(barcodes) {
    if (!barcodes.length) return [];
    if (barcodes.length > 500) throw new IndiaPostError('Tracking API accepts at most 500 articles per request');
    if (this.trackingMode !== 'single') {
      try {
        const body = await this.requestJson('POST', '/v1/tracking/bulk', { json: { bulk: barcodes } });
        this.trackingMode = 'bulk';
        return Array.isArray(body?.data) ? body.data : [];
      } catch (err) {
        if (!(err instanceof IndiaPostError) || ![401, 403, 404, 405].includes(err.status) || this.trackingMode === 'bulk') throw err;
        this.trackingMode = 'single';
      }
    }
    return this.trackEach(barcodes);
  }

  async trackSingle(barcode) {
    const res = await this.request('GET', `/v1/tracking/${encodeURIComponent(barcode)}`);
    if (res.status === 404) return null; // not booked / not scanned yet
    const body = await readBody(res);
    if (!res.ok || body?.success === false) {
      throw new IndiaPostError(`India Post tracking failed: ${describe(body) || res.status}`, { status: res.status, body });
    }
    return body?.data ? singleToBulkItem(barcode, body.data) : null;
  }

  async trackEach(barcodes, concurrency = 4) {
    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < barcodes.length) {
        const barcode = barcodes[next++];
        const item = await this.trackSingle(barcode);
        if (item) results.push(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, barcodes.length) }, worker));
    return results;
  }
}

/** Converts a "Track single article" response into the Bulk Tracking item format. */
export function singleToBulkItem(barcode, data) {
  const status = String(data.currentStatus ?? '');
  return {
    booking_details: {
      article_number: data.trackingNumber || barcode,
      booked_at: data.origin || null,
      delivery_location: data.destination || null,
    },
    tracking_details: (Array.isArray(data.history) ? data.history : []).map((h) => ({
      date: h.timestamp,
      time: null,
      office: h.location,
      officeid: null,
      event: h.status,
      remarks: h.remarks ?? '',
      rts: false,
    })),
    del_status: { del_status: /delivered/i.test(status) && !/not delivered|undelivered/i.test(status) ? 'delivered' : 'not delivered' },
  };
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function describe(body) {
  if (!body) return '';
  const parts = [];
  if (body.message) parts.push(body.message);
  if (Array.isArray(body.errors)) parts.push(...body.errors.map((e) => (typeof e === 'string' ? e : e.msg ?? JSON.stringify(e))));
  return parts.join('; ');
}
