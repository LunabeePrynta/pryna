// End-to-end: embedded admin → enter India Post tracking number → Shopify fulfilment,
// Excel export, tracking page and India Post webhook. Shopify and India Post are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { openDatabase } from '../src/db.js';
import { buildBarcode } from '../src/indiapost/barcode.js';
import { createContext } from '../src/services/context.js';
import { createApp } from '../src/server.js';
import { sampleOrder, sessionToken } from './fixtures.js';

const SHOP = 'demo.myshopify.com';
const IP_BASE = 'https://indiapost.test/beextcustomer';
const AWB1 = buildBarcode('EB', 12345678);
const AWB2 = buildBarcode('EB', 12345679);
const AWB3 = buildBarcode('EB', 12345680);

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
    totalOutstandingSet: { shopMoney: { amount: String(order.outstandingAmount) } },
    shippingAddress: { ...a, countryCodeV2: a.countryCode },
    customer: { id: order.customer.id, displayName: a.name, defaultPhoneNumber: null },
    fulfillmentOrders: {
      nodes: [{ id: `gid://shopify/FulfillmentOrder/${order.id.split('/').pop()}`, status: 'OPEN', supportedActions: [{ action: 'CREATE_FULFILLMENT' }] }],
    },
  };
}

function createFakes() {
  const calls = { graphql: [], tracking: [] };
  // What the fake India Post tracking API returns for every article (newest first). Tests can change it.
  const tracking = {
    events: [
      { date: '2026-09-26T09:00:00Z', time: '09:00:00', office: 'Indiranagar SO', officeid: '21560001', event: 'Taken out for delivery', remarks: '', rts: false },
      { date: '2026-09-25T18:00:00Z', time: '18:00:00', office: 'Chennai GPO', officeid: '29360001', event: 'Item Booked', remarks: '', rts: false },
    ],
    delivered: false,
  };
  const orders = new Map(
    [
      sampleOrder(),
      sampleOrder({
        id: 'gid://shopify/Order/1002',
        name: '#1002',
        financialStatus: 'PENDING',
        gateways: ['Cash on Delivery (COD)'],
        outstandingAmount: 899,
        totalAmount: 899,
        totalWeightGrams: 300,
      }),
      sampleOrder({ id: 'gid://shopify/Order/1003', name: '#1003' }),
    ].map((o) => [o.id, o]),
  );
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === `https://${SHOP}/admin/oauth/access_token`) return json({ access_token: 'shpat_test', scope: 'read_orders' });
    if (url.startsWith(`https://${SHOP}/admin/api/`)) {
      calls.graphql.push(body);
      const q = body.query;
      if (/query RecentOrders/.test(q)) return json({ data: { orders: { nodes: [...orders.values()].map(orderNode) } } });
      if (/query OrderForShipping/.test(q)) return json({ data: { order: orders.has(body.variables.id) ? orderNode(orders.get(body.variables.id)) : null } });
      if (/mutation CreateFulfillment\(/.test(q)) {
        const foId = body.variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId;
        return json({ data: { fulfillmentCreate: { fulfillment: { id: `gid://shopify/Fulfillment/${foId.split('/').pop()}`, status: 'SUCCESS' }, userErrors: [] } } });
      }
      if (/mutation UpdateTracking/.test(q)) return json({ data: { fulfillmentTrackingInfoUpdate: { fulfillment: { id: body.variables.fulfillmentId }, userErrors: [] } } });
      if (/mutation CreateFulfillmentEvent/.test(q)) return json({ data: { fulfillmentEventCreate: { fulfillmentEvent: { id: 'e', status: body.variables.event.status }, userErrors: [] } } });
      if (/mutation SetMetafields/.test(q)) return json({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      throw new Error(`Unexpected GraphQL ${q}`);
    }
    if (url === `${IP_BASE}/v1/access/login`) return json({ success: true, message: '', data: { access_token: 'ip-token', expires_in: 900 } });
    if (url === `${IP_BASE}/v1/tracking/bulk`) {
      calls.tracking.push(body);
      return json({
        success: true,
        data: body.bulk.map((awb) => ({
          booking_details: { article_number: awb, booked_at: 'Chennai GPO', origin_pincode: '600001', destination_pincode: '560038' },
          tracking_details: tracking.events,
          del_status: { del_status: tracking.delivered ? 'delivered' : 'not delivered' },
        })),
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetchImpl, calls, orders, tracking };
}

async function setup() {
  const config = {
    appUrl: 'https://app.test',
    trustProxy: 'loopback',
    shopify: { apiKey: 'key123', apiSecret: 'secret456', apiVersion: '2026-07', proxyPath: '/apps/track' },
    indiaPost: { baseUrl: IP_BASE, webhookSecret: 'hook-secret', webhookIps: [] },
    encryptionKey: '',
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
  const callJson = async (p, opts) => (await call(p, opts)).json();
  await call('/api/bootstrap'); // installs the shop via token exchange
  return { ctx, server, base, call, callJson, ...fakes };
}

const SETTINGS = {
  product: 'SPEED_POST',
  indiaPost: { bulkCustomerId: '3000064781', contracts: { SPEED_POST: '41585456' } },
  officeId: '21260024',
  sender: { name: 'Luna Bee Store', address1: '12 MG Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', mobile: '9876543210' },
};

const fulfilCalls = (calls) => calls.graphql.filter((g) => /mutation CreateFulfillment\(/.test(g.query)).map((g) => g.variables.fulfillment);

test('create order: save tracking number, fulfil in Shopify, edit, reject duplicates and typos', async (t) => {
  const { ctx, server, call, callJson, calls, orders } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: SETTINGS } });
  const order = orders.get('gid://shopify/Order/1001');

  assert.equal((await callJson('/api/bootstrap')).trackingEnabled, false);

  // Prefilled form.
  const draft = await callJson(`/api/order?id=${order.id.split('/').pop()}`);
  assert.equal(draft.order.name, '#1001');
  assert.equal(draft.order.canFulfill, true);
  assert.equal(draft.form.receiver.phone, '9876501234');
  assert.equal(draft.form.weightGrams, 800);
  assert.deepEqual(draft.warnings, []);
  assert.equal(draft.shipment, null);

  // Invalid tracking numbers are rejected before touching Shopify.
  const typo = AWB1.slice(0, 10) + ((Number(AWB1[10]) + 1) % 10) + 'IN';
  for (const [bad, message] of [['', /Enter the India Post tracking number/], ['12345', /not a valid/], [typo, /check digit/]]) {
    const res = await call('/api/order/save', { method: 'POST', body: { orderId: order.id, trackingNumber: bad } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, message);
  }
  assert.equal(fulfilCalls(calls).length, 0);

  // Save with edits and a booking date.
  const saved = await callJson('/api/order/save', {
    method: 'POST',
    body: {
      orderId: order.id,
      trackingNumber: AWB1.toLowerCase(),
      bookingDate: '2026-09-25',
      overrides: { weightGrams: '1200', dimensions: { length: '30', breadth: '20', height: '10' }, receiver: { address2: 'Near Metro' } },
    },
  });
  assert.equal(saved.shipment.barcode, AWB1);
  assert.equal(saved.shipment.status, 'BOOKED');
  assert.equal(saved.shipment.fulfilled, true);
  assert.equal(saved.shipment.bookedAt, '2026-09-25T06:30:00.000Z');
  assert.deepEqual(saved.warnings, []);

  const [fulfilment] = fulfilCalls(calls);
  assert.equal(fulfilment.trackingInfo.number, AWB1);
  assert.equal(fulfilment.trackingInfo.company, 'India Post');
  assert.equal(fulfilment.trackingInfo.url, undefined, 'no live tracking → Shopify builds the India Post link');
  assert.equal(fulfilment.notifyCustomer, true);
  const stored = ctx.db.getShipmentByOrder(SHOP, order.id);
  assert.equal(stored.article.physical_weight, 1200);
  assert.match(stored.article.receiver_add_line_1 + stored.article.receiver_add_line_2, /Near Metro/);

  // The same number cannot be used on another order.
  const dup = await call('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1003', trackingNumber: AWB1 } });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /already used on order #1001/);

  // Correcting the number updates the existing fulfilment instead of creating another.
  const edited = await callJson('/api/order/save', { method: 'POST', body: { orderId: order.id, trackingNumber: AWB2, bookingDate: '2026-09-25' } });
  assert.equal(edited.shipment.barcode, AWB2);
  assert.equal(fulfilCalls(calls).length, 1);
  const update = calls.graphql.find((g) => /UpdateTracking/.test(g.query)).variables;
  assert.equal(update.fulfillmentId, 'gid://shopify/Fulfillment/1001');
  assert.equal(update.trackingInfoInput.number, AWB2);

  // Re-opening shows the saved shipment.
  const reopened = await callJson(`/api/order?id=${encodeURIComponent(order.id)}`);
  assert.equal(reopened.shipment.barcode, AWB2);

  // Orders list shows it.
  const { orders: listed } = await callJson('/api/orders');
  assert.equal(listed.find((o) => o.id === order.id).shipment.barcode, AWB2);
});

test('quick save several orders, then download the Excel sheet', async (t) => {
  const { server, call, callJson, calls } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: SETTINGS } });

  const { results } = await callJson('/api/orders/save', {
    method: 'POST',
    body: {
      bookingDate: '2026-09-26',
      entries: [
        { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB1 },
        { orderId: 'gid://shopify/Order/1002', trackingNumber: AWB2 },
        { orderId: 'gid://shopify/Order/1003', trackingNumber: 'BAD' },
      ],
    },
  });
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
  assert.match(results[2].error, /not a valid/);
  assert.equal(fulfilCalls(calls).length, 2);

  // Excel with both saved orders.
  const res = await call('/api/export?from=2026-09-26&to=2026-09-26&format=report');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="india-post-orders-\d{4}-\d{2}-\d{2}\.xlsx"/);
  assert.equal(res.headers.get('x-row-count'), '2');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = workbook.getWorksheet('Orders');
  const header = sheet.getRow(1).values.slice(1);
  assert.deepEqual(header.slice(0, 4), ['Booking date', 'Order', 'Tracking number', 'Status']);
  const row = (n) => Object.fromEntries(header.map((h, i) => [h, sheet.getRow(n).getCell(i + 1).value]));
  assert.equal(sheet.rowCount, 3);
  assert.equal(row(2)['Booking date'], '26-09-2026');
  assert.equal(row(2).Order, '#1001');
  assert.equal(row(2)['Tracking number'], AWB1);
  assert.equal(row(2).Pincode, '560038');
  assert.equal(row(3).Order, '#1002');
  assert.equal(row(3)['COD amount'], undefined, 'no COD column: all orders are prepaid');
  assert.equal(row(3).Product, 'Speed Post (document)');

  const upload = workbook.getWorksheet('India Post upload');
  const uploadHeader = upload.getRow(1).values.slice(1);
  assert.equal(uploadHeader[0], 'bulk_customer_id');
  assert.equal(upload.getRow(2).getCell(uploadHeader.indexOf('barcode_no') + 1).value, AWB1);
  assert.equal(upload.getRow(2).getCell(uploadHeader.indexOf('contract_id') + 1).value, '41585456');

  // Only the ticked orders go into the file, whatever the date filter says.
  const { shipments: all } = await callJson('/api/shipments');
  const second = all.find((s) => s.orderName === '#1002');
  const ticked = await call(`/api/export?ids=${second.id}&from=2030-01-01&mark=0&format=report`);
  assert.equal(ticked.headers.get('x-row-count'), '1');
  const tickedBook = new ExcelJS.Workbook();
  await tickedBook.xlsx.load(Buffer.from(await ticked.arrayBuffer()));
  assert.equal(tickedBook.getWorksheet('Orders').rowCount, 2);
  assert.equal(tickedBook.getWorksheet('Orders').getRow(2).getCell(2).value, '#1002');

  // Downloaded orders are marked; "only new" then returns none.
  const { shipments } = await callJson('/api/shipments');
  assert.ok(shipments.every((s) => s.exportedAt));
  assert.equal((await call('/api/export?onlyNew=1')).headers.get('x-row-count'), '0');

  // Date filter excludes other days.
  assert.equal((await call('/api/export?from=2026-09-27')).headers.get('x-row-count'), '0');
});

test('with India Post tracking configured: fetch on save, update tracking, webhook, storefront page', async (t) => {
  const { ctx, server, base, call, callJson, calls, tracking } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, indiaPost: { ...SETTINGS.indiaPost, username: 'u', password: 'p' } } } });
  assert.equal((await callJson('/api/bootstrap')).trackingEnabled, true);
  const pushed = () => calls.graphql.filter((g) => /CreateFulfillmentEvent/.test(g.query)).map((g) => g.variables.event.status);

  // Saving checks India Post straight away; nothing scanned yet.
  tracking.events = [];
  const { shipment } = await callJson('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB3 } });
  assert.equal(fulfilCalls(calls)[0].trackingInfo.url, `https://${SHOP}/apps/track?awb=${AWB3}`);
  assert.deepEqual(calls.tracking.at(-1), { bulk: [AWB3] });
  assert.equal(shipment.status, 'BOOKED');
  assert.ok(shipment.lastCheckedAt, 'marked as checked even without events');
  assert.deepEqual(pushed(), []);

  // India Post webhook: wrong secret rejected, valid event updates the order.
  const event = {
    article_number: AWB3,
    event_code: 'BAG_DISPATCH',
    event_description: 'Bag Dispatch',
    event_date: '2026-09-25',
    event_time: '21:00:00',
    event_office_name: 'Chennai NSH',
    event_office_facility_id: '29440001',
  };
  const post = (qs) => fetch(`${base}/webhooks/indiapost${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal((await post('?secret=nope')).status, 401);
  assert.deepEqual(await (await post('?secret=hook-secret')).json(), { success: true, received: 1, stored: 1 });
  assert.equal(ctx.db.getShipment(SHOP, shipment.id).status, 'IN_TRANSIT');
  assert.deepEqual(pushed(), ['IN_TRANSIT']);

  // "Update tracking" pulls the latest events; the older "Item Booked" is stored but not re-announced.
  tracking.events = [
    { date: '2026-09-26T09:00:00Z', time: '09:00:00', office: 'Indiranagar SO', officeid: '21560001', event: 'Taken out for delivery', remarks: '', rts: false },
    { date: '2026-09-25T18:00:00Z', time: '18:00:00', office: 'Chennai GPO', officeid: '29360001', event: 'Item Booked', remarks: '', rts: false },
  ];
  const refreshed = await callJson('/api/shipments/refresh', { method: 'POST', body: {} });
  assert.deepEqual(refreshed, { checked: 1, newEvents: 2 });
  assert.deepEqual(pushed(), ['IN_TRANSIT', 'OUT_FOR_DELIVERY']);
  const detail = await callJson(`/api/shipments/${shipment.id}`);
  assert.equal(detail.shipment.status, 'OUT_FOR_DELIVERY');
  assert.equal(detail.shipment.lastEvent, 'Taken out for delivery — Indiranagar SO');
  assert.deepEqual(detail.events.map((e) => e.description), ['Taken out for delivery', 'Bag Dispatch', 'Item Booked']);
  const metafield = calls.graphql.findLast((g) => /SetMetafields/.test(g.query)).variables.metafields[0];
  assert.equal(JSON.parse(metafield.value).status, 'OUT_FOR_DELIVERY');

  // Delivered: Shopify is told, and the order drops out of the automatic checks.
  tracking.events = [
    { date: '2026-09-26T13:00:00Z', time: '13:00:00', office: 'Indiranagar SO', officeid: '21560001', event: 'Item Delivered(Addressee)', remarks: '', rts: false },
    ...tracking.events,
  ];
  tracking.delivered = true;
  await callJson('/api/shipments/refresh', { method: 'POST', body: { shipmentIds: [shipment.id] } });
  assert.equal(ctx.db.getShipment(SHOP, shipment.id).status, 'DELIVERED');
  assert.deepEqual(pushed(), ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
  assert.deepEqual(await callJson('/api/shipments/refresh', { method: 'POST', body: {} }), { checked: 0, newEvents: 0 });

  // Storefront tracking page (app proxy) — signature required.
  const query = { shop: SHOP, path_prefix: '/apps/track', timestamp: String(Math.floor(Date.now() / 1000)), awb: AWB3.toLowerCase() };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join('');
  const signature = crypto.createHmac('sha256', 'secret456').update(message).digest('hex');
  assert.equal((await fetch(`${base}/proxy?${new URLSearchParams(query)}`)).status, 401);
  const page = await fetch(`${base}/proxy?${new URLSearchParams({ ...query, signature })}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /application\/liquid/);
  const html = await page.text();
  assert.match(html, /Delivered/);
  assert.match(html, /Bag Dispatch/);
});

test('tracking page without India Post API shows saved shipments only', async (t) => {
  const { server, base, call, calls } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: SETTINGS } });
  await call('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB1 } });

  const known = await (await fetch(`${base}/track?shop=${SHOP}&awb=${AWB1}`)).text();
  assert.match(known, new RegExp(AWB1));
  assert.match(known, /India Post website/);
  const unknown = await (await fetch(`${base}/track?shop=${SHOP}&awb=${AWB2}`)).text();
  assert.match(unknown, /No shipment found/);
  assert.equal(calls.tracking.length, 0);

  // "Update tracking" explains what is missing.
  const refresh = await call('/api/shipments/refresh', { method: 'POST', body: {} });
  assert.equal(refresh.status, 400);
  assert.match((await refresh.json()).error, /India Post API username and password/);
});

test('India Post API server setting only accepts India Post HTTPS hosts', async (t) => {
  const { ctx, server, call } = await setup();
  t.after(() => server.close());
  for (const bad of ['http://app.cept.gov.in/x', 'https://evil.example.com', 'https://cept.gov.in.evil.com']) {
    const res = await call('/api/settings', { method: 'PUT', body: { settings: { indiaPost: { baseUrl: bad } } } });
    assert.equal(res.status, 400, bad);
  }
  const ok = await call('/api/settings', { method: 'PUT', body: { settings: { indiaPost: { baseUrl: 'https://app.cept.gov.in/beextcustomer/', username: 'u', password: 'p' } } } });
  assert.equal(ok.status, 200);
  assert.equal(ctx.getSettings(SHOP).indiaPost.baseUrl, 'https://app.cept.gov.in/beextcustomer');
  assert.equal(ctx.indiaPostFor(SHOP).baseUrl, 'https://app.cept.gov.in/beextcustomer');
});

test('India Post connection: per-store webhook link, connection test and on/off switch', async (t) => {
  const { ctx, server, base, call, callJson, calls, tracking } = await setup();
  t.after(() => server.close());

  // Test connection before any login is saved.
  let { lastTest } = await callJson('/api/settings/test', { method: 'POST' });
  assert.equal(lastTest.ok, false);
  assert.match(lastTest.message, /username and password/);

  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, indiaPost: { ...SETTINGS.indiaPost, username: 'u', password: 'p', webhookToken: 'attacker-chosen' } } } });
  ({ lastTest } = await callJson('/api/settings/test', { method: 'POST' }));
  assert.equal(lastTest.ok, true);
  assert.equal(lastTest.message, 'Connected to India Post');
  const boot = await callJson('/api/bootstrap');
  assert.equal(boot.settings.indiaPost.lastTest.ok, true);
  assert.equal(boot.settings.indiaPost.password, '••••••••');

  // Each store has its own private webhook link; the token can't be set from the form.
  const link = boot.webhookUrl;
  assert.match(link, /^https:\/\/app\.test\/webhooks\/indiapost\/[a-f0-9]{48}$/);
  assert.notEqual(ctx.getSettings(SHOP).indiaPost.webhookToken, 'attacker-chosen');

  tracking.events = [];
  await call('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB1 } });
  // Another store with a shipment using the same article number is not touched by this store's link.
  const other = ctx.db.createShipment({ shop: 'other.myshopify.com', orderId: 'gid://shopify/Order/9', barcode: AWB1, status: 'BOOKED' });

  const event = { article_number: AWB1, event_code: 'BAG_DISPATCH', event_description: 'Bag Dispatch', event_date: '2026-09-26', event_time: '10:00:00', event_office_name: 'Kochi NSH' };
  const path = new URL(link).pathname;
  assert.deepEqual(await (await fetch(`${base}${path}`)).json(), { success: true, message: 'India Post webhook link is active' });
  // India Post's "Test" button may send an empty or sample body — accepted without changing anything.
  const probe = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test: true }) });
  assert.deepEqual(await probe.json(), { success: true, received: 1, stored: 0 });
  const send = (p) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal((await send('/webhooks/indiapost/' + 'a'.repeat(48))).status, 404);
  assert.deepEqual(await (await send(path)).json(), { success: true, received: 1, stored: 1 });
  assert.equal(ctx.db.getShipmentByOrder(SHOP, 'gid://shopify/Order/1001').status, 'IN_TRANSIT');
  assert.equal(ctx.db.getShipment('other.myshopify.com', other.id).status, 'BOOKED');

  // A new link replaces the old one.
  const { webhookUrl: fresh } = await callJson('/api/settings/webhook-link', { method: 'POST' });
  assert.notEqual(fresh, link);
  assert.equal((await send(path)).status, 404);

  // Switching live tracking off stops India Post calls.
  await call('/api/settings', { method: 'PUT', body: { settings: { indiaPost: { ...SETTINGS.indiaPost, enabled: false, username: 'u', password: '••••••••' } } } });
  assert.equal((await callJson('/api/bootstrap')).trackingEnabled, false);
  const before = calls.tracking.length;
  assert.equal((await call('/api/shipments/refresh', { method: 'POST', body: {} })).status, 400);
  assert.equal(calls.tracking.length, before);
});

test('storefront tracking page: search by tracking number, order number or mobile number', async (t) => {
  const { ctx, server, base, call, calls, tracking } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, indiaPost: { ...SETTINGS.indiaPost, username: 'u', password: 'p' } } } });
  // #1001 and #1003 go to the same mobile (sampleOrder uses 09876501234); #1002 stays unshipped.
  await call('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB1, bookingDate: '2026-09-25' } });
  await call('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1003', trackingNumber: AWB2, bookingDate: '2026-09-26' } });
  tracking.events = [];

  const page = async (params) => {
    const res = await fetch(`${base}/track?${new URLSearchParams({ shop: SHOP, ...params })}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    return html.slice(html.indexOf('</form>')); // results only (the search box has an example number)
  };

  // Order number, with or without '#'.
  for (const q of ['#1001', '1001']) {
    const html = await page({ q });
    assert.match(html, new RegExp(AWB1));
    assert.doesNotMatch(html, new RegExp(AWB2));
  }

  // Mobile number (any common format) lists every shipment for it, newest first.
  const byMobile = await page({ q: '+91 98765 01234' });
  assert.match(byMobile, /2 shipments found/);
  assert.ok(byMobile.indexOf(AWB2) < byMobile.indexOf(AWB1));
  assert.doesNotMatch(byMobile, /Asha Kumar/, 'no customer names on the public page');
  assert.match(await page({ q: '9000000000' }), /No shipped orders found for this mobile number/);

  // An order without a tracking number yet.
  assert.match(await page({ q: '#1002' }), /Order #1002 is confirmed/);
  assert.match(await page({ q: '#9999' }), /find order #9999/);

  // Tracking number still works, and old ?awb= links too.
  assert.match(await page({ awb: AWB2 }), new RegExp(AWB2));

  // Live data is fetched for stale shipments when India Post tracking is configured.
  const before = calls.tracking.length;
  ctx.db.updateShipment(ctx.db.getShipmentByBarcode(SHOP, AWB1).id, { last_polled_at: '2020-01-01T00:00:00Z' });
  await page({ q: '#1001' });
  assert.equal(calls.tracking.length, before + 1);

  // Privacy option: order number needs the matching mobile number.
  await call('/api/settings', { method: 'PUT', body: { settings: { trackingPage: { requireMobileForOrder: true } } } });
  const ask = await page({ q: '#1001' });
  assert.match(ask, /also enter the mobile number/);
  const form = await (await fetch(`${base}/track?${new URLSearchParams({ shop: SHOP, q: '#1001' })}`)).text();
  assert.match(form, /name="mobile"/);
  assert.doesNotMatch(ask, new RegExp(AWB1));
  assert.doesNotMatch(await page({ q: '#1001', mobile: '9000000000' }), new RegExp(AWB1));
  assert.match(await page({ q: '#1001', mobile: '9876501234' }), new RegExp(AWB1));
  assert.match(await page({ q: '#1002', mobile: '09876501234' }), /Order #1002 is confirmed/);
  assert.doesNotMatch(await page({ q: '#1002', mobile: '9000000000' }), /is confirmed/);
});

test('India Post ArticleDetails file matches the India Post template, with per-order booking options', async (t) => {
  const { server, call, callJson } = await setup();
  t.after(() => server.close());
  await call('/api/settings', {
    method: 'PUT',
    body: {
      settings: {
        ...SETTINGS,
        sender: { name: 'Kulambil Gas Industries', address1: '461/50', address2: 'East Kodur', address3: 'Chattiparamba PO', city: 'Malappuram', state: 'Kerala', pincode: '676504', mobile: '7907143164' },
        booking: { reg: false, otp: true, ack: false },
      },
    },
  });

  // Defaults from Settings show in the form.
  const draft = await callJson('/api/order?id=1002');
  assert.equal(draft.form.options.otp, true);
  assert.equal(draft.form.options.reg, false);

  // Per-order options: REG + ACK + priority + delivery slot + return instruction, OTP off, shape NROL.
  await callJson('/api/order/save', {
    method: 'POST',
    body: {
      orderId: 'gid://shopify/Order/1002',
      trackingNumber: AWB1,
      bookingDate: '2026-10-03',
      overrides: {
        weightGrams: '2000',
        dimensions: { length: '35', breadth: '31', height: '10' },
        codAmount: '2200', // ignored: all orders are prepaid
        options: { reg: 'true', otp: false, ack: true, priority: true, shape: 'NROL', deliverySlot: '2pm-5pm', instructionRts: 'RTS', deliveryInstruction: 'BOGUS' },
      },
    },
  });
  await callJson('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB2, bookingDate: '2026-10-03' } });

  // Editing a saved order shows what was saved.
  const saved = await callJson('/api/order?id=1002');
  assert.equal(saved.form.weightGrams, 2000);
  assert.equal(saved.form.codAmount, undefined);
  assert.deepEqual(
    { ...saved.form.options },
    { reg: true, otp: false, ack: true, priority: true, shape: 'NROL', deliveryInstruction: '', deliverySlot: '2pm-5pm', instructionRts: 'RTS' },
  );

  // Default download = India Post ArticleDetails file.
  const res = await call('/api/export?from=2026-10-03&to=2026-10-03');
  assert.match(res.headers.get('content-disposition'), /filename="ArticleDetails-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = book.getWorksheet('ArticleDetails');
  assert.ok(sheet, 'sheet is named ArticleDetails like the template');

  // Same headers, same order as India Post's template.
  const template = new ExcelJS.Workbook();
  await template.xlsx.readFile(new URL('./fixtures/ArticleDetails-template.xlsx', import.meta.url).pathname);
  const expected = template.getWorksheet('ArticleDetails').getRow(1).values.slice(1);
  assert.deepEqual(sheet.getRow(1).values.slice(1), expected);
  assert.equal(expected.length, 48);

  const row = (n) => Object.fromEntries(expected.map((h, i) => [h, sheet.getRow(n).getCell(i + 1).value]));
  assert.equal(sheet.rowCount, 3);
  const first = row(2); // #1002 saved first
  assert.equal(first['SERIAL NUMBER'], 1);
  assert.equal(first['BARCODE NO'], AWB1);
  assert.equal(first['PHYSICAL WEIGHT'], 2000);
  assert.equal(first.REG, true);
  assert.equal(first.OTP, false);
  assert.equal(first.ACK, true);
  assert.equal(first['PRIORITY FLAG'], true);
  assert.equal(first['RECEIVER CITY'], 'BENGALURU');
  assert.equal(first['RECEIVER PINCODE'], 560038);
  assert.equal(first['RECEIVER NAME'], 'ASHA KUMAR');
  assert.equal(first['RECEIVER MOBILE NO'], 9876501234);
  assert.equal(first['SENDER MOBILE NO'], 7907143164);
  assert.equal(first['CODR/COD'], null, 'all orders are prepaid');
  assert.equal(first['VALUE FOR CODR/COD'], null);
  assert.equal(first['PREPAYMENT CODE'], null, 'no prepayment code');
  assert.equal(first['VALUE OF PREPAYMENT'], null, 'no prepaid amount');
  assert.equal(first['SHAPE OF ARTICLE'], 'NROL');
  assert.deepEqual([first['LENGTH '], first['BREADTH/DIAMETER'], first.HEIGHT], [35, 31, 10]);
  assert.equal(first['DELIVERY SLOT'], '2pm-5pm');
  assert.equal(first['INSTRUCTION RTS'], 'RTS');
  assert.equal(first['DELIVERY INSTRUCTION'], null, 'unknown values are dropped');
  assert.equal(first['SENDER NAME'], 'KULAMBIL GAS INDUSTRIES');
  assert.equal(first['SENDER CITY'], 'MALAPPURAM');
  assert.equal(first['SENDER STATE/UT'], 'KERALA');
  assert.equal(first['SENDER PINCODE'], '676504');
  assert.equal(first['ALT ADDRESS FLAG'], false);
  assert.equal(first['BULK REFERENCE'], '#1002');
  assert.deepEqual(
    [first['SENDER ADD LINE 1'], first['SENDER ADD LINE 2'], first['SENDER ADD LINE 3']],
    ['461/50', 'East Kodur', 'Chattiparamba PO'],
    'sender lines stay as typed in Settings',
  );

  const prepaid = row(3);
  assert.equal(prepaid['SERIAL NUMBER'], 2);
  assert.equal(prepaid.OTP, true, 'Settings default');
  assert.equal(prepaid['CODR/COD'], null);
  assert.equal(prepaid['VALUE FOR CODR/COD'], null);
  assert.equal(prepaid['VALUE OF PREPAYMENT'], null);
  // Quick entry: the post office comes from the pincode; the customer's city stays.
  assert.deepEqual(
    [prepaid['RECEIVER ADD LINE 1'], prepaid['RECEIVER ADD LINE 2'], prepaid['RECEIVER ADD LINE 3']],
    ['FLAT 4B GREEN RESIDENCY 2ND CROSS', 'INDIRANAGAR', 'INDIRANAGAR SO (BANGALORE)'],
  );
  assert.equal(prepaid['RECEIVER CITY'], 'BENGALURU');

  // With a Ref no, BULK REFERENCE is "<ref>/<serial>" and the next file gets the next ref no.
  assert.equal((await callJson('/api/bootstrap')).nextExportRef, 1);
  const withRef = await call('/api/export?from=2026-10-03&to=2026-10-03&ref=7');
  const refBook = new ExcelJS.Workbook();
  await refBook.xlsx.load(Buffer.from(await withRef.arrayBuffer()));
  const refSheet = refBook.getWorksheet('ArticleDetails');
  const refCol = expected.indexOf('BULK REFERENCE') + 1;
  assert.deepEqual([refSheet.getRow(2).getCell(refCol).value, refSheet.getRow(3).getCell(refCol).value], ['7/1', '7/2']);
  assert.equal((await callJson('/api/bootstrap')).nextExportRef, 8);
});

test('post office lookup: live directory first, bundled India Post directory as fallback', async () => {
  const { createPincodeLookup, guessOffice } = await import('../src/indiapost/pincodes.js');
  const live = createPincodeLookup({
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://api.postalpincode.in/pincode/683561');
      return new Response(JSON.stringify([{ Status: 'Success', PostOffice: [
        { Name: 'Vilangu', BranchType: 'Branch Post Office', District: 'Ernakulam', State: 'Kerala' },
        { Name: 'Edathala', BranchType: 'Sub Post Office', District: 'Ernakulam', State: 'Kerala' },
      ] }]));
    },
  });
  const found = await live.lookup('683561');
  assert.equal(found.source, 'live');
  assert.deepEqual(found.offices.map((o) => o.name), ['Edathala SO', 'Vilangu BO']);
  assert.equal(found.offices[0].state, 'KERALA');

  const offline = createPincodeLookup({ fetchImpl: async () => { throw new Error('offline'); }, logger: { warn() {} } });
  const bundled = await offline.lookup('683561');
  assert.equal(bundled.source, 'bundled');
  assert.equal(bundled.offices[0].name, 'Edathala SO');
  assert.equal(guessOffice(bundled.offices, 'Near Vilangu temple').name, 'Vilangu BO');
  assert.equal(guessOffice(bundled.offices, 'Pallikutti canal road').name, 'Edathala SO');
  assert.equal((await offline.lookup('12345')).source, 'none');
});

test('tracking refresh splits shipments into batches of 50', async () => {
  const { refreshShipments } = await import('../src/services/tracking.js');
  const batches = [];
  const shipments = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, barcode: `EB${String(i).padStart(9, '0')}IN` }));
  const ctx = {
    indiaPostFor: () => ({ trackBulk: async (chunk) => (batches.push(chunk.length), []) }),
    db: { updateShipment() {} },
  };
  await refreshShipments(ctx, 'shop.myshopify.com', shipments);
  assert.deepEqual(batches, [50, 50, 20]);
});

test('Excel uses the sender from Settings, also for orders created before it was filled in', async (t) => {
  const { server, call, callJson } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, sender: {} } } });
  assert.ok((await callJson('/api/bootstrap')).senderProblems.includes('name'));
  await callJson('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB1, bookingDate: '2026-10-16' } });

  await call('/api/settings', {
    method: 'PUT',
    body: { settings: { ...SETTINGS, sender: { name: 'Lunabee', address1: 'Thottathil House, Chall', address3: 'MALAPPURAM - 676509', city: 'Malappuram', state: 'Kerala', pincode: '676509', mobile: '9876543210' } } },
  });
  assert.deepEqual((await callJson('/api/bootstrap')).senderProblems, []);

  const res = await call('/api/export?from=2026-10-16&to=2026-10-16');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = book.getWorksheet('ArticleDetails');
  const header = sheet.getRow(1).values.slice(1);
  const cell = (h) => sheet.getRow(2).getCell(header.indexOf(h) + 1).value;
  assert.equal(cell('SENDER NAME'), 'LUNABEE');
  assert.equal(cell('SENDER ADD LINE 1'), 'Thottathil House Chall');
  assert.equal(cell('SENDER ADD LINE 2'), 'MALAPPURAM - 676509');
  assert.equal(cell('SENDER CITY'), 'MALAPPURAM');
  assert.equal(cell('SENDER STATE/UT'), 'KERALA');
  assert.equal(cell('SENDER PINCODE'), '676509');
  assert.equal(cell('SENDER MOBILE NO'), 9876543210);

  // A placeholder sender mobile like India Post's booking tool uses is exported as it is.
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, sender: { ...SETTINGS.sender, mobile: '1234567890' } } } });
  assert.deepEqual((await callJson('/api/bootstrap')).senderProblems, []);
  const again = new ExcelJS.Workbook();
  await again.xlsx.load(Buffer.from(await (await call('/api/export?from=2026-10-16&to=2026-10-16')).arrayBuffer()));
  const row = again.getWorksheet('ArticleDetails').getRow(2);
  assert.equal(row.getCell(header.indexOf('SENDER MOBILE NO') + 1).value, 1234567890);
});

test('India Post API address: a pasted endpoint link is cut back to the base address', async (t) => {
  const { indiaPostBaseUrl } = await import('../src/server.js');
  assert.equal(indiaPostBaseUrl('https://test.cept.gov.in/beextcustomer/v1/tracking/bulk'), 'https://test.cept.gov.in/beextcustomer');
  assert.equal(indiaPostBaseUrl(' https://api.cept.gov.in/beextcustomer/ '), 'https://api.cept.gov.in/beextcustomer');
  assert.equal(indiaPostBaseUrl('https://api.cept.gov.in/beextcustomer/v1/access/login?x=1'), 'https://api.cept.gov.in/beextcustomer');

  const { server, call, callJson } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, indiaPost: { ...SETTINGS.indiaPost, baseUrl: 'https://prod.cept.gov.in/beextcustomer/v1/trac' } } } });
  assert.equal((await callJson('/api/settings')).settings.indiaPost.baseUrl, 'https://prod.cept.gov.in/beextcustomer');
  // The test server typed as "production" is stored as the test server.
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, indiaPost: { ...SETTINGS.indiaPost, baseUrl: `${IP_BASE}/v1/tracking/bulk` } } } });
  assert.equal((await callJson('/api/settings')).settings.indiaPost.baseUrl, '');
});
