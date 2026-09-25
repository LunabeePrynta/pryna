import path from 'node:path';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  port: Number(env('PORT', 3000)),
  // Express "trust proxy" setting: number of reverse-proxy hops in front of the app (affects req.ip).
  trustProxy: env('TRUST_PROXY', '1'),
  appUrl: env('SHOPIFY_APP_URL', 'http://localhost:3000').replace(/\/$/, ''),
  shopify: {
    apiKey: env('SHOPIFY_API_KEY', ''),
    apiSecret: env('SHOPIFY_API_SECRET', ''),
    apiVersion: env('SHOPIFY_API_VERSION', '2026-07'),
    // Storefront path of the app proxy, e.g. https://store.com/apps/track
    proxyPath: env('SHOPIFY_APP_PROXY_PATH', '/apps/track'),
  },
  indiaPost: {
    // UAT: https://test.cept.gov.in/beextcustomer — switch to the production host after go-live.
    baseUrl: env('INDIAPOST_BASE_URL', 'https://test.cept.gov.in/beextcustomer').replace(/\/$/, ''),
    // Shared secret India Post must send (?secret= or X-Webhook-Secret) when pushing tracking events.
    webhookSecret: env('INDIAPOST_WEBHOOK_SECRET', ''),
    // Optional comma separated allow-list of India Post source IPs for the webhook.
    webhookIps: env('INDIAPOST_WEBHOOK_IPS', '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean),
  },
  // 32 byte key (hex or base64) used to encrypt India Post passwords at rest.
  encryptionKey: env('ENCRYPTION_KEY', ''),
  databasePath: env('DATABASE_PATH', path.resolve('data/app.db')),
  labelDir: env('LABEL_DIR', path.resolve('data/labels')),
  pollIntervalMinutes: Number(env('TRACKING_POLL_MINUTES', 30)),
};
