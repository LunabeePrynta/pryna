// Tracking: store India Post events, mirror them to Shopify (fulfillment events + metafields)
// and answer public tracking lookups.

import { isValidBarcode, normalizeBarcode } from '../indiapost/barcode.js';
import {
  STATUS_LABELS,
  normalizeTrackingResult,
  normalizeWebhookEvent,
  shipmentStatusFor,
  shopifyStatusFor,
} from '../indiapost/events.js';

const TRACKING_CHUNK = 500;
const FRESH_MS = 5 * 60_000;

/**
 * Stores new events for a shipment and pushes status changes to Shopify.
 * Returns the number of newly stored events.
 */
export async function applyEvents(ctx, shop, shipment, events, { delivered = false, polled = false } = {}) {
  const { db, logger } = ctx;
  const sorted = [...events].sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));
  const fresh = sorted.filter((e) => db.insertEvent(shipment.id, e));

  const latest = sorted.at(-1);
  let status = shipment.status;
  for (const e of sorted) {
    // Late-arriving older events must not move the status backwards.
    if (shipment.last_event_at && e.happenedAt < shipment.last_event_at) continue;
    const mapped = shipmentStatusFor(shopifyStatusFor(e));
    if (mapped) status = mapped;
  }
  if (delivered && status !== 'RETURNED') status = 'DELIVERED';

  const update = polled ? { last_polled_at: new Date().toISOString() } : {};
  if (latest && (!shipment.last_event_at || latest.happenedAt >= shipment.last_event_at)) {
    update.last_event = [latest.description, latest.office].filter(Boolean).join(' — ');
    update.last_event_at = latest.happenedAt;
  }
  if (status !== shipment.status) update.status = status;
  db.updateShipment(shipment.id, update);

  const forward = fresh.filter((e) => !shipment.last_event_at || e.happenedAt >= shipment.last_event_at);
  if (forward.length) {
    try {
      await pushToShopify(ctx, shop, db.getShipment(shop, shipment.id), forward);
    } catch (err) {
      logger.error(`[tracking] Shopify sync failed for ${shipment.barcode}: ${err.message}`);
    }
  }
  return fresh.length;
}

async function pushToShopify(ctx, shop, shipment, freshEvents) {
  const admin = ctx.adminFor(shop);
  let current = shipment.shopify_status;
  for (const e of freshEvents) {
    const status = shopifyStatusFor(e);
    if (!status || status === current) continue;
    for (const fulfillmentId of shipment.fulfillment_ids) {
      await admin.createFulfillmentEvent(fulfillmentId, {
        status,
        message: [e.description, e.office, e.remarks].filter(Boolean).join(' · ').slice(0, 255),
        happenedAt: e.happenedAt,
        city: e.office ?? undefined,
      });
    }
    current = status;
  }
  if (current !== shipment.shopify_status) ctx.db.updateShipment(shipment.id, { shopify_status: current });
  await syncShopifyMetafields(ctx, shop, ctx.db.getShipment(shop, shipment.id));
}

export function shipmentSummary(ctx, shop, shipment) {
  return {
    awb: shipment.barcode,
    carrier: 'India Post',
    status: shipment.status,
    status_label: STATUS_LABELS[shipment.status] ?? shipment.status,
    last_event: shipment.last_event,
    last_event_at: shipment.last_event_at,
    order: shipment.order_name,
    tracking_url: ctx.trackingUrl(shop, shipment.barcode),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Writes `indiapost.tracking` on the order and `indiapost.latest_shipment` on the customer,
 * so themes / customer account pages can show live India Post status.
 */
export async function syncShopifyMetafields(ctx, shop, shipment) {
  const summary = shipmentSummary(ctx, shop, shipment);
  await ctx.adminFor(shop).setJsonMetafields([
    { ownerId: shipment.order_id, key: 'tracking', value: summary },
    { ownerId: shipment.customer_id, key: 'latest_shipment', value: summary },
  ]);
}

/** Pulls tracking for the given shipments from the Bulk Tracking API. */
export async function refreshShipments(ctx, shop, shipments) {
  if (!shipments.length) return 0;
  const client = ctx.indiaPostFor(shop);
  const byBarcode = new Map(shipments.map((s) => [s.barcode, s]));
  let stored = 0;
  const barcodes = [...byBarcode.keys()];
  for (let i = 0; i < barcodes.length; i += TRACKING_CHUNK) {
    const items = await client.trackBulk(barcodes.slice(i, i + TRACKING_CHUNK));
    for (const item of items) {
      const result = normalizeTrackingResult(item);
      const shipment = byBarcode.get(result.barcode);
      if (!shipment) continue;
      stored += await applyEvents(ctx, shop, ctx.db.getShipment(shop, shipment.id), result.events, {
        delivered: result.delivered,
        polled: true,
      });
    }
  }
  return stored;
}

/** Background job: refresh every in-flight shipment of every installed shop. */
export async function pollAllShops(ctx) {
  for (const shop of ctx.db.listActiveShops()) {
    if (!ctx.hasTracking(shop)) continue;
    const active = ctx.db.listActiveShipments(shop);
    if (!active.length) continue;
    try {
      const stored = await refreshShipments(ctx, shop, active);
      ctx.logger.info(`[poll] ${shop}: ${active.length} shipments checked, ${stored} new events`);
    } catch (err) {
      ctx.logger.error(`[poll] ${shop}: ${err.message}`);
    }
  }
}

/** Handles one event pushed by India Post to the webhook endpoint. */
export async function handleIndiaPostEvent(ctx, payload) {
  const normalized = normalizeWebhookEvent(payload);
  if (!normalized) return { stored: false, reason: 'invalid payload' };
  const shipments = ctx.db.findShipmentsByBarcode(normalized.barcode);
  if (!shipments.length) return { stored: false, reason: 'unknown article' };
  let stored = 0;
  for (const shipment of shipments) {
    stored += await applyEvents(ctx, shipment.shop, shipment, [normalized.event]);
  }
  return { stored: stored > 0 };
}

/**
 * Public lookup by article number (AWB) for the storefront tracking page.
 * Uses stored data when fresh, otherwise asks India Post.
 */
export async function lookupTracking(ctx, shop, rawQuery) {
  const awb = normalizeBarcode(rawQuery);
  if (!isValidBarcode(awb)) return { awb, error: 'Please enter a valid 13 character India Post article number, e.g. EB123456785IN.' };

  let shipment = ctx.db.getShipmentByBarcode(shop, awb);
  let booking = null;
  let delivered = false;
  const stale = !shipment?.last_polled_at || Date.now() - Date.parse(shipment.last_polled_at) > FRESH_MS;

  if ((!shipment || stale) && ctx.hasTracking(shop)) {
    try {
      const [item] = await ctx.indiaPostFor(shop).trackBulk([awb]);
      if (item) {
        const result = normalizeTrackingResult(item);
        booking = result.booking;
        delivered = result.delivered;
        if (shipment) {
          await applyEvents(ctx, shop, shipment, result.events, { delivered, polled: true });
          shipment = ctx.db.getShipment(shop, shipment.id);
        } else {
          return present(awb, { booking, delivered, events: result.events.slice().reverse() });
        }
      } else if (!shipment) {
        return { awb, error: 'No tracking information found for this article yet. Please try again later.' };
      }
    } catch (err) {
      ctx.logger.error(`[track] ${shop} ${awb}: ${err.message}`);
      if (!shipment) return { awb, error: 'Tracking is temporarily unavailable. Please try again in a few minutes.' };
    }
  }

  if (!shipment) return { awb, error: 'No shipment found with this tracking number. Please check the number and try again.' };

  const events = ctx.db.listEvents(shipment.id).map((e) => ({
    description: e.description,
    office: e.office,
    remarks: e.remarks,
    happenedAt: e.happened_at,
  }));
  return present(awb, {
    booking,
    delivered: delivered || shipment.status === 'DELIVERED',
    events,
    status: shipment.status,
    orderName: shipment.order_name,
  });
}

function present(awb, { booking, delivered, events, status, orderName }) {
  let finalStatus = status;
  if (!finalStatus) {
    finalStatus = delivered ? 'DELIVERED' : 'BOOKED';
    for (const e of [...events].reverse()) finalStatus = shipmentStatusFor(shopifyStatusFor(e)) ?? finalStatus;
  }
  return {
    awb,
    status: finalStatus,
    statusLabel: STATUS_LABELS[finalStatus] ?? finalStatus,
    orderName: orderName ?? null,
    booking: booking
      ? {
          bookedAt: booking.booked_at,
          bookedOn: booking.booked_on,
          origin: booking.origin_pincode,
          destination: booking.destination_pincode,
          deliveryOffice: booking.delivery_location,
          articleType: booking.article_type,
        }
      : null,
    events: events.map((e) => ({ description: e.description, office: e.office, remarks: e.remarks, happenedAt: e.happenedAt })),
  };
}
