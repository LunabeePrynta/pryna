import crypto from 'node:crypto';

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop) {
  return typeof shop === 'string' && SHOP_RE.test(shop);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Verifies an App Bridge session token (HS256 JWT signed with the app secret)
 * and returns { shop, payload }. Throws on any problem.
 */
export function verifySessionToken(token, { apiKey, apiSecret, now = Date.now() }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new Error('Malformed session token');
  const [header, body, signature] = parts;
  const expected = base64url(crypto.createHmac('sha256', apiSecret).update(`${header}.${body}`).digest());
  if (!safeEqual(signature, expected)) throw new Error('Invalid session token signature');

  const { alg } = JSON.parse(Buffer.from(header, 'base64url').toString());
  if (alg !== 'HS256') throw new Error('Unexpected session token algorithm');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const seconds = Math.floor(now / 1000);
  const leeway = 10;
  if (payload.exp && seconds > payload.exp + leeway) throw new Error('Session token expired');
  if (payload.nbf && seconds < payload.nbf - leeway) throw new Error('Session token not yet valid');
  if (payload.aud !== apiKey) throw new Error('Session token audience mismatch');

  const shop = new URL(payload.dest).hostname;
  if (!isValidShopDomain(shop)) throw new Error('Session token has invalid shop');
  if (payload.iss && new URL(payload.iss).hostname !== shop) throw new Error('Session token issuer mismatch');
  return { shop, payload };
}

/** Exchanges a session token for an offline Admin API access token (Shopify managed installation). */
export async function exchangeToken({ shop, sessionToken, apiKey, apiSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json(); // { access_token, scope }
}

/** Verifies the X-Shopify-Hmac-Sha256 header of a webhook against the raw body. */
export function verifyWebhookHmac(rawBody, hmacHeader, apiSecret) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('base64');
  return safeEqual(digest, hmacHeader);
}

/**
 * Verifies an app proxy request. Shopify signs the query string (minus `signature`),
 * with params sorted and joined as key=value without separators; repeated keys are comma-joined.
 */
export function verifyAppProxySignature(query, apiSecret) {
  const { signature, ...rest } = query;
  if (!signature) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('');
  const digest = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  return safeEqual(digest, signature);
}

// ---- secret encryption (India Post passwords at rest) ----

function keyFrom(secret) {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length === 32) return decoded;
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain, secret) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decryptSecret(value, secret) {
  if (!value || !String(value).startsWith('enc:')) return value || '';
  const raw = Buffer.from(String(value).slice(4), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
