import axios from 'axios';
const SHOP_NAME = process.env.SHOPIFY_SHOP;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
function adminClient() {
  return axios.create({
    baseURL: `https://${SHOP_NAME}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}
export async function getOrder(orderId) {
  const client = adminClient();
  const { data } = await client.get(`/orders/${orderId}.json`);
  return data.order;
}
/**
 * Creates a Shopify fulfillment with tracking info, scoped to specific
 * line item(s) within a fulfillment order.
 *
 * Since CAEX's GenerarGuia is called once PER LINE ITEM (per CAEX's own
 * spec), a multi-item order produces multiple separate tracking
 * numbers — one per product. Shopify's fulfillment-order-based API
 * only supports a single tracking_info.number/url per fulfillment call
 * (the plural tracking_info.numbers/urls fields used in an earlier
 * version of this function were never actually confirmed to work on
 * this API and were silently producing fulfillments with no tracking
 * info at all on multi-item orders). The correct approach is one
 * fulfillment call PER line item, each scoped via
 * fulfillmentOrderLineItems so Shopify shows a separate fulfillment
 * card with its own tracking number per product.
 *
 * Pass `fulfillmentOrderLineItems` (array of { id, quantity }, using
 * the FULFILLMENT ORDER's line item id, not the order's line item id)
 * to scope to specific products. Omit it to fulfill the whole
 * fulfillment order at once (single-item orders, or if scoping isn't
 * needed).
 */
export async function createFulfillmentWithTracking({
  orderId,
  fulfillmentOrderId,
  fulfillmentOrderLineItems,
  trackingNumber,
  trackingUrl,
  trackingCompany = 'CAEX',
}) {
  const client = adminClient();

  const lineItemsByFulfillmentOrder = fulfillmentOrderLineItems
    ? { fulfillment_order_id: fulfillmentOrderId, fulfillment_order_line_items: fulfillmentOrderLineItems }
    : { fulfillment_order_id: fulfillmentOrderId };

  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: [lineItemsByFulfillmentOrder],
      tracking_info: {
        number: trackingNumber,
        url: trackingUrl,
        company: trackingCompany,
      },
      notify_customer: false,
    },
  };
  try {
    const { data } = await client.post('/fulfillments.json', body);
    return data;
  } catch (err) {
    // Attach Shopify's actual error body to the error so callers can log
    // the real reason (e.g. "already fulfilled") instead of just "422".
    if (err.response) {
      err.shopifyError = err.response.data;
    }
    throw err;
  }
}
export async function getFulfillmentOrders(orderId) {
  const client = adminClient();
  const { data } = await client.get(`/orders/${orderId}/fulfillment_orders.json`);
  return data.fulfillment_orders || [];
}

/**
 * NEW — returns existing fulfillments (already created ones, with
 * tracking info) for an order. Used by order-paid-handler.js to check
 * whether a CAEX guide already exists before calling generateGuide()
 * again, so a duplicate webhook delivery doesn't create two guides for
 * the same order.
 */
export async function getFulfillments(orderId) {
  const client = adminClient();
  const { data } = await client.get(`/orders/${orderId}/fulfillments.json`);
  return data.fulfillments || [];
}

/**
 * NEW — returns an order's metafields. The invoice UUID from the
 * separate certification service might live here instead of in
 * note_attributes (note_attributes are usually set at checkout time;
 * a metafield is more typical for something written back by a
 * different service after the order already exists).
 */
export async function getOrderMetafields(orderId) {
  const client = adminClient();
  const { data } = await client.get(`/orders/${orderId}/metafields.json`);
  return data.metafields || [];
}
