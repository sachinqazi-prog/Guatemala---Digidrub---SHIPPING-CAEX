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
 * Creates a Shopify fulfillment with tracking info. Accepts one or more
 * tracking numbers/URLs — since CAEX's GenerarGuia is now called once
 * PER LINE ITEM (per CAEX's own spec), a single order can produce
 * several tracking numbers, one per product. Uses Shopify's plural
 * tracking_info.numbers/urls fields when there's more than one;
 * falls back to the singular number/url fields for the common
 * single-item case (known to work from earlier testing).
 */
export async function createFulfillmentWithTracking({
  orderId,
  fulfillmentOrderId,
  trackingNumbers,
  trackingUrls,
  trackingCompany = 'CAEX',
}) {
  const client = adminClient();
  const numbers = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers].filter(Boolean);
  const urls = Array.isArray(trackingUrls) ? trackingUrls : [trackingUrls].filter(Boolean);

  const trackingInfo =
    numbers.length > 1
      ? { numbers, urls, company: trackingCompany }
      : { number: numbers[0], url: urls[0], company: trackingCompany };

  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: [
        {
          fulfillment_order_id: fulfillmentOrderId,
        },
      ],
      tracking_info: trackingInfo,
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
