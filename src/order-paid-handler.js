import crypto from 'node:crypto';
import {
  getOrder,
  getFulfillmentOrders,
  getFulfillments,
  createFulfillmentWithTracking,
} from './shopify.js';
import { getServiceCodeMeta } from './shipping-rules.js';
import { generateGuide } from './caex.js';
import { resolveDepartamento } from './province-mapping.js';
import { findPobladoCode } from './poblado-lookup.js';
import { log } from './logger.js';

function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // allow in local dev if not set
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const rawBody = req.rawBody || '';
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader || '')
  );
}

function getChosenServiceCode(order) {
  const shippingLine = order?.shipping_lines?.[0];
  return shippingLine?.code || shippingLine?.source || null;
}

function buildGuidePayload(order) {
  const shippingAddress = order?.shipping_address || {};
  const deptCode = resolveDepartamento({
    province: shippingAddress?.province,
    province_code: shippingAddress?.province_code,
  });
  const destPobladoCode = findPobladoCode(shippingAddress?.city, deptCode);
  return {
    orderId: order.id,
    codigoDespacho: 8,
    customerName:
      `${shippingAddress?.first_name || ''} ${shippingAddress?.last_name || ''}`.trim() ||
      order?.customer?.first_name ||
      order?.email ||
      'Cliente Shopify',
    phone: shippingAddress?.phone || order?.phone || '',
    email: order?.email || '',
    address1: shippingAddress?.address1 || '',
    address2: shippingAddress?.address2 || '',
    city: shippingAddress?.city || '',
    province: shippingAddress?.province || '',
    deptCode,
    destPobladoCode,
    reference: order?.name || String(order?.id),
    amount: order?.total_price || '0',
  };
}

/**
 * Simple sleep helper for the retry loop below.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-process lock. Prevents the exact race condition seen in testing:
 * Shopify delivered the same order-paid webhook twice within ~7 seconds
 * (likely a retry after our handler took too long to respond). Both
 * deliveries passed the "does a guide already exist?" check before
 * either had finished — the Shopify-based check alone isn't enough to
 * stop two requests that are in flight at the same time. This Set
 * blocks a second concurrent run for the same order while the first is
 * still working. It resets on restart, which is fine — the persisted
 * Shopify check (alreadyHasCaexGuide) still catches true duplicates
 * across restarts; this only needs to catch same-process races.
 */
const processingOrders = new Set();

/**
 * Shopify fulfillment orders aren't always ready the instant an order
 * webhook fires. Retry a few times with a short delay before giving up.
 */
async function getFulfillmentOrdersWithRetry(orderId, { attempts = 4, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const fulfillmentOrders = await getFulfillmentOrders(orderId);
    if (fulfillmentOrders.length > 0) {
      return fulfillmentOrders;
    }
    log.info('No fulfillment orders yet — retrying', {
      orderId,
      attempt: i + 1,
      attempts,
    });
    if (i < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return [];
}

/**
 * Dedup guard: check Shopify itself for an existing CAEX fulfillment on
 * this order before calling generateGuide() again. Survives restarts,
 * unlike an in-memory-only flag.
 */
async function alreadyHasCaexGuide(orderId) {
  const fulfillments = await getFulfillments(orderId);
  return fulfillments.some(
    (f) => (f.tracking_company || '').toUpperCase() === 'CAEX' && f.tracking_number
  );
}

/**
 * Pulls the useful part out of a failed axios call — Shopify's 4xx/5xx
 * responses carry a JSON body explaining exactly what was wrong
 * (e.g. {"errors":"..."}), which err.message alone never shows. Every
 * catch block below should log through this instead of err.message.
 */
function describeAxiosError(err) {
  if (err?.response) {
    return {
      status: err.response.status,
      body: err.response.data,
    };
  }
  return { message: err?.message || String(err) };
}

/**
 * The actual guide-generation + fulfillment work, split out so it can
 * run AFTER we've already responded 200 to Shopify (see handleOrderPaid
 * below). Keeping Shopify's webhook response fast prevents it from
 * treating a slow CAEX/Shopify round-trip as a timeout and re-delivering
 * the same webhook — which is what caused the duplicate-guide race seen
 * in testing.
 */
async function processGuideGeneration(order, meta) {
  const orderId = order.id;

  if (processingOrders.has(orderId)) {
    log.info('Order already being processed in this run — skipping duplicate', { orderId });
    return;
  }
  processingOrders.add(orderId);

  try {
    if (await alreadyHasCaexGuide(orderId)) {
      log.info('CAEX guide already exists for this order — skipping duplicate call', {
        orderId,
        orderName: order?.name,
      });
      return;
    }

    const guideInput = buildGuidePayload(order);

    let guideResult;
    try {
      guideResult = await generateGuide(guideInput);
    } catch (err) {
      log.error('generateGuide failed', { orderId, ...describeAxiosError(err) });
      return;
    }

    if (!guideResult.success) {
      // CAEX responded but declined to create the guide (a business
      // rule rejection, e.g. "same-day delivery not available for this
      // town" — not a schema/auth error, so it doesn't throw). This was
      // previously falling through and marking the order fulfilled with
      // no real guide behind it. Stop here instead.
      log.error('CAEX declined to generate guide', {
        orderId,
        error: guideResult.error,
        code: guideResult.code,
      });
      return;
    }

    const fulfillmentOrders = await getFulfillmentOrdersWithRetry(orderId);
    const firstFulfillmentOrder = fulfillmentOrders[0];

    if (!firstFulfillmentOrder) {
      log.warn('Guide created but no fulfillment order found after retries', {
        orderId,
        trackingNumber: guideResult.trackingNumber,
      });
      return;
    }

    try {
      await createFulfillmentWithTracking({
        orderId,
        fulfillmentOrderId: firstFulfillmentOrder.id,
        trackingNumber: guideResult.trackingNumber,
        trackingUrl: guideResult.trackingUrl,
      });
    } catch (err) {
      log.error('createFulfillmentWithTracking failed', { orderId, ...describeAxiosError(err) });
      return;
    }

    log.info('Guide created and fulfillment updated', {
      orderId,
      trackingNumber: guideResult.trackingNumber,
    });
  } finally {
    processingOrders.delete(orderId);
  }
}

export async function handleOrderPaid(req, res) {
  try {
    if (!verifyShopifyWebhook(req)) {
      log.warn('Invalid Shopify webhook signature');
      return res.status(401).send('Invalid signature');
    }

    const webhookOrder = req.body;
    const orderId = webhookOrder?.id;
    if (!orderId) {
      return res.status(400).send('Missing order id');
    }

    const order = await getOrder(orderId);

    // Safety check: this handler also gets called from the "Order
    // creation" webhook topic, which fires BEFORE payment is confirmed.
    // Bail out early if the order isn't actually paid yet.
    if (order?.financial_status !== 'paid') {
      log.info('Order not yet paid — skipping guide generation', {
        orderId,
        orderName: order?.name,
        financialStatus: order?.financial_status,
      });
      return res.status(200).send('Order not paid yet');
    }

    const serviceCode = getChosenServiceCode(order);

    log.info('Order paid webhook received', {
      orderId,
      orderName: order?.name,
      serviceCode,
    });

    const meta = getServiceCodeMeta(serviceCode);
    if (!meta) {
      log.warn('Unknown service code on paid order', { orderId, serviceCode });
      return res.status(200).send('Unknown service code');
    }

    if (!meta.shouldGenerateGuide) {
      log.info('No CAEX guide needed for this order', {
        orderId,
        serviceCode,
        codigoDespacho: meta.codigoDespacho,
      });
      return res.status(200).send('No guide required');
    }

    // Respond to Shopify NOW. The remaining work (CAEX SOAP call +
    // Shopify fulfillment update) can take several seconds, and a slow
    // response was very likely why Shopify re-delivered this webhook in
    // testing, which raced two guide-generation attempts against each
    // other. Everything after this point runs in the background — the
    // in-process lock and the Shopify-based dedup check inside
    // processGuideGeneration still protect against duplicates even if
    // Shopify sends this webhook again anyway.
    res.status(200).send('Accepted');

    processGuideGeneration(order, meta).catch((err) => {
      log.error('processGuideGeneration crashed', { orderId, ...describeAxiosError(err) });
    });
    return;
  } catch (err) {
    log.error('order-paid webhook failed', { ...describeAxiosError(err), stack: err.stack });
    return res.status(500).send('Webhook failed');
  }
}
