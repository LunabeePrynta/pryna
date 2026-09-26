import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { IndiaPostError } from './indiapost/client.js';
import { PRODUCTS } from './indiapost/mapper.js';
import { STATUS_LABELS } from './indiapost/events.js';
import {
  exchangeToken,
  isValidShopDomain,
  verifyAppProxySignature,
  verifySessionToken,
  verifyWebhookHmac,
} from './shopify/auth.js';
import { createContext } from './services/context.js';
import { ShipmentError, orderDraft, saveShipment } from './services/shipments.js';
import { exportShipments } from './services/export.js';
import { handleIndiaPostEvent, pollAllShops, refreshShipments, searchTracking } from './services/tracking.js';
import { renderStandalonePage, renderTrackingContent } from './views/track.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const adminHtml = fs.readFileSync(path.join(here, 'views/admin.html'), 'utf8');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return next();
    }
    if (++entry.count > max) return res.status(429).send('Too many requests, please try again shortly.');
    next();
  };
}

export function createApp(ctx) {
  const { db, logger } = ctx;
  const { shopify, indiaPost } = ctx.config;
  const app = express();
  app.set('trust proxy', /^\d+$/.test(ctx.config.trustProxy) ? Number(ctx.config.trustProxy) : ctx.config.trustProxy);
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------- Shopify webhooks (raw body needed for HMAC) ----------
  app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyWebhookHmac(raw, req.get('X-Shopify-Hmac-Sha256'), shopify.apiSecret)) return res.sendStatus(401);
    const shop = req.get('X-Shopify-Shop-Domain');
    const topic = req.get('X-Shopify-Topic');
    let payload = {};
    try {
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return res.sendStatus(400);
    }
    res.sendStatus(200);
    handleShopifyWebhook(ctx, shop, topic, payload).catch((err) => logger.error(`[webhook] ${topic} ${shop}: ${err.message}`));
  });

  // ---------- India Post tracking webhook ----------
  const receiveEvents = async (req, res, shop) => {
    const events = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, 1000);
    let stored = 0;
    for (const event of events) if ((await handleIndiaPostEvent(ctx, event, { shop })).stored) stored += 1;
    res.json({ success: true, received: events.length, stored });
  };
  const allowedSource = (req) => !indiaPost.webhookIps.length || indiaPost.webhookIps.includes(req.ip);

  // Each store's private link: https://<app>/webhooks/indiapost/<token> (shown in the store's Settings).
  app.post('/webhooks/indiapost/:token', express.json({ limit: '2mb' }), asyncRoute(async (req, res) => {
    if (!allowedSource(req)) return res.sendStatus(403);
    const shop = /^[a-f0-9]{48}$/.test(req.params.token) ? db.findShopByWebhookToken(req.params.token) : null;
    if (!shop) return res.sendStatus(404);
    await receiveEvents(req, res, shop);
  }));

  // Lets India Post's "Test" button (or a browser) check that a store's link is valid.
  app.get('/webhooks/indiapost/:token', (req, res) => {
    const shop = /^[a-f0-9]{48}$/.test(req.params.token) ? db.findShopByWebhookToken(req.params.token) : null;
    if (!shop) return res.sendStatus(404);
    res.json({ success: true, message: 'India Post webhook link is active' });
  });

  // Legacy shared link protected by INDIAPOST_WEBHOOK_SECRET (all stores).
  app.post('/webhooks/indiapost', express.json({ limit: '2mb' }), asyncRoute(async (req, res) => {
    if (!allowedSource(req)) return res.sendStatus(403);
    const secret = req.get('X-Webhook-Secret') ?? req.query.secret;
    if (!indiaPost.webhookSecret || secret !== indiaPost.webhookSecret) return res.sendStatus(401);
    await receiveEvents(req, res);
  }));

  app.use(express.json({ limit: '1mb' }));

  // ---------- Embedded admin UI ----------
  app.get('/', (req, res) => {
    const shop = String(req.query.shop ?? '');
    const frameAncestors = isValidShopDomain(shop) ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com';
    res.set('Content-Security-Policy', `frame-ancestors ${frameAncestors};`);
    res.type('html').send(adminHtml.replace('%SHOPIFY_API_KEY%', shopify.apiKey));
  });

  // ---------- Admin API (App Bridge session token) ----------
  // Requests come from the embedded app (same origin); admin UI extensions may call cross-origin
  // with the session token as a bearer token.
  const cors = (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && ALLOWED_EXTENSION_ORIGINS.some((re) => re.test(origin))) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Expose-Headers': 'Content-Disposition',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };

  const authenticate = asyncRoute(async (req, res, next) => {
    const token = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '') || String(req.query.id_token ?? '');
    let shop;
    try {
      ({ shop } = verifySessionToken(token, { apiKey: shopify.apiKey, apiSecret: shopify.apiSecret }));
    } catch (err) {
      return res.status(401).set('X-Shopify-Retry-Invalid-Session-Request', '1').json({ error: err.message });
    }
    if (!db.getShop(shop)?.access_token) {
      const { access_token: accessToken, scope } = await exchangeToken({
        shop,
        sessionToken: token,
        apiKey: shopify.apiKey,
        apiSecret: shopify.apiSecret,
        fetchImpl: ctx.fetch,
      });
      db.saveShop(shop, accessToken, scope);
      logger.info(`[install] ${shop} installed`);
    }
    req.shop = shop;
    next();
  });

  const api = express.Router();
  api.use(cors, authenticate);

  api.get('/bootstrap', (req, res) => {
    const settings = ctx.getPublicSettings(req.shop);
    res.json({
      shop: req.shop,
      settings,
      products: PRODUCTS,
      statusLabels: STATUS_LABELS,
      trackingEnabled: ctx.hasTracking(req.shop),
      defaultIndiaPostUrl: ctx.config.indiaPost.baseUrl,
      webhookUrl: ctx.webhookUrl(req.shop),
      serverIp: ctx.config.serverIp,
      trackingPageUrl: `https://${req.shop}${shopify.proxyPath}`,
    });
  });

  api.get('/orders', asyncRoute(async (req, res) => {
    // ?ids=1,2 (numeric ids or gids) lists exactly those orders — used by the Shopify admin links.
    const ids = parseOrderIds(req.query.ids).map((gid) => `id:${gid.split('/').pop()}`);
    const filter = ids.length || req.query.filter === 'all' ? '' : 'fulfillment_status:unfulfilled status:open';
    const search = ids.length ? ids.join(' OR ') : String(req.query.q ?? '').trim();
    const query = [filter, search].filter(Boolean).join(' ');
    const orders = await ctx.adminFor(req.shop).recentOrders({ first: 50, query });
    const shipments = new Map(db.listShipmentsForOrders(req.shop, orders.map((o) => o.id)).map((s) => [s.order_id, s]));
    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        customer: o.shippingAddress?.name ?? o.customer?.name ?? '',
        city: o.shippingAddress?.city ?? '',
        pincode: o.shippingAddress?.zip ?? '',
        total: o.totalAmount,
        currency: o.currency,
        weight: o.totalWeightGrams,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        shipment: shipments.has(o.id) ? publicShipment(shipments.get(o.id)) : null,
      })),
    });
  }));

  // "Create order" form: prefilled values and warnings for one order, then save the tracking number.
  const orderIdFrom = (value) => {
    const [id] = parseOrderIds(value);
    if (!id) throw new ShipmentError('A valid order id is required');
    return id;
  };

  api.get('/order', asyncRoute(async (req, res) => {
    const draft = await orderDraft(ctx, req.shop, orderIdFrom(req.query.id));
    res.json({ ...draft, shipment: draft.shipment ? publicShipment(draft.shipment) : null });
  }));

  api.post('/order/validate', asyncRoute(async (req, res) => {
    const draft = await orderDraft(ctx, req.shop, orderIdFrom(req.body?.orderId), req.body?.overrides);
    res.json({ warnings: draft.warnings, articleType: draft.articleType });
  }));

  api.post('/order/save', asyncRoute(async (req, res) => {
    const { shipment, warnings } = await saveShipment(ctx, req.shop, orderIdFrom(req.body?.orderId), {
      trackingNumber: req.body?.trackingNumber,
      bookingDate: req.body?.bookingDate,
      overrides: req.body?.overrides,
    });
    res.json({ shipment: publicShipment(shipment), warnings });
  }));

  // Quick entry from the orders list: several orders, one tracking number each, default details.
  api.post('/orders/save', asyncRoute(async (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 100) : [];
    if (!entries.length) return res.status(400).json({ error: 'Enter at least one tracking number' });
    const results = [];
    for (const entry of entries) {
      try {
        const orderId = orderIdFrom(entry.orderId);
        const { shipment, warnings } = await saveShipment(ctx, req.shop, orderId, {
          trackingNumber: entry.trackingNumber,
          bookingDate: req.body?.bookingDate,
        });
        results.push({ orderId, ok: true, shipment: publicShipment(shipment), warnings });
      } catch (err) {
        if (!(err instanceof ShipmentError)) logger.error(err);
        results.push({ orderId: entry.orderId, ok: false, error: err.message });
      }
    }
    res.json({ results });
  }));

  api.get('/export', asyncRoute(async (req, res) => {
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : undefined);
    const { buffer, count } = await exportShipments(ctx, req.shop, {
      from: date(req.query.from),
      to: date(req.query.to),
      onlyNew: req.query.onlyNew === '1',
      ids: String(req.query.ids ?? '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 1000),
      markExported: req.query.mark !== '0',
    });
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="india-post-orders-${today}.xlsx"`)
      .set('X-Row-Count', String(count))
      .send(buffer);
  }));

  api.get('/shipments', (req, res) => {
    res.json({ shipments: db.listShipments(req.shop, { limit: 200 }).map(publicShipment) });
  });

  api.get('/shipments/:id', (req, res) => {
    const shipment = db.getShipment(req.shop, Number(req.params.id));
    if (!shipment) return res.status(404).json({ error: 'Not found' });
    res.json({ shipment: publicShipment(shipment), events: db.listEvents(shipment.id) });
  });

  // Fetch the latest India Post tracking now: the given shipments, or every one not yet delivered.
  api.post('/shipments/refresh', asyncRoute(async (req, res) => {
    if (!ctx.hasTracking(req.shop)) {
      throw new ShipmentError('Add your India Post API username and password in Settings to fetch tracking.');
    }
    const ids = (req.body?.shipmentIds ?? []).map(Number).filter(Boolean).slice(0, 2000);
    const shipments = ids.length ? db.listShipmentsByIds(req.shop, ids).filter((s) => s.booked_at) : db.listActiveShipments(req.shop);
    const stored = await refreshShipments(ctx, req.shop, shipments);
    res.json({ checked: shipments.length, newEvents: stored });
  }));

  api.get('/settings', (req, res) => res.json({ settings: ctx.getPublicSettings(req.shop) }));

  api.put('/settings', (req, res) => {
    const input = req.body?.settings ?? {};
    // The India Post login is sent to this server, so only India Post (CEPT) HTTPS hosts are accepted.
    const baseUrl = String(input.indiaPost?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (baseUrl && !isIndiaPostUrl(baseUrl)) {
      return res.status(400).json({ error: 'India Post API server must be an https://… address on cept.gov.in or indiapost.gov.in' });
    }
    if (input.indiaPost) input.indiaPost.baseUrl = baseUrl;
    res.json({ settings: ctx.saveSettings(req.shop, input) });
  });

  api.post('/settings/test', asyncRoute(async (req, res) => {
    const settings = ctx.getSettings(req.shop);
    if (!settings.indiaPost.username || !settings.indiaPost.password) {
      return res.json({ lastTest: ctx.recordConnectionTest(req.shop, false, 'Enter and save the India Post API username and password first.') });
    }
    try {
      await ctx.indiaPostFor(req.shop, settings).login();
      res.json({ lastTest: ctx.recordConnectionTest(req.shop, true, 'Connected to India Post') });
    } catch (err) {
      const reason = err instanceof IndiaPostError ? err.message : `Could not reach India Post: ${err.message}`;
      res.json({ lastTest: ctx.recordConnectionTest(req.shop, false, reason) });
    }
  }));

  api.post('/settings/webhook-link', (req, res) => {
    ctx.webhookToken(req.shop, { rotate: true });
    res.json({ webhookUrl: ctx.webhookUrl(req.shop) });
  });

  api.get('/pincode/:pin', asyncRoute(async (req, res) => {
    if (!/^\d{6}$/.test(req.params.pin)) return res.status(400).json({ error: 'Pincode must be 6 digits' });
    const offices = await ctx.indiaPostFor(req.shop).pincodeSearch(req.params.pin);
    res.json({ offices: filterOffices(offices) });
  }));

  app.use('/api', api);

  // ---------- Public tracking (storefront app proxy + standalone) ----------
  const trackLimiter = rateLimiter({ windowMs: 60_000, max: 30 });

  // `q` = tracking number, order number or mobile; `awb` is the older parameter used in tracking links.
  const trackingPage = async (shop, req) => {
    const query = String(req.query.q ?? req.query.awb ?? '').slice(0, 30);
    const mobile = String(req.query.mobile ?? '').slice(0, 14);
    const outcome = query ? await searchTracking(ctx, shop, { q: query, mobile }) : null;
    const requireMobile = Boolean(ctx.getSettings(shop).trackingPage?.requireMobileForOrder);
    return { query, mobile, outcome, requireMobile };
  };

  app.get(['/proxy', '/proxy/*path'], trackLimiter, asyncRoute(async (req, res) => {
    if (!verifyAppProxySignature(req.query, shopify.apiSecret)) return res.status(401).send('Invalid signature');
    const shop = String(req.query.shop ?? '');
    if (!db.getShop(shop)) return res.status(404).send('Store not found');
    const page = await trackingPage(shop, req);
    res
      .type('application/liquid')
      .set('Cache-Control', 'no-store')
      .send(renderTrackingContent({ ...page, formAction: shopify.proxyPath }));
  }));

  app.get('/track', trackLimiter, asyncRoute(async (req, res) => {
    const shop = String(req.query.shop ?? '');
    if (!isValidShopDomain(shop) || !db.getShop(shop)) return res.status(404).send('Store not found');
    const page = await trackingPage(shop, req);
    res.type('html').send(
      renderStandalonePage(renderTrackingContent({ ...page, formAction: '/track', hiddenFields: { shop }, standalone: true })),
    );
  }));

  // ---------- errors ----------
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const expected = err instanceof ShipmentError || err instanceof IndiaPostError;
    if (!expected) logger.error(err);
    res.status(expected ? 400 : 500).json({ error: err.message || 'Unexpected error' });
  });

  return app;
}

const ALLOWED_EXTENSION_ORIGINS = [/^https:\/\/extensions\.shopifycdn\.com$/, /^https:\/\/admin\.shopify\.com$/, /^https:\/\/[a-z0-9-]+\.myshopify\.com$/];

export function isIndiaPostUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(cept|indiapost)\.gov\.in$/.test(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Accepts gids, numeric ids, comma separated strings or arrays (ids[]=…) → order gids. */
export function parseOrderIds(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((v) => String(v).trim())
    .filter(Boolean);
  const gids = list
    .map((v) => (/^\d+$/.test(v) ? `gid://shopify/Order/${v}` : v))
    .filter((v) => /^gid:\/\/shopify\/Order\/\d+$/.test(v));
  return [...new Set(gids)].slice(0, 250);
}

function publicShipment(s) {
  return {
    id: s.id,
    orderId: s.order_id,
    orderName: s.order_name,
    barcode: s.barcode,
    articleType: s.article_type,
    status: s.status,
    warnings: s.errors,
    bookedAt: s.booked_at,
    exportedAt: s.exported_at,
    lastCheckedAt: s.last_polled_at,
    receiver: s.article
      ? { name: s.article.receiver_name, city: s.article.receiver_city, pincode: s.article.receiver_pincode }
      : null,
    fulfilled: s.fulfillment_ids.length > 0,
    lastEvent: s.last_event,
    lastEventAt: s.last_event_at,
  };
}

function filterOffices(offices) {
  if (!Array.isArray(offices)) return [];
  // Offices usable for pickup / drop-off: delivery offices that are not branch post offices.
  return offices
    .filter((o) => o.delivery_office_flag && o.office_type_code !== 'BPO')
    .map((o) => ({ id: o.office_id, name: o.office_name, type: o.office_type_code, city: o.city_name, state: o.state_name }));
}

async function handleShopifyWebhook(ctx, shop, topic, payload) {
  const { db, logger } = ctx;
  switch (topic) {
    case 'app/uninstalled':
      db.markUninstalled(shop);
      return;
    case 'customers/data_request':
      // Data held per customer: shipment booking payloads for their orders (address, phone). Merchant is
      // notified by Shopify; nothing is sent automatically.
      logger.info(`[gdpr] data request for ${shop} customer ${payload.customer?.id}`);
      return;
    case 'customers/redact': {
      for (const orderId of payload.orders_to_redact ?? []) {
        const shipment = db.getShipmentByOrder(shop, `gid://shopify/Order/${orderId}`);
        if (shipment) db.updateShipment(shipment.id, { article: null, customer_id: null });
      }
      return;
    }
    case 'shop/redact':
      db.deleteShopData(shop);
      return;
    default:
      logger.info(`[webhook] ignored ${topic} for ${shop}`);
  }
}

// ---------- boot ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of ['apiKey', 'apiSecret']) {
    if (!config.shopify[key]) {
      console.error(`Missing SHOPIFY_${key === 'apiKey' ? 'API_KEY' : 'API_SECRET'} environment variable`);
      process.exit(1);
    }
  }
  const ctx = createContext({ db: openDatabase(config.databasePath), config });
  createApp(ctx).listen(config.port, () => console.log(`India Post Shopify app listening on :${config.port}`));

  if (config.pollIntervalMinutes > 0) {
    const poll = () => pollAllShops(ctx).catch((err) => console.error('[poll]', err));
    setTimeout(poll, 30_000);
    setInterval(poll, config.pollIntervalMinutes * 60_000);
  }
}
