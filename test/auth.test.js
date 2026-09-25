import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  verifyAppProxySignature,
  verifySessionToken,
  verifyWebhookHmac,
} from '../src/shopify/auth.js';
import { sessionToken } from './fixtures.js';

const apiKey = 'key123';
const apiSecret = 'secret456';

test('verifies App Bridge session tokens', () => {
  const token = sessionToken('demo.myshopify.com');
  assert.equal(verifySessionToken(token, { apiKey, apiSecret }).shop, 'demo.myshopify.com');
  assert.throws(() => verifySessionToken(sessionToken('demo.myshopify.com', { secret: 'x' }), { apiKey, apiSecret }), /signature/);
  assert.throws(() => verifySessionToken(sessionToken('demo.myshopify.com', { key: 'other' }), { apiKey, apiSecret }), /audience/);
  assert.throws(
    () => verifySessionToken(sessionToken('demo.myshopify.com', { exp: 1000 }), { apiKey, apiSecret }),
    /expired/,
  );
});

test('verifies webhook HMAC', () => {
  const body = Buffer.from('{"id":1}');
  const hmac = crypto.createHmac('sha256', apiSecret).update(body).digest('base64');
  assert.equal(verifyWebhookHmac(body, hmac, apiSecret), true);
  assert.equal(verifyWebhookHmac(body, 'bad', apiSecret), false);
  assert.equal(verifyWebhookHmac(body, undefined, apiSecret), false);
});

test('verifies app proxy signatures', () => {
  const query = { shop: 'demo.myshopify.com', path_prefix: '/apps/track', timestamp: '1700000000', awb: 'RK775227016IN' };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join('');
  const signature = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  assert.equal(verifyAppProxySignature({ ...query, signature }, apiSecret), true);
  assert.equal(verifyAppProxySignature({ ...query, awb: 'X', signature }, apiSecret), false);
});

test('encrypts secrets at rest', () => {
  const enc = encryptSecret('Dop@1234', 'k');
  assert.match(enc, /^enc:/);
  assert.equal(decryptSecret(enc, 'k'), 'Dop@1234');
  assert.throws(() => decryptSecret(enc, 'other'));
});
