// Normalises India Post tracking events (bulk tracking API + webhook) and maps them to
// Shopify fulfillment event statuses and the app's own shipment status.

import { normalizeBarcode } from './barcode.js';

/**
 * India Post timestamps are Indian Standard Time. The tracking API labels them with "Z"
 * even though the clock value is IST, so the date + time parts are re-read as +05:30.
 */
export function istTimestamp(date, time) {
  // A timestamp with an explicit offset (e.g. +05:30) is exact; "Z" or none is read as India time.
  if (!time && /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}:\d{2}$/.test(String(date ?? ''))) {
    const exact = new Date(date);
    return Number.isNaN(exact.getTime()) ? null : exact.toISOString();
  }
  const day = String(date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = /^\d{2}:\d{2}(:\d{2})?$/.test(String(time ?? '')) ? String(time) : String(date).slice(11, 19) || '00:00:00';
  const iso = new Date(`${day}T${clock.length === 5 ? `${clock}:00` : clock}+05:30`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

function eventKey(barcode, e) {
  return [barcode, e.happenedAt, (e.description || e.code || '').toLowerCase(), e.officeId || e.office || ''].join('|');
}

/** Events from one article in the Bulk Tracking API response. */
export function normalizeTrackingResult(item) {
  const barcode = normalizeBarcode(item?.booking_details?.article_number);
  const events = (item?.tracking_details ?? [])
    .map((t) => {
      const e = {
        code: null,
        description: t.event,
        office: t.office,
        officeId: t.officeid ? String(t.officeid) : null,
        remarks: t.remarks || (t.rts ? 'Return to sender' : ''),
        rts: Boolean(t.rts),
        happenedAt: istTimestamp(t.date, t.time),
        source: 'tracking_api',
      };
      return e.happenedAt ? { ...e, key: eventKey(barcode, e) } : null;
    })
    .filter(Boolean);
  return {
    barcode,
    booking: item?.booking_details ?? null,
    delivered: /^delivered$/i.test(item?.del_status?.del_status ?? ''),
    events,
  };
}

/** Event pushed by India Post to our webhook endpoint. */
export function normalizeWebhookEvent(payload) {
  const barcode = normalizeBarcode(payload?.article_number);
  const e = {
    code: payload?.event_code || null,
    description: payload?.event_description || payload?.event_code,
    office: payload?.event_office_name,
    officeId: payload?.event_office_facility_id ? String(payload.event_office_facility_id) : null,
    remarks: payload?.non_delivery_reason || '',
    rts: false,
    happenedAt: istTimestamp(payload?.event_date, payload?.event_time),
    source: 'webhook',
  };
  if (!barcode || !e.happenedAt) return null;
  return { barcode, event: { ...e, key: eventKey(barcode, e) } };
}

const CODE_MAP = {
  UNASSIGNED: null,
  ASSIGNED: null,
  CANCELLED: null,
  PICKEDUP: 'CARRIER_PICKED_UP',
  INDUCTED: 'CARRIER_PICKED_UP',
  ITEM_BOOK: 'CARRIER_PICKED_UP',
  BAG_CLOSE: 'IN_TRANSIT',
  BAG_DISPATCH: 'IN_TRANSIT',
  BAG_OPEN: 'IN_TRANSIT',
  ITEM_BAG: 'IN_TRANSIT',
  ITEM_REDIRECT: 'IN_TRANSIT',
  ITEM_INVOICE: 'OUT_FOR_DELIVERY',
  ITEM_ONHOLD: 'DELAYED',
  ITEM_RETURN: 'FAILURE',
};

/** Shopify FulfillmentEventStatus for an India Post event, or null when it should not be surfaced. */
export function shopifyStatusFor(event) {
  const code = String(event.code ?? '').toUpperCase();
  const text = String(event.description ?? '').toLowerCase();

  if (code === 'ITEM_DELIVERY' || text.startsWith('item delivered')) {
    return /sender/.test(text) ? 'FAILURE' : 'DELIVERED';
  }
  if (event.remarks && code === 'ITEM_INVOICE') return 'ATTEMPTED_DELIVERY';
  if (code in CODE_MAP) return CODE_MAP[code];

  if (/pickup request|pickup assigned|pickup cancel/.test(text)) return null;
  if (/returned|return to sender/.test(text) || event.rts) return 'FAILURE';
  if (/out for delivery|invoiced/.test(text)) return 'OUT_FOR_DELIVERY';
  if (/on hold/.test(text)) return 'DELAYED';
  if (/not delivered|delivery attempt|addressee (absent|not)/.test(text)) return 'ATTEMPTED_DELIVERY';
  if (/picked ?up|inducted|booked/.test(text)) return 'CARRIER_PICKED_UP';
  if (/bag|dispatch|received|redirect/.test(text)) return 'IN_TRANSIT';
  return null;
}

/** App shipment status derived from a Shopify event status. */
export function shipmentStatusFor(shopifyStatus) {
  switch (shopifyStatus) {
    case 'DELIVERED':
      return 'DELIVERED';
    case 'FAILURE':
      return 'RETURNED';
    case 'OUT_FOR_DELIVERY':
    case 'ATTEMPTED_DELIVERY':
      return 'OUT_FOR_DELIVERY';
    case 'DELAYED':
      return 'ON_HOLD';
    case 'CARRIER_PICKED_UP':
    case 'IN_TRANSIT':
      return 'IN_TRANSIT';
    default:
      return null;
  }
}

export const STATUS_LABELS = {
  PENDING: 'Pending',
  BOOKING: 'Booking…',
  ERROR: 'Needs attention',
  BOOKED: 'Booked',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  ON_HOLD: 'On hold',
  DELIVERED: 'Delivered',
  RETURNED: 'Returned to sender',
};
