import axios from 'axios';
import { log } from './logger.js';

const SHOP_NAME = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

// This app only ever issues client_credentials tokens that expire in
// ~24h (confirmed via direct curl exchange — there is no permanent
// token option for this app type). So instead of reading a static
// SHOPIFY_ADMIN_TOKEN from env (which required manual regeneration
// every ~24h and broke things repeatedly), this file now fetches and
// caches its own token the same way shopify-client.js already does
// for the rates path, refreshing well before real expiry and
// retrying once on a 401/403 mid-request.
let cachedAccessToken = null;
let tokenFetchedAt = 0;

// Shopify's client_credentials tokens for this app expire in ~86400s
// (24h). Refresh well before that so we're never caught by a mid-flight
// expiry during normal traffic.
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

function isTokenFresh() {
  return cachedAccessToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS;
}

async function requestNewAccessToken() {
  if (!SHOP_NAME || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in env');
  }

  const url = `https://${SHOP_NAME}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const { data } = await axios.post(url, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    timeout: 10000,
  });

  const token = data?.access_token;
  if (!token) {
    throw new Error('Shopify token response missing access_token');
  }

  cachedAccessToken = token;
  tokenFetchedAt = Date.now();

  log.info('Fetched new Shopify Admin access token (shopify.js)', {
    expiresInSec: data?.expires_in,
    scope: data?.scope,
  });

  return token;
}

async function getAccessToken() {
  if (isTokenFresh()) return cachedAccessToken;
  return requestNewAccessToken();
}

/**
 * Builds an axios client with a fresh (or cached) token. Since the
 * token can expire mid-session, callers should use `adminRequest`
 * below rather than calling this directly when they want automatic
 * retry-on-401 behavior.
 */
async function adminClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: `https://${SHOP_NAME}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

/**
 * Runs a Shopify Admin API request, refreshing the token and retrying
 * once if the first attempt fails with 401/403. `requestFn` receives
 * an axios instance and should return the axios promise directly
 * (e.g. `(client) => client.get('/orders/123.json')`).
 */
async function adminRequest(requestFn, { retryOnAuthError = true } = {}) {
  const client = await adminClient();

  try {
    return await requestFn(client);
  } catch (err) {
    const status = err?.response?.status;

    if ((status === 401 || status === 403) && retryOnAuthError) {
      log.warn('Shopify token rejected, refreshing token and retrying once (shopify.js)', {
        status,
      });

      await requestNewAccessToken();
      const freshClient = await adminClient();
      return requestFn(freshClient);
    }

    throw err;
  }
}

export async function getOrder(orderId) {
  const { data } = await adminRequest((client) => client.get(`/orders/${orderId}.json`));
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
    const { data } = await adminRequest((client) => client.post('/fulfillments.json', body));
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
  const { data } = await adminRequest((client) => client.get(`/orders/${orderId}/fulfillment_orders.json`));
  return data.fulfillment_orders || [];
}

/**
 * Returns existing fulfillments (already created ones, with
 * tracking info) for an order. Used by order-paid-handler.js to check
 * whether a CAEX guide already exists before calling generateGuide()
 * again, so a duplicate webhook delivery doesn't create two guides for
 * the same order.
 */
export async function getFulfillments(orderId) {
  const { data } = await adminRequest((client) => client.get(`/orders/${orderId}/fulfillments.json`));
  return data.fulfillments || [];
}

/**
 * Returns an order's metafields. The invoice UUID from the
 * separate certification service might live here instead of in
 * note_attributes (note_attributes are usually set at checkout time;
 * a metafield is more typical for something written back by a
 * different service after the order already exists).
 */
export async function getOrderMetafields(orderId) {
  const { data } = await adminRequest((client) => client.get(`/orders/${orderId}/metafields.json`));
  return data.metafields || [];
}
