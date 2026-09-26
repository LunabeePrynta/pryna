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
  return { fetchImpl, calls, orders };
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
  const res = await call('/api/export?from=2026-09-26&to=2026-09-26');
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
  assert.equal(row(2)['COD amount'], 0);
  assert.equal(row(3).Order, '#1002');
  assert.equal(row(3)['COD amount'], 899, 'unpaid COD order carries the COD amount');
  assert.equal(row(3).Product, 'Speed Post (document)');

  const upload = workbook.getWorksheet('India Post upload');
  const uploadHeader = upload.getRow(1).values.slice(1);
  assert.equal(uploadHeader[0], 'bulk_customer_id');
  assert.equal(upload.getRow(2).getCell(uploadHeader.indexOf('barcode_no') + 1).value, AWB1);
  assert.equal(upload.getRow(2).getCell(uploadHeader.indexOf('contract_id') + 1).value, '41585456');

  // Only the ticked orders go into the file, whatever the date filter says.
  const { shipments: all } = await callJson('/api/shipments');
  const second = all.find((s) => s.orderName === '#1002');
  const ticked = await call(`/api/export?ids=${second.id}&from=2030-01-01&mark=0`);
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

test('with India Post tracking configured: tracking link, storefront page and webhook updates', async (t) => {
  const { ctx, server, base, call, callJson, calls } = await setup();
  t.after(() => server.close());
  await call('/api/settings', { method: 'PUT', body: { settings: { ...SETTINGS, indiaPost: { ...SETTINGS.indiaPost, username: 'u', password: 'p' } } } });
  assert.equal((await callJson('/api/bootstrap')).trackingEnabled, true);

  const { shipment } = await callJson('/api/order/save', { method: 'POST', body: { orderId: 'gid://shopify/Order/1001', trackingNumber: AWB3 } });
  assert.equal(fulfilCalls(calls)[0].trackingInfo.url, `https://${SHOP}/apps/track?awb=${AWB3}`);

  // India Post webhook: wrong secret rejected, valid event updates Shopify.
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
  const pushed = () => calls.graphql.filter((g) => /CreateFulfillmentEvent/.test(g.query)).map((g) => g.variables.event.status);
  assert.deepEqual(pushed(), ['IN_TRANSIT']);

  // Storefront tracking page (app proxy) — signature required, then live lookup.
  const query = { shop: SHOP, path_prefix: '/apps/track', timestamp: String(Math.floor(Date.now() / 1000)), awb: AWB3.toLowerCase() };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join('');
  const signature = crypto.createHmac('sha256', 'secret456').update(message).digest('hex');
  assert.equal((await fetch(`${base}/proxy?${new URLSearchParams(query)}`)).status, 401);
  const page = await fetch(`${base}/proxy?${new URLSearchParams({ ...query, signature })}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /application\/liquid/);
  const html = await page.text();
  assert.match(html, /Out for delivery/);
  assert.match(html, /Bag Dispatch/);
  assert.deepEqual(pushed(), ['IN_TRANSIT', 'OUT_FOR_DELIVERY']);
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
});
