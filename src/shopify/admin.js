// Shopify Admin GraphQL helpers used by the app.

export class ShopifyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ShopifyError';
    this.details = details;
  }
}

const ORDER_FIELDS = `
  fragment OrderFields on Order {
    id
    name
    createdAt
    email
    phone
    displayFinancialStatus
    displayFulfillmentStatus
    paymentGatewayNames
    totalWeight
    totalPriceSet { shopMoney { amount currencyCode } }
    totalOutstandingSet { shopMoney { amount } }
    shippingAddress { name company address1 address2 city province zip phone countryCodeV2 }
    customer { id displayName defaultPhoneNumber { phoneNumber } }
  }
`;

const RECENT_ORDERS = `
  ${ORDER_FIELDS}
  query RecentOrders($first: Int!, $query: String) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes { ...OrderFields }
    }
  }
`;

const ORDER_FOR_SHIPPING = `
  ${ORDER_FIELDS}
  query OrderForShipping($id: ID!) {
    order(id: $id) {
      ...OrderFields
      fulfillmentOrders(first: 20) {
        nodes { id status supportedActions { action } }
      }
    }
  }
`;

const CREATE_FULFILLMENT = `
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

const CREATE_FULFILLMENT_EVENT = `
  mutation CreateFulfillmentEvent($event: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $event) {
      fulfillmentEvent { id status }
      userErrors { field message }
    }
  }
`;

const UPDATE_TRACKING = `
  mutation UpdateTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const SHOP_INFO = `query ShopInfo { shop { name myshopifyDomain primaryDomain { url } } }`;

export function normalizeOrder(node) {
  if (!node) return null;
  const a = node.shippingAddress;
  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    email: node.email,
    phone: node.phone,
    financialStatus: node.displayFinancialStatus,
    fulfillmentStatus: node.displayFulfillmentStatus,
    gateways: node.paymentGatewayNames ?? [],
    totalWeightGrams: Number(node.totalWeight) || 0,
    totalAmount: Number(node.totalPriceSet?.shopMoney?.amount ?? 0),
    currency: node.totalPriceSet?.shopMoney?.currencyCode,
    outstandingAmount: Number(node.totalOutstandingSet?.shopMoney?.amount ?? 0),
    shippingAddress: a
      ? {
          name: a.name,
          company: a.company,
          address1: a.address1,
          address2: a.address2,
          city: a.city,
          province: a.province,
          zip: a.zip,
          phone: a.phone,
          countryCode: a.countryCodeV2,
        }
      : null,
    customer: node.customer
      ? { id: node.customer.id, name: node.customer.displayName, phone: node.customer.defaultPhoneNumber?.phoneNumber }
      : null,
    fulfillmentOrders: (node.fulfillmentOrders?.nodes ?? []).map((fo) => ({
      id: fo.id,
      status: fo.status,
      actions: (fo.supportedActions ?? []).map((s) => s.action),
    })),
  };
}

export class ShopifyAdmin {
  constructor({ shop, accessToken, apiVersion, fetchImpl = fetch }) {
    this.shop = shop;
    this.accessToken = accessToken;
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
    this.fetch = fetchImpl;
  }

  async graphql(query, variables = {}, attempt = 0) {
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return this.graphql(query, variables, attempt + 1);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ShopifyError(`Shopify API ${res.status}`, body);
    if (body?.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        return this.graphql(query, variables, attempt + 1);
      }
      throw new ShopifyError(body.errors.map((e) => e.message).join('; '), body.errors);
    }
    return body.data;
  }

  async shopInfo() {
    return (await this.graphql(SHOP_INFO)).shop;
  }

  async recentOrders({ first = 50, query } = {}) {
    const data = await this.graphql(RECENT_ORDERS, { first, query: query || null });
    return data.orders.nodes.map(normalizeOrder);
  }

  async getOrder(id) {
    const data = await this.graphql(ORDER_FOR_SHIPPING, { id });
    return normalizeOrder(data.order);
  }

  /** Fulfils every open fulfillment order of the order with the India Post tracking number. */
  async fulfillWithTracking(order, { number, url, notifyCustomer }) {
    const open = order.fulfillmentOrders.filter((fo) => fo.actions.includes('CREATE_FULFILLMENT'));
    if (!open.length) return [];
    const ids = [];
    // fulfillmentCreate needs all fulfillment orders to share a location, so one call per fulfillment order.
    for (const fo of open) {
      const data = await this.graphql(CREATE_FULFILLMENT, {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
          trackingInfo: { company: 'India Post', number, url },
          notifyCustomer: Boolean(notifyCustomer),
        },
      });
      const { fulfillment, userErrors } = data.fulfillmentCreate;
      if (userErrors.length) throw new ShopifyError(userErrors.map((e) => e.message).join('; '), userErrors);
      ids.push(fulfillment.id);
    }
    return ids;
  }

  /** Replaces the tracking number on existing fulfillments (e.g. after a typo). */
  async updateTracking(fulfillmentIds, { number, url, notifyCustomer }) {
    for (const fulfillmentId of fulfillmentIds) {
      const data = await this.graphql(UPDATE_TRACKING, {
        fulfillmentId,
        trackingInfoInput: { company: 'India Post', number, url },
        notifyCustomer: Boolean(notifyCustomer),
      });
      const { userErrors } = data.fulfillmentTrackingInfoUpdate;
      if (userErrors.length) throw new ShopifyError(userErrors.map((e) => e.message).join('; '), userErrors);
    }
  }

  async createFulfillmentEvent(fulfillmentId, { status, message, happenedAt, city, zip }) {
    const data = await this.graphql(CREATE_FULFILLMENT_EVENT, {
      event: { fulfillmentId, status, message, happenedAt, city, zip, country: 'India' },
    });
    const { userErrors } = data.fulfillmentEventCreate;
    if (userErrors.length) throw new ShopifyError(userErrors.map((e) => e.message).join('; '), userErrors);
  }

  async setJsonMetafields(entries) {
    const metafields = entries
      .filter((e) => e.ownerId)
      .map((e) => ({ ownerId: e.ownerId, namespace: 'indiapost', key: e.key, type: 'json', value: JSON.stringify(e.value) }));
    if (!metafields.length) return;
    const data = await this.graphql(SET_METAFIELDS, { metafields });
    const { userErrors } = data.metafieldsSet;
    if (userErrors.length) throw new ShopifyError(userErrors.map((e) => e.message).join('; '), userErrors);
  }
}
