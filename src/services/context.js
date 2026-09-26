// Shared services container: settings, per-shop API clients and URLs.

import { IndiaPostClient } from '../indiapost/client.js';
import { defaultSettings, mergeSettings } from '../indiapost/mapper.js';
import { ShopifyAdmin } from '../shopify/admin.js';
import { decryptSecret, encryptSecret } from '../shopify/auth.js';

export const PASSWORD_MASK = '••••••••';

export function createContext({ db, config, fetchImpl = fetch, logger = console }) {
  const secret = config.encryptionKey || config.shopify.apiSecret || 'dev-secret';
  const clients = new Map();

  const ctx = {
    db,
    config,
    logger,
    fetch: fetchImpl,

    /** Settings with the India Post password decrypted — server side only. */
    getSettings(shop) {
      const settings = mergeSettings(db.getSettingsRaw(shop));
      settings.indiaPost.password = decryptSecret(settings.indiaPost.password, secret);
      return settings;
    },

    /** Settings safe to send to the browser (password masked). */
    getPublicSettings(shop) {
      const settings = mergeSettings(db.getSettingsRaw(shop));
      settings.indiaPost.password = settings.indiaPost.password ? PASSWORD_MASK : '';
      return settings;
    },

    saveSettings(shop, input) {
      const current = mergeSettings(db.getSettingsRaw(shop));
      const next = mergeSettings({ ...current, ...pick(input, Object.keys(defaultSettings())) });
      const password = input?.indiaPost?.password;
      next.indiaPost.password =
        password === undefined || password === PASSWORD_MASK ? current.indiaPost.password : encryptSecret(password, secret);
      db.saveSettingsRaw(shop, next);
      clients.delete(shop);
      return ctx.getPublicSettings(shop);
    },

    indiaPostFor(shop, settings = ctx.getSettings(shop)) {
      const { username, password } = settings.indiaPost;
      const baseUrl = settings.indiaPost.baseUrl || config.indiaPost.baseUrl;
      const cacheKey = `${baseUrl}:${username}:${password}`;
      const cached = clients.get(shop);
      if (cached && cached.key === cacheKey) return cached.client;
      const client = new IndiaPostClient({ baseUrl, username, password, fetchImpl });
      clients.set(shop, { key: cacheKey, client });
      return client;
    },

    adminFor(shop) {
      const record = db.getShop(shop);
      if (!record?.access_token) throw new Error(`Shop ${shop} is not installed`);
      return new ShopifyAdmin({ shop, accessToken: record.access_token, apiVersion: config.shopify.apiVersion, fetchImpl });
    },

    /** True when India Post tracking API credentials are configured for the shop. */
    hasTracking(shop, settings = ctx.getSettings(shop)) {
      return Boolean(settings.indiaPost.username && settings.indiaPost.password);
    },

    /**
     * Tracking link for the customer: the store's own tracking page (app proxy) when live tracking is
     * configured, otherwise undefined so Shopify uses its built-in India Post tracking link.
     */
    trackingUrl(shop, barcode) {
      if (!ctx.hasTracking(shop)) return undefined;
      return `https://${shop}${config.shopify.proxyPath}?awb=${encodeURIComponent(barcode)}`;
    },
  };
  return ctx;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj && obj[key] !== undefined) out[key] = obj[key];
  return out;
}
