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
    const res = await this.fetch(`${this.baseUrl}/v1/access/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await readBody(res);
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

  speedPostTariff({ weight, sourcePincode, destinationPincode, length = 0, width = 0, height = 0, ins, pod }) {
    return this.requestJson('GET', '/v1/speed-post/tariffs', {
      query: {
        'product-code': 'SP',
        weight,
        'source-pincode': sourcePincode,
        'destination-pincode': destinationPincode,
        length,
        width,
        height,
        INS: ins,
        POD: pod,
      },
    });
  }

  businessParcelTariff({ weight, sourcePincode, destinationPincode, length = 0, width = 0, height = 0, ins }) {
    return this.requestJson('GET', '/v1/business-parcel-tariff/calculate', {
      query: {
        'product-code': 'BP',
        weight,
        'source-pincode': sourcePincode,
        'destination-pincode': destinationPincode,
        length,
        width,
        height,
        ins,
      },
    });
  }

  /** Books up to 1000 articles in one call. Returns the raw response with valid_articles / error_articles. */
  bookArticles(customerId, articles) {
    if (!articles.length) throw new IndiaPostError('No articles to book');
    if (articles.length > 1000) throw new IndiaPostError('Booking API accepts at most 1000 articles per request');
    return this.requestJson('POST', `/process-articles/${encodeURIComponent(customerId)}`, { json: { articles } });
  }

  /** Generates an address label PDF for one or more articles. Returns a Buffer. */
  async createLabels(labels) {
    const res = await this.request('POST', '/v1/label/create/domestic', {
      json: labels,
      accept: 'application/pdf, application/json',
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || type.includes('json')) {
      const body = await readBody(res);
      throw new IndiaPostError(`Label generation failed: ${describe(body) || res.status}`, { status: res.status, body });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.subarray(0, 4).toString() !== '%PDF') {
      throw new IndiaPostError('Label generation returned a non-PDF response', { status: res.status });
    }
    return buffer;
  }

  /** Tracking for up to 500 articles booked under this customer. */
  async trackBulk(barcodes) {
    if (!barcodes.length) return [];
    if (barcodes.length > 500) throw new IndiaPostError('Tracking API accepts at most 500 articles per request');
    const body = await this.requestJson('POST', '/v1/tracking/bulk', { json: { bulk: barcodes } });
    return Array.isArray(body?.data) ? body.data : [];
  }
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
