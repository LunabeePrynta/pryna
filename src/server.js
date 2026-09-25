import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { IndiaPostError } from './indiapost/client.js';
import { PRODUCTS } from './indiapost/mapper.js';
import { STATUS_LABELS } from './indiapost/events.js';
import { parseSeriesBoundary } from './indiapost/barcode.js';
import {
  exchangeToken,
  isValidShopDomain,
  verifyAppProxySignature,
  verifySessionToken,
  verifyWebhookHmac,
} from './shopify/auth.js';
import { createContext } from './services/context.js';
import { BookingError, labelsPdf, pushOrders } from './services/booking.js';
import { handleIndiaPostEvent, lookupTracking, pollAllShops, refreshShipments } from './services/tracking.js';
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
  app.post('/webhooks/indiapost', express.json({ limit: '2mb' }), asyncRoute(async (req, res) => {
    if (indiaPost.webhookIps.length && !indiaPost.webhookIps.includes(req.ip)) return res.sendStatus(403);
    const secret = req.get('X-Webhook-Secret') ?? req.query.secret;
    if (!indiaPost.webhookSecret || secret !== indiaPost.webhookSecret) return res.sendStatus(401);
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let stored = 0;
    for (const event of events) if ((await handleIndiaPostEvent(ctx, event)).stored) stored += 1;
    res.json({ success: true, received: events.length, stored });
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
  const api = express.Router();
  api.use(asyncRoute(async (req, res, next) => {
    const token = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
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
  }));

  api.get('/bootstrap', (req, res) => {
    const settings = ctx.getPublicSettings(req.shop);
    res.json({
      shop: req.shop,
      settings,
      products: PRODUCTS,
      statusLabels: STATUS_LABELS,
      series: seriesUsage(ctx, req.shop, settings),
      webhookUrl: `${ctx.config.appUrl}/webhooks/indiapost`,
      trackingPageUrl: `https://${req.shop}${shopify.proxyPath}`,
    });
  });

  api.get('/orders', asyncRoute(async (req, res) => {
    const filter = req.query.filter === 'all' ? '' : 'fulfillment_status:unfulfilled status:open';
    const search = String(req.query.q ?? '').trim();
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

  api.post('/orders/push', asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.orderIds) ? req.body.orderIds.filter((id) => /^gid:\/\/shopify\/Order\/\d+$/.test(id)) : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one order' });
    if (ids.length > 250) return res.status(400).json({ error: 'Push at most 250 orders at a time' });
    res.json({ results: await pushOrders(ctx, req.shop, ids) });
  }));

  api.get('/shipments', (req, res) => {
    res.json({ shipments: db.listShipments(req.shop, { limit: 200 }).map(publicShipment) });
  });

  api.get('/shipments/:id', (req, res) => {
    const shipment = db.getShipment(req.shop, Number(req.params.id));
    if (!shipment) return res.status(404).json({ error: 'Not found' });
    res.json({ shipment: publicShipment(shipment), events: db.listEvents(shipment.id) });
  });

  api.post('/shipments/refresh', asyncRoute(async (req, res) => {
    const ids = (req.body?.shipmentIds ?? []).map(Number).filter(Boolean);
    const shipments = ids.length ? db.listShipmentsByIds(req.shop, ids).filter((s) => s.booked_at) : db.listActiveShipments(req.shop);
    const stored = await refreshShipments(ctx, req.shop, shipments);
    res.json({ checked: shipments.length, newEvents: stored });
  }));

  api.post('/labels', asyncRoute(async (req, res) => {
    const ids = (req.body?.shipmentIds ?? []).map(Number).filter(Boolean);
    const pdf = await labelsPdf(ctx, req.shop, ids);
    res.type('application/pdf').set('Content-Disposition', 'inline; filename="india-post-labels.pdf"').send(pdf);
  }));

  api.get('/settings', (req, res) => res.json({ settings: ctx.getPublicSettings(req.shop) }));

  api.put('/settings', (req, res) => {
    const input = req.body?.settings ?? {};
    for (const key of ['seriesStart', 'seriesEnd']) {
      const value = input.barcode?.[key];
      if (value) {
        try {
          parseSeriesBoundary(value);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }
    }
    res.json({ settings: ctx.saveSettings(req.shop, input) });
  });

  api.post('/settings/test', asyncRoute(async (req, res) => {
    const settings = ctx.getSettings(req.shop);
    const client = ctx.indiaPostFor(req.shop, settings);
    await client.login();
    const pincode = settings.sender.pincode;
    const offices = pincode ? await client.pincodeSearch(pincode).catch(() => null) : null;
    res.json({ ok: true, message: 'Connected to India Post', offices: filterOffices(offices) });
  }));

  api.get('/pincode/:pin', asyncRoute(async (req, res) => {
    if (!/^\d{6}$/.test(req.params.pin)) return res.status(400).json({ error: 'Pincode must be 6 digits' });
    const offices = await ctx.indiaPostFor(req.shop).pincodeSearch(req.params.pin);
    res.json({ offices: filterOffices(offices) });
  }));

  app.use('/api', api);

  // ---------- Public tracking (storefront app proxy + standalone) ----------
  const trackLimiter = rateLimiter({ windowMs: 60_000, max: 30 });

  app.get(['/proxy', '/proxy/*path'], trackLimiter, asyncRoute(async (req, res) => {
    if (!verifyAppProxySignature(req.query, shopify.apiSecret)) return res.status(401).send('Invalid signature');
    const shop = String(req.query.shop ?? '');
    if (!db.getShop(shop)) return res.status(404).send('Store not found');
    const query = String(req.query.awb ?? '').slice(0, 20);
    const result = query ? await lookupTracking(ctx, shop, query) : null;
    res
      .type('application/liquid')
      .set('Cache-Control', 'no-store')
      .send(renderTrackingContent({ query, result, formAction: shopify.proxyPath }));
  }));

  app.get('/track', trackLimiter, asyncRoute(async (req, res) => {
    const shop = String(req.query.shop ?? '');
    if (!isValidShopDomain(shop) || !db.getShop(shop)) return res.status(404).send('Store not found');
    const query = String(req.query.awb ?? '').slice(0, 20);
    const result = query ? await lookupTracking(ctx, shop, query) : null;
    res.type('html').send(
      renderStandalonePage(renderTrackingContent({ query, result, formAction: '/track', hiddenFields: { shop }, standalone: true })),
    );
  }));

  // ---------- errors ----------
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const expected = err instanceof BookingError || err instanceof IndiaPostError;
    if (!expected) logger.error(err);
    res.status(expected ? 400 : 500).json({ error: err.message || 'Unexpected error' });
  });

  return app;
}

function publicShipment(s) {
  return {
    id: s.id,
    orderId: s.order_id,
    orderName: s.order_name,
    barcode: s.barcode,
    articleType: s.article_type,
    status: s.status,
    errors: s.errors,
    tariff: s.tariff,
    bookedAt: s.booked_at,
    hasLabel: Boolean(s.label_path),
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

function seriesUsage(ctx, shop, settings) {
  try {
    const start = parseSeriesBoundary(settings.barcode.seriesStart);
    const end = parseSeriesBoundary(settings.barcode.seriesEnd);
    const next = Math.max(ctx.db.peekSerial(shop, start.prefix) ?? start.serial, start.serial);
    return { total: end.serial - start.serial + 1, remaining: Math.max(0, end.serial - next + 1) };
  } catch {
    return null;
  }
}

const AUTO_PUSH_STATUSES = new Set(['paid', 'partially_paid', 'authorized']);

async function handleShopifyWebhook(ctx, shop, topic, payload) {
  const { db, logger } = ctx;
  switch (topic) {
    case 'orders/create': {
      if (!db.getShop(shop)) return;
      const settings = ctx.getSettings(shop);
      if (!settings.automation.autoPush) return;
      if (payload.shipping_address?.country_code && payload.shipping_address.country_code !== 'IN') return;
      const cod = (payload.payment_gateway_names ?? []).some((g) => /cash on delivery|\bcod\b/i.test(g));
      if (!cod && !AUTO_PUSH_STATUSES.has(payload.financial_status)) return;
      const [result] = await pushOrders(ctx, shop, [payload.admin_graphql_api_id]);
      logger.info(`[auto-push] ${shop} ${payload.name}: ${result?.status} ${result?.barcode ?? ''} ${(result?.errors ?? []).join('; ')}`);
      return;
    }
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
