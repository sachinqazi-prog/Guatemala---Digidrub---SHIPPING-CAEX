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
export async function createFulfillmentWithTracking({
  orderId,
  fulfillmentOrderId,
  trackingNumber,
  trackingCompany = 'CAEX',
  trackingUrl,
}) {
  const client = adminClient();
  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: [
        {
          fulfillment_order_id: fulfillmentOrderId,
        },
      ],
      tracking_info: {
        number: trackingNumber,
        company: trackingCompany,
        url: trackingUrl,
      },
      notify_customer: false,
    },
  };
  const { data } = await client.post('/fulfillments.json', body);
  return data;
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
