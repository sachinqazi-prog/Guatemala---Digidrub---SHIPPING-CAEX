import crypto from 'node:crypto';
import { getOrder, getFulfillmentOrders, createFulfillmentWithTracking } from './shopify.js';
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
  // Primary source: shipping_lines[0].code
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

    const guideInput = buildGuidePayload(order);
    const guideResult = await generateGuide(guideInput);

    const fulfillmentOrders = await getFulfillmentOrders(orderId);
    const firstFulfillmentOrder = fulfillmentOrders[0];

    if (!firstFulfillmentOrder) {
      log.warn('Guide created but no fulfillment order found', {
        orderId,
        trackingNumber: guideResult.trackingNumber,
      });
      return res.status(200).send('Guide created; no fulfillment order found');
    }

    await createFulfillmentWithTracking({
      orderId,
      fulfillmentOrderId: firstFulfillmentOrder.id,
      trackingNumber: guideResult.trackingNumber,
      trackingUrl: guideResult.trackingUrl,
    });

    log.info('Guide created and fulfillment updated', {
      orderId,
      trackingNumber: guideResult.trackingNumber,
    });

    return res.status(200).send('OK');
  } catch (err) {
    log.error('order-paid webhook failed', err.stack || err.message);
    return res.status(500).send('Webhook failed');
  }
}