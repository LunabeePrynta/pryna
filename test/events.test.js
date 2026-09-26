import test from 'node:test';
import assert from 'node:assert/strict';
import {
  istTimestamp,
  normalizeTrackingResult,
  normalizeWebhookEvent,
  shipmentStatusFor,
  shopifyStatusFor,
} from '../src/indiapost/events.js';

test('India Post clock times are read as IST', () => {
  // Tracking API labels IST clock values with "Z"; booked_on shows the real offset.
  assert.equal(istTimestamp('2026-09-05T23:24:16.038Z', '23:24:16'), '2026-09-05T17:54:16.000Z');
  assert.equal(istTimestamp('2025-11-09', '08:37:52'), '2025-11-09T03:07:52.000Z');
  assert.equal(istTimestamp('bad', '08:00:00'), null);
});

test('normalizes bulk tracking results', () => {
  const r = normalizeTrackingResult({
    booking_details: { article_number: 'RK775227016IN' },
    tracking_details: [
      { date: '2026-09-07T12:56:46.613Z', time: '12:56:46', office: 'Kalanjoor SO', officeid: '22660021', event: 'Taken out for delivery', remarks: '', rts: false },
      { date: '2026-09-05T23:24:16.038Z', time: '23:24:16', office: 'Changanacherry HO', officeid: '22360017', event: 'Item Booked', remarks: '', rts: false },
    ],
    del_status: { del_status: 'not delivered' },
  });
  assert.equal(r.barcode, 'RK775227016IN');
  assert.equal(r.delivered, false);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].officeId, '22660021');
  assert.notEqual(r.events[0].key, r.events[1].key);
});

test('normalizes webhook events', () => {
  const n = normalizeWebhookEvent({
    article_number: 'aw784699994in',
    event_date: '2025-11-09',
    event_time: '08:37:52',
    event_code: 'BAG_CLOSE',
    event_description: 'Bag Close',
    event_office_facility_id: '21250003',
    event_office_name: 'KADUGODI BNPL CENTRE',
  });
  assert.equal(n.barcode, 'AW784699994IN');
  assert.equal(n.event.code, 'BAG_CLOSE');
  assert.equal(normalizeWebhookEvent({}), null);
});

test('maps India Post events to Shopify fulfillment statuses', () => {
  const cases = [
    [{ description: 'Pickup Request Raised' }, null],
    [{ description: 'Item Booked' }, 'CARRIER_PICKED_UP'],
    [{ description: 'Item Dispatched' }, 'IN_TRANSIT'],
    [{ description: 'Bag Received' }, 'IN_TRANSIT'],
    [{ description: 'Item received at Destination' }, 'IN_TRANSIT'],
    [{ description: 'Taken out for delivery' }, 'OUT_FOR_DELIVERY'],
    [{ description: 'Item Kept on Hold' }, 'DELAYED'],
    [{ description: 'Item Hold' }, 'DELAYED'],
    [{ description: 'Item not Delivered' }, 'ATTEMPTED_DELIVERY'],
    [{ description: 'Bag Opened' }, 'IN_TRANSIT'],
    [{ description: 'Item Returned' }, 'FAILURE'],
    [{ description: 'Item Redirected' }, 'IN_TRANSIT'],
    [{ description: 'Item Delivered(Addressee)' }, 'DELIVERED'],
    [{ code: 'ITEM_DELIVERY', description: 'Item Delivered(Sender)' }, 'FAILURE'],
    [{ code: 'ITEM_RETURN', description: 'Item Returned to Sender' }, 'FAILURE'],
    [{ code: 'ITEM_INVOICE', description: 'Item Invoiced' }, 'OUT_FOR_DELIVERY'],
    [{ code: 'Unassigned', description: 'Pickup Request Raised' }, null],
  ];
  for (const [event, expected] of cases) assert.equal(shopifyStatusFor(event), expected, JSON.stringify(event));
  assert.equal(shipmentStatusFor('DELIVERED'), 'DELIVERED');
  assert.equal(shipmentStatusFor('FAILURE'), 'RETURNED');
  assert.equal(shipmentStatusFor(null), null);
});
