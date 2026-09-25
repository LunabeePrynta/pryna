// Pushes Shopify orders to India Post: allocate AWB → book → label → Shopify fulfillment.

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildBarcode, parseSeriesBoundary } from '../indiapost/barcode.js';
import { buildArticle, buildLabel } from '../indiapost/mapper.js';
import { syncShopifyMetafields } from './tracking.js';

const BOOKING_CHUNK = 500;
const inFlight = new Set();

export class BookingError extends Error {}

/** Reserves the next barcode from the AWB series configured for the shop. */
export function allocateBarcode(ctx, shop, settings) {
  const { seriesStart, seriesEnd } = settings.barcode;
  if (!seriesStart || !seriesEnd) throw new BookingError('Settings: AWB series start/end is not configured');
  const start = parseSeriesBoundary(seriesStart);
  const end = parseSeriesBoundary(seriesEnd);
  if (start.prefix !== end.prefix) throw new BookingError('AWB series start and end must use the same 2 letter prefix');
  const serial = ctx.db.reserveSerial(shop, start.prefix, start.serial, end.serial);
  if (serial === null) throw new BookingError('AWB series is exhausted — ask India Post for a new range');
  return buildBarcode(start.prefix, serial);
}

function result(shipment, extra = {}) {
  return {
    orderId: shipment?.order_id,
    orderName: shipment?.order_name,
    shipmentId: shipment?.id,
    barcode: shipment?.barcode,
    status: shipment?.status,
    errors: shipment?.errors ?? [],
    ...extra,
  };
}

/**
 * Books the given Shopify orders (GraphQL ids) with India Post.
 * Orders already booked are skipped; failed ones can be pushed again and reuse their AWB.
 */
export async function pushOrders(ctx, shop, orderIds) {
  const { db, logger } = ctx;
  const settings = ctx.getSettings(shop);
  const admin = ctx.adminFor(shop);
  const results = [];
  const pending = [];

  for (const orderId of [...new Set(orderIds)]) {
    const lockKey = `${shop}|${orderId}`;
    if (inFlight.has(lockKey)) {
      results.push({ orderId, status: 'BOOKING', errors: ['Booking already in progress'] });
      continue;
    }
    let shipment = db.getShipmentByOrder(shop, orderId);
    // A BOOKING row left behind by a crash becomes retryable after 10 minutes.
    const stale = shipment?.status === 'BOOKING' && Date.now() - Date.parse(`${shipment.updated_at.replace(' ', 'T')}Z`) > 10 * 60_000;
    if (shipment && !['PENDING', 'ERROR'].includes(shipment.status) && !stale) {
      results.push(result(shipment, { skipped: true }));
      continue;
    }

    inFlight.add(lockKey);
    try {
      const order = await admin.getOrder(orderId);
      if (!order) throw new BookingError('Order not found in Shopify');
      if (!shipment) {
        shipment = db.createShipment({
          shop,
          orderId,
          orderName: order.name,
          customerId: order.customer?.id,
          barcode: allocateBarcode(ctx, shop, settings),
          status: 'PENDING',
        });
      }
      const { article, errors } = buildArticle(order, settings, shipment.barcode);
      db.updateShipment(shipment.id, {
        article,
        article_type: article.article_type,
        order_name: order.name,
        customer_id: order.customer?.id ?? null,
        status: errors.length ? 'ERROR' : 'BOOKING',
        errors,
      });
      shipment = db.getShipment(shop, shipment.id);
      if (errors.length) {
        inFlight.delete(lockKey);
        results.push(result(shipment));
      } else {
        pending.push({ shipment, order, lockKey });
      }
    } catch (err) {
      inFlight.delete(lockKey);
      if (shipment) {
        db.updateShipment(shipment.id, { status: 'ERROR', errors: [err.message] });
        results.push(result(db.getShipment(shop, shipment.id)));
      } else {
        results.push({ orderId, status: 'ERROR', errors: [err.message] });
      }
    }
  }

  for (let i = 0; i < pending.length; i += BOOKING_CHUNK) {
    const chunk = pending.slice(i, i + BOOKING_CHUNK);
    try {
      const response = await ctx
        .indiaPostFor(shop, settings)
        .bookArticles(settings.indiaPost.bulkCustomerId, chunk.map((p) => p.shipment.article));
      const valid = new Map((response.valid_articles ?? []).map((a) => [a.barcode_no, a]));
      const invalid = new Map((response.error_articles ?? []).map((a) => [a.barcode_no, a]));

      for (const { shipment, order } of chunk) {
        const ok = valid.get(shipment.barcode);
        if (ok) {
          db.updateShipment(shipment.id, {
            status: 'BOOKED',
            errors: [],
            tariff: ok.calculated_tariff ?? null,
            booking_ref: response.mail_booking_dom_id ? String(response.mail_booking_dom_id) : null,
            booked_at: new Date().toISOString(),
          });
          const warnings = await afterBooking(ctx, shop, db.getShipment(shop, shipment.id), order, settings);
          results.push(result(db.getShipment(shop, shipment.id), { warnings }));
        } else {
          const errors = invalid.get(shipment.barcode)?.errors ?? ['Article missing from India Post booking response'];
          db.updateShipment(shipment.id, { status: 'ERROR', errors });
          results.push(result(db.getShipment(shop, shipment.id)));
        }
      }
    } catch (err) {
      logger.error(`[booking] ${shop}: ${err.message}`);
      for (const { shipment } of chunk) {
        db.updateShipment(shipment.id, { status: 'ERROR', errors: [err.message] });
        results.push(result(db.getShipment(shop, shipment.id)));
      }
    } finally {
      chunk.forEach((p) => inFlight.delete(p.lockKey));
    }
  }
  return results;
}

/** Label + Shopify fulfillment + metafields. Failures here are warnings; the booking stands. */
async function afterBooking(ctx, shop, shipment, order, settings) {
  const warnings = [];
  try {
    await generateLabel(ctx, shop, shipment, settings);
  } catch (err) {
    warnings.push(`Label: ${err.message}`);
  }

  if (settings.automation.autoFulfill) {
    try {
      const fulfillmentIds = await ctx.adminFor(shop).fulfillWithTracking(order, {
        number: shipment.barcode,
        url: ctx.trackingUrl(shop, shipment.barcode),
        notifyCustomer: settings.automation.notifyCustomer,
      });
      ctx.db.updateShipment(shipment.id, { fulfillment_ids: fulfillmentIds, shopify_status: 'CONFIRMED' });
    } catch (err) {
      warnings.push(`Shopify fulfillment: ${err.message}`);
    }
  }

  try {
    await syncShopifyMetafields(ctx, shop, ctx.db.getShipment(shop, shipment.id));
  } catch (err) {
    warnings.push(`Shopify metafields: ${err.message}`);
  }
  if (warnings.length) ctx.db.updateShipment(shipment.id, { errors: warnings });
  return warnings;
}

function labelPayload(shipment, settings) {
  if (!shipment.article) throw new BookingError(`Shipment ${shipment.barcode} has no booking data`);
  return buildLabel(shipment.article, settings, {
    tariff: shipment.tariff,
    bookingRef: shipment.booking_ref,
    bookedAt: shipment.booked_at,
  });
}

/** Generates and stores the label PDF for one booked shipment. */
export async function generateLabel(ctx, shop, shipment, settings = ctx.getSettings(shop)) {
  const pdf = await ctx.indiaPostFor(shop, settings).createLabels([labelPayload(shipment, settings)]);
  const dir = path.join(ctx.config.labelDir, shop);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${shipment.barcode}.pdf`);
  await fs.writeFile(file, pdf);
  ctx.db.updateShipment(shipment.id, { label_path: file });
  return pdf;
}

/** One PDF for the given shipments (cached file when a single label already exists). */
export async function labelsPdf(ctx, shop, shipmentIds) {
  const shipments = ctx.db.listShipmentsByIds(shop, shipmentIds).filter((s) => s.booked_at);
  if (!shipments.length) throw new BookingError('No booked shipments selected');
  if (shipments.length === 1) {
    const [s] = shipments;
    if (s.label_path) {
      try {
        return await fs.readFile(s.label_path);
      } catch {
        // fall through and regenerate
      }
    }
    return generateLabel(ctx, shop, s);
  }
  const settings = ctx.getSettings(shop);
  return ctx.indiaPostFor(shop, settings).createLabels(shipments.map((s) => labelPayload(s, settings)));
}
