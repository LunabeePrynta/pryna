// Manual India Post shipments: the merchant books the parcel with India Post themselves and types the
// article (tracking) number here. The app saves it with the shipment details, fulfils the Shopify order
// with the tracking number, and keeps everything for the Excel export.

import { isValidBarcode, normalizeBarcode } from '../indiapost/barcode.js';
import { buildArticle, sanitizeOverrides } from '../indiapost/mapper.js';
import { refreshShipments, syncShopifyMetafields } from './tracking.js';

export class ShipmentError extends Error {}

// Problems that only matter for API booking (shop-level India Post account details) are not shown per order.
const ACCOUNT_ONLY = /India Post customer id|contract id|office id|Settings: sender/;

/** Validates an India Post article number such as EB123456785IN. */
export function checkTrackingNumber(value) {
  const number = normalizeBarcode(value);
  if (!number) throw new ShipmentError('Enter the India Post tracking number');
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)) {
    throw new ShipmentError(`"${number}" is not a valid India Post tracking number (format: 2 letters, 9 digits, 2 letters, e.g. EB123456785IN)`);
  }
  if (!isValidBarcode(number)) {
    throw new ShipmentError(`"${number}" fails the India Post check digit — please re-check the number for a typo`);
  }
  return number;
}

/** YYYY-MM-DD (India) → ISO timestamp at 12:00 IST; empty → now. */
export function bookingTimestamp(date) {
  if (!date) return new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new ShipmentError('Booking date must be a valid date');
  const ts = new Date(`${date}T12:00:00+05:30`);
  if (Number.isNaN(ts.getTime())) throw new ShipmentError('Booking date must be a valid date');
  return ts.toISOString();
}

function orderWarnings(errors) {
  return errors.filter((e) => !ACCOUNT_ONLY.test(e));
}

/** Everything the "Create order" form needs, prefilled from the Shopify order. */
export async function orderDraft(ctx, shop, orderId, overrides) {
  const settings = ctx.getSettings(shop);
  const order = await ctx.adminFor(shop).getOrder(orderId);
  if (!order) throw new ShipmentError('Order not found in Shopify');
  const clean = sanitizeOverrides(overrides);
  const shipment = ctx.db.getShipmentByOrder(shop, orderId);
  const { article, errors } = buildArticle(order, settings, shipment?.barcode ?? '', clean);
  const address = { ...(order.shippingAddress ?? {}), ...(clean.receiver ?? {}) };
  return {
    order: {
      id: order.id,
      name: order.name,
      createdAt: order.createdAt,
      email: order.email,
      total: order.totalAmount,
      currency: order.currency,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      weightGrams: order.totalWeightGrams,
      canFulfill: order.fulfillmentOrders.some((fo) => fo.actions.includes('CREATE_FULFILLMENT')),
    },
    form: {
      receiver: {
        name: address.name ?? '',
        company: address.company ?? '',
        address1: address.address1 ?? '',
        address2: address.address2 ?? '',
        city: address.city ?? '',
        province: address.province ?? '',
        zip: address.zip ?? '',
        phone: article.receiver_mobile_no || address.phone || '',
      },
      product: clean.product ?? settings.product,
      weightGrams: article.physical_weight,
      dimensions: {
        length: Number(article.length),
        breadth: Number(article.breadth_diameter),
        height: Number(article.height),
      },
      codAmount: Number(article.value_for_codr_cod) || 0,
      insuranceValue: Number(article.value_of_insurance) || 0,
    },
    articleType: article.article_type,
    warnings: orderWarnings(errors),
    shipment,
  };
}

/**
 * Saves the tracking number for an order and fulfils it in Shopify.
 * Calling it again for the same order updates the tracking number / details.
 */
export async function saveShipment(ctx, shop, orderId, { trackingNumber, bookingDate, overrides } = {}) {
  const { db } = ctx;
  const number = checkTrackingNumber(trackingNumber);
  const bookedAt = bookingTimestamp(bookingDate);

  const usedBy = db.getShipmentByBarcode(shop, number);
  if (usedBy && usedBy.order_id !== orderId) {
    throw new ShipmentError(`Tracking number ${number} is already used on order ${usedBy.order_name}`);
  }

  const settings = ctx.getSettings(shop);
  const admin = ctx.adminFor(shop);
  const order = await admin.getOrder(orderId);
  if (!order) throw new ShipmentError('Order not found in Shopify');

  const { article, errors } = buildArticle(order, settings, number, sanitizeOverrides(overrides));
  const warnings = orderWarnings(errors);

  let shipment = db.getShipmentByOrder(shop, orderId);
  const numberChanged = shipment && shipment.barcode !== number;
  if (!shipment) {
    shipment = db.createShipment({ shop, orderId, orderName: order.name, customerId: order.customer?.id, barcode: number, status: 'BOOKED' });
  } else if (numberChanged) {
    // A corrected number starts a fresh tracking history.
    db.deleteEvents(shipment.id);
    db.updateShipment(shipment.id, { status: 'BOOKED', shopify_status: null, last_event: null, last_event_at: null, last_polled_at: null });
  }
  db.updateShipment(shipment.id, {
    barcode: number,
    article,
    article_type: article.article_type,
    order_name: order.name,
    customer_id: order.customer?.id ?? null,
    booked_at: bookedAt,
    status: ['PENDING', 'BOOKING', 'ERROR'].includes(shipment.status) ? 'BOOKED' : shipment.status,
  });
  shipment = db.getShipment(shop, shipment.id);

  // Shopify: fulfil with the tracking number, or correct the number on the existing fulfillment.
  const tracking = {
    number,
    url: ctx.trackingUrl(shop, number),
    notifyCustomer: settings.automation.notifyCustomer,
  };
  try {
    if (shipment.fulfillment_ids.length) {
      if (numberChanged) await admin.updateTracking(shipment.fulfillment_ids, tracking);
    } else {
      const ids = await admin.fulfillWithTracking(order, tracking);
      if (ids.length) db.updateShipment(shipment.id, { fulfillment_ids: ids, shopify_status: 'CONFIRMED' });
      else warnings.push('The order has nothing left to fulfil in Shopify, so the tracking number was saved in the app only.');
    }
  } catch (err) {
    warnings.push(`Shopify fulfilment failed: ${err.message}`);
  }

  try {
    await syncShopifyMetafields(ctx, shop, db.getShipment(shop, shipment.id));
  } catch (err) {
    ctx.logger.error(`[shipments] metafields ${shop} ${number}: ${err.message}`);
  }

  db.updateShipment(shipment.id, { errors: warnings });

  // With India Post tracking configured, fetch the article's status straight away.
  if (ctx.hasTracking(shop, settings)) {
    try {
      await refreshShipments(ctx, shop, [db.getShipment(shop, shipment.id)]);
    } catch (err) {
      ctx.logger.error(`[shipments] tracking ${shop} ${number}: ${err.message}`);
    }
  }
  return { shipment: db.getShipment(shop, shipment.id), warnings };
}
