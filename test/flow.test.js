// End-to-end: embedded admin → push order → India Post booking + label → Shopify fulfillment,
// then India Post webhook + storefront tracking page. Shopify and India Post are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createContext } from '../src/services/context.js';
import { createApp } from '../src/server.js';
import { sampleOrder, sessionToken } from './fixtures.js';

const SHOP = 'demo.myshopify.com';
const IP_BASE = 'https://indiapost.test/beextcustomer';

function orderNode(order) {
  const a = order.shippingAddress;
  return {
    id: order.id,
    name: order.name,
    createdAt: '2026-09-25T05:00:00Z',
    email: order.email,
    phone: null,
    displayFinancialStatus: order.financialStatus,
    displayFulfillmentStatus: 'UNFULFILLED',
    paymentGatewayNames: order.gateways,
    totalWeight: String(order.totalWeightGrams),
    totalPriceSet: { shopMoney: { amount: String(order.totalAmount), currencyCode: 'INR' } },
    totalOutstandingSet: { shopMoney: { amount: '0.0' } },
    shippingAddress: { ...a, countryCodeV2: a.countryCode },
    customer: { id: order.customer.id, displayName: a.name, defaultPhoneNumber: null },
    fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/9', status: 'OPEN', supportedActions: [{ action: 'CREATE_FULFILLMENT' }] }] },
  };
}

function createFakes() {
  const calls = { graphql: [], booking: [], labels: [], tracking: [], logins: 0 };
  const order = sampleOrder();
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === `https://${SHOP}/admin/oauth/access_token`) return json({ access_token: 'shpat_test', scope: 'read_orders' });
    if (url.startsWith(`https://${SHOP}/admin/api/`)) {
      calls.graphql.push(body);
      const q = body.query;
      if (/query RecentOrders/.test(q)) return json({ data: { orders: { nodes: [orderNode(order)] } } });
      if (/query OrderForShipping/.test(q)) return json({ data: { order: orderNode(order) } });
      if (/mutation CreateFulfillment\(/.test(q)) return json({ data: { fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/77', status: 'SUCCESS' }, userErrors: [] } } });
      if (/mutation CreateFulfillmentEvent/.test(q)) return json({ data: { fulfillmentEventCreate: { fulfillmentEvent: { id: 'e', status: body.variables.event.status }, userErrors: [] } } });
      if (/mutation SetMetafields/.test(q)) return json({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      throw new Error(`Unexpected GraphQL ${q}`);
    }
    if (url === `${IP_BASE}/v1/access/login`) {
      calls.logins += 1;
      return json({ success: true, message: '', data: { access_token: 'ip-token', expires_in: 900 } });
    }
    assert.equal(init.headers?.Authorization, 'Bearer ip-token');
    if (url === `${IP_BASE}/process-articles/3000064781`) {
      calls.booking.push(body);
      return json({
        success: true,
        mail_booking_dom_id: 386807208610000,
        valid_articles: body.articles.map((a, index) => ({ barcode_no: a.barcode_no, index, calculated_tariff: 72 })),
        error_articles: [],
      });
    }
    if (url === `${IP_BASE}/v1/label/create/domestic`) {
      calls.labels.push(body);
      return new Response(Buffer.from('%PDF-1.4 fake label'), { headers: { 'content-type': 'application/pdf' } });
    }
    if (url === `${IP_BASE}/v1/tracking/bulk`) {
      calls.tracking.push(body);
      return json({
        success: true,
        data: body.bulk.map((awb) => ({
          booking_details: { article_number: awb, booked_at: 'Chennai GPO', origin_pincode: '600001', destination_pincode: '560038' },
          tracking_details: [
            { date: '2026-09-26T09:00:00Z', time: '09:00:00', office: 'Indiranagar SO', officeid: '21560001', event: 'Taken out for delivery', remarks: '', rts: false },
            { date: '2026-09-25T18:00:00Z', time: '18:00:00', office: 'Chennai GPO', officeid: '29360001', event: 'Item Booked', remarks: '', rts: false },
          ],
          del_status: { del_status: 'not delivered' },
        })),
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetchImpl, calls, order };
}

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipship-'));
  const config = {
    appUrl: 'https://app.test',
    trustProxy: 'loopback',
    shopify: { apiKey: 'key123', apiSecret: 'secret456', apiVersion: '2026-07', proxyPath: '/apps/track' },
    indiaPost: { baseUrl: IP_BASE, webhookSecret: 'hook-secret', webhookIps: [] },
    encryptionKey: '',
    labelDir: path.join(tmp, 'labels'),
  };
  const fakes = createFakes();
  const logger = { info() {}, error() {} };
  const ctx = createContext({ db: openDatabase(':memory:'), config, fetchImpl: fakes.fetchImpl, logger });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, { method = 'GET', body } = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${sessionToken(SHOP)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { ctx, server, base, call, ...fakes };
}

test('push order → book → label → fulfil → track', async (t) => {
  const { ctx, server, base, call, calls, order } = await setup();
  t.after(() => server.close());

  // Unauthenticated API calls are rejected.
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);

  // First authenticated call installs the shop via token exchange.
  const boot = await (await call('/api/bootstrap')).json();
  assert.equal(boot.shop, SHOP);
  assert.equal(ctx.db.getShop(SHOP).access_token, 'shpat_test');

  // Configure the shop.
  const saveRes = await call('/api/settings', {
    method: 'PUT',
    body: {
      settings: {
        indiaPost: { username: '9999999999', password: 'Dop@1234', bulkCustomerId: '3000064781', contracts: { SPEED_POST: '41585456' } },
        barcode: { seriesStart: 'ET21433001XIN', seriesEnd: 'ET21434000XIN' },
        officeId: '21260024',
        sender: { name: 'Luna Bee Store', address1: '12 MG Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', mobile: '9876543210' },
        label: { bookingOfficeName: 'Chennai GPO', bookingOfficePin: '600001' },
      },
    },
  });
  const saved = (await saveRes.json()).settings;
  assert.equal(saved.indiaPost.password, '••••••••', 'password is never sent back');
  assert.match(ctx.db.getSettingsRaw(SHOP).indiaPost.password, /^enc:/, 'password encrypted at rest');

  // Orders list.
  const { orders } = await (await call('/api/orders')).json();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].shipment, null);

  // Push to India Post.
  const { results } = await (await call('/api/orders/push', { method: 'POST', body: { orderIds: [order.id] } })).json();
  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.status, 'BOOKED', JSON.stringify(r));
  assert.match(r.barcode, /^ET21433001\dIN$/);
  assert.deepEqual(r.warnings, []);
  assert.equal(calls.booking[0].articles[0].barcode_no, r.barcode);
  assert.equal(calls.labels[0][0].barcode_no, r.barcode);

  const fulfillment = calls.graphql.find((g) => /mutation CreateFulfillment\(/.test(g.query)).variables.fulfillment;
  assert.equal(fulfillment.trackingInfo.number, r.barcode);
  assert.equal(fulfillment.trackingInfo.company, 'India Post');
  assert.equal(fulfillment.trackingInfo.url, `https://${SHOP}/apps/track?awb=${r.barcode}`);
  const metafields = calls.graphql.find((g) => /SetMetafields/.test(g.query)).variables.metafields;
  assert.deepEqual(metafields.map((m) => [m.ownerId, m.key]), [
    [order.id, 'tracking'],
    [order.customer.id, 'latest_shipment'],
  ]);

  // Pushing again is a no-op and does not consume a new article number.
  const again = (await (await call('/api/orders/push', { method: 'POST', body: { orderIds: [order.id] } })).json()).results[0];
  assert.equal(again.skipped, true);
  assert.equal(calls.booking.length, 1);

  // Label download serves the stored PDF.
  const labelRes = await call('/api/labels', { method: 'POST', body: { shipmentIds: [r.shipmentId] } });
  assert.equal(labelRes.headers.get('content-type'), 'application/pdf');
  assert.match(await labelRes.text(), /^%PDF/);
  assert.equal(calls.labels.length, 1);

  // India Post webhook: wrong secret rejected, valid event updates Shopify.
  const event = {
    article_number: r.barcode,
    event_code: 'BAG_DISPATCH',
    event_description: 'Bag Dispatch',
    event_date: '2026-09-25',
    event_time: '21:00:00',
    event_office_name: 'Chennai NSH',
    event_office_facility_id: '29440001',
  };
  const denied = await fetch(`${base}/webhooks/indiapost?secret=nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal(denied.status, 401);
  const hook = await (await fetch(`${base}/webhooks/indiapost?secret=hook-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) })).json();
  assert.deepEqual(hook, { success: true, received: 1, stored: 1 });
  let shipment = ctx.db.getShipment(SHOP, r.shipmentId);
  assert.equal(shipment.status, 'IN_TRANSIT');
  const pushedEvents = () => calls.graphql.filter((g) => /CreateFulfillmentEvent/.test(g.query)).map((g) => g.variables.event.status);
  assert.deepEqual(pushedEvents(), ['IN_TRANSIT']);

  // Storefront tracking page (app proxy) — signature required, then live lookup.
  const query = { shop: SHOP, path_prefix: '/apps/track', timestamp: String(Math.floor(Date.now() / 1000)), awb: r.barcode.toLowerCase() };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join('');
  const signature = crypto.createHmac('sha256', 'secret456').update(message).digest('hex');
  assert.equal((await fetch(`${base}/proxy?${new URLSearchParams(query)}`)).status, 401);
  const page = await fetch(`${base}/proxy?${new URLSearchParams({ ...query, signature })}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /application\/liquid/);
  const html = await page.text();
  assert.match(html, /Out for delivery/);
  assert.match(html, /Taken out for delivery/);
  assert.match(html, /Bag Dispatch/);

  // Tracking API events were stored and forwarded: the older "Item Booked" is not pushed after IN_TRANSIT.
  shipment = ctx.db.getShipment(SHOP, r.shipmentId);
  assert.equal(shipment.status, 'OUT_FOR_DELIVERY');
  assert.deepEqual(pushedEvents(), ['IN_TRANSIT', 'OUT_FOR_DELIVERY']);
  assert.equal(ctx.db.listEvents(shipment.id).length, 3);

  // Invalid article numbers get a friendly error without calling India Post.
  const trackingCalls = calls.tracking.length;
  const bad = await (await fetch(`${base}/track?shop=${SHOP}&awb=HELLO`)).text();
  assert.match(bad, /valid 13 character/);
  assert.equal(calls.tracking.length, trackingCalls);
});

test('booking errors are reported per order and can be retried with the same AWB', async (t) => {
  const { ctx, server, call, order } = await setup();
  t.after(() => server.close());
  await call('/api/bootstrap');
  await call('/api/settings', {
    method: 'PUT',
    body: { settings: { indiaPost: { username: 'u', password: 'p', bulkCustomerId: '3000064781', contracts: {} }, barcode: { seriesStart: 'ET21433001XIN', seriesEnd: 'ET21434000XIN' } } },
  });
  const first = (await (await call('/api/orders/push', { method: 'POST', body: { orderIds: [order.id] } })).json()).results[0];
  assert.equal(first.status, 'ERROR');
  assert.ok(first.errors.some((e) => e.includes('contract id')));

  await call('/api/settings', {
    method: 'PUT',
    body: {
      settings: {
        indiaPost: { username: 'u', password: '••••••••', bulkCustomerId: '3000064781', contracts: { SPEED_POST: '41585456' } },
        officeId: '21260024',
        sender: { name: 'Luna Bee Store', address1: '12 MG Road', city: 'Chennai', pincode: '600001', mobile: '9876543210' },
      },
    },
  });
  assert.equal(ctx.getSettings(SHOP).indiaPost.password, 'p', 'masked password keeps the stored one');
  const retry = (await (await call('/api/orders/push', { method: 'POST', body: { orderIds: [order.id] } })).json()).results[0];
  assert.equal(retry.status, 'BOOKED', JSON.stringify(retry));
  assert.equal(retry.barcode, first.barcode);
});
