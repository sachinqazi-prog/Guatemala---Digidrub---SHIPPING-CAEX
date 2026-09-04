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

/**
 * Shopify order note_attributes are just an array of {name, value}
 * pairs — turn that into a lookup map so specific fields can be pulled
 * out by name.
 */
function noteAttributesMap(order) {
  const attrs = order?.note_attributes || [];
  const map = {};
  for (const attr of attrs) {
    if (attr?.name) map[attr.name] = attr.value;
  }
  return map;
}

/**
 * Builds ONE generateGuide() payload per shippable line item on the
 * order — per CAEX's own spec, GenerarGuia must be called once per
 * invoiced product, not once per order.
 *
 * Field sourcing, matched against CAEX's official "Explanation of the
 * GenerarGuia method" document:
 *
 * CONFIRMED / correct:
 * - RecoleccionID = "{orderNumber}-{productNumber}"
 * - DestinatarioNombre, DestinatarioDireccion (street only), Telefono
 * - DestinatarioContacto = same value as RecoleccionID
 * - ReferenciaCliente1 = "{sku} - {productName}"
 * - CodigoPobladoDestino = precise CAEX poblado from order note attrs
 *
 * STILL UNCONFIRMED — using a reasonable fallback, flagged clearly:
 * - DestinatarioNIT: spec says this must be the real customer NIT from
 *   the "Datos para Factura Electrónica (FEL)" window. We've seen a
 *   "NIT" note attribute on real orders (e.g. order #1102's Additional
 *   Details showed NIT: 2241839151202). Using notes['NIT'] here, with
 *   'CF' as fallback if absent — CONFIRM this note attribute key name
 *   is right; if guides still fail on NIT, check the exact key.
 * - ReferenciaCliente2 (Invoice UUID): spec says this must be the FEL
 *   invoice UUID, which lives in the SEPARATE certification/invoicing
 *   service, not this shipping middleware. No confirmed way to fetch
 *   it here yet — sending empty string as a placeholder. This should
 *   be revisited: either that service needs to write the UUID onto the
 *   order (e.g. as a note attribute, similar to NIT/_caex_poblado_id),
 *   or this handler needs to call that service's API directly.
 * - Cantidad_de_piezas / weight ("Ashley Direct"): spec says piece
 *   count comes from a Products API and weight from "Ashley Direct" —
 *   neither is integrated here. Falling back to 1 piece, weight from
 *   Shopify's own line_item.grams (converted to kg). Revisit once the
 *   real Products API / Ashley Direct integration is available.
 */
function buildLineItemGuidePayloads(order) {
  const shippingAddress = order?.shipping_address || {};
  const notes = noteAttributesMap(order);

  const preciseDeptCode = notes['_caex_departamento_id'];
  const precisePobladoCode = notes['_caex_poblado_id'];

  let destPobladoCode;
  if (preciseDeptCode && precisePobladoCode) {
    destPobladoCode = precisePobladoCode;
    log.info('Using precise CAEX poblado from order note attributes', {
      orderId: order.id,
      destPobladoCode,
      pobladoName: notes['_caex_poblado_name'],
    });
  } else {
    const deptCode = resolveDepartamento({
      province: shippingAddress?.province,
      province_code: shippingAddress?.province_code,
    });
    destPobladoCode = findPobladoCode(shippingAddress?.city, deptCode);
    log.info('No precise CAEX poblado on order — using fuzzy city match', {
      orderId: order.id,
      city: shippingAddress?.city,
      deptCode,
      destPobladoCode,
    });
  }

  const customerName =
    `${shippingAddress?.first_name || ''} ${shippingAddress?.last_name || ''}`.trim() ||
    order?.customer?.first_name ||
    order?.email ||
    'Cliente Shopify';
  const phone = shippingAddress?.phone || order?.phone || '';
  const address1 = shippingAddress?.address1 || '';

  const nit = notes['NIT'];
  if (!nit) {
    log.warn('No NIT note attribute found on order — sending CF', { orderId: order.id });
  }

  const invoiceUuid = notes['Invoice UUID'] || notes['_invoice_uuid'] || notes['invoice_uuid'] || '';
  if (!invoiceUuid) {
    log.warn('No invoice UUID available for order — CAEX ReferenciaCliente2 will be blank. All note attributes on this order:', {
      orderId: order.id,
      noteAttributes: notes,
    });
  }

  const orderNumber = order?.order_number || String(order?.name || order?.id).replace('#', '');

  const shippableItems = (order?.line_items || []).filter((li) => li?.requires_shipping);

  return shippableItems.map((item, index) => {
    const productNumber = String(index + 1).padStart(2, '0');
    const pesoTotalKg = item?.grams ? item.grams / 1000 : 1;

    return {
      lineItemId: item.id, // needed to scope the Shopify fulfillment to just this product
      quantity: item.quantity,
      orderNumber,
      productNumber,
      customerName,
      address1,
      phone,
      nit,
      sku: item?.sku || '',
      productName: item?.name || item?.title || '',
      invoiceUuid,
      destPobladoCode,
      cantidadPiezas: item.quantity || 1, // uses the real ordered quantity — TODO: replace with Products API's actual Cantidad_de_piezas once available, in case a single unit legitimately ships as multiple physical pieces
      pesoTotalKg,
    };
  });
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

    // The invoicing/certification service runs on the SAME trigger
    // (order placement) and writes the invoice UUID back onto the order
    // shortly after — but it's not guaranteed to have finished by the
    // time our webhook fires, since it involves its own network round
    // trip (fetch transactions, ConsultaNIT, certify, write back). Re-
    // fetch the order a few times, giving it a chance to catch up,
    // before building the guide payloads. We're already running in the
    // background after acking Shopify, so this delay is safe.
    //
    // Confirmed on order #1138: the UUID existed on the order but
    // arrived AFTER our old ~9s window (3 attempts x 3s) gave up,
    // leaving ReferenciaCliente2 blank on an otherwise-successful
    // guide. Widened to ~40s (7 attempts x ~5.7s) to cover that gap.
    let freshOrder = order;
    const uuidRetryAttempts = 7;
    const uuidRetryDelayMs = 5700;
    for (let i = 0; i < uuidRetryAttempts; i++) {
      const notes = noteAttributesMap(freshOrder);
      const hasUuid = notes['Invoice UUID'] || notes['_invoice_uuid'] || notes['invoice_uuid'];
      if (hasUuid) break;
      log.info('Invoice UUID not yet on order — waiting for invoicing service, retrying', {
        orderId,
        attempt: i + 1,
        attempts: uuidRetryAttempts,
      });
      await sleep(uuidRetryDelayMs);
      freshOrder = await getOrder(orderId);
    }

    const lineItemPayloads = buildLineItemGuidePayloads(freshOrder);
    if (lineItemPayloads.length === 0) {
      log.warn('No shippable line items found on order — nothing to generate', { orderId });
      return;
    }

    // Call generateGuide once PER LINE ITEM, sequentially (not
    // parallel) — safer against CAEX's SOAP service, and easier to
    // read in logs when debugging. Keep each result paired with the
    // payload that produced it, so we can match it back to the right
    // Shopify line item afterward.
    const successes = [];
    for (const payload of lineItemPayloads) {
      let result;
      try {
        result = await generateGuide(payload);
      } catch (err) {
        log.error('generateGuide failed for line item', {
          orderId,
          recoleccionId: `${payload.orderNumber}-${payload.productNumber}`,
          ...describeAxiosError(err),
        });
        continue;
      }

      if (!result.success) {
        log.error('CAEX declined to generate guide for line item', {
          orderId,
          recoleccionId: `${payload.orderNumber}-${payload.productNumber}`,
          error: result.error,
          code: result.code,
        });
        continue;
      }

      successes.push({ payload, result });
    }

    if (successes.length === 0) {
      log.error('No guides were successfully generated for this order', { orderId });
      return;
    }

    if (successes.length < lineItemPayloads.length) {
      log.warn('Some line items failed to get a CAEX guide — order partially fulfilled', {
        orderId,
        succeeded: successes.length,
        total: lineItemPayloads.length,
      });
    }

    const fulfillmentOrders = await getFulfillmentOrdersWithRetry(orderId);
    if (fulfillmentOrders.length === 0) {
      log.warn('Guide(s) created but no fulfillment order found after retries', {
        orderId,
        trackingNumbers: successes.map((s) => s.result.trackingNumber),
      });
      return;
    }

    // Build a lookup from Shopify's original line_item.id to the
    // matching fulfillment-order line item (id + fulfillable quantity).
    // A fulfillment order's line items carry `line_item_id`, which
    // points back to the order's own line item — that's the join key.
    const focLineItemByOrderLineItemId = new Map();
    for (const fo of fulfillmentOrders) {
      for (const li of fo?.line_items || []) {
        focLineItemByOrderLineItemId.set(String(li.line_item_id), {
          fulfillmentOrderId: fo.id,
          focLineItemId: li.id,
          quantity: li.fulfillable_quantity ?? li.quantity,
        });
      }
    }

    // One Shopify fulfillment PER successful CAEX guide, each scoped to
    // just that product, each with its own single tracking number.
    // This matches how Shopify actually displays multiple trackings on
    // one order (one fulfillment card per shipment) — trying to cram
    // several tracking numbers into one fulfillment via plural fields
    // isn't supported by this API and was silently producing no
    // tracking info at all on multi-item orders.
    const fulfilled = [];
    const unmatched = [];
    for (const { payload, result } of successes) {
      const match = focLineItemByOrderLineItemId.get(String(payload.lineItemId));
      if (!match) {
        log.warn('No matching fulfillment-order line item found for CAEX guide — skipping', {
          orderId,
          lineItemId: payload.lineItemId,
          trackingNumber: result.trackingNumber,
        });
        unmatched.push(result.trackingNumber);
        continue;
      }

      try {
        await createFulfillmentWithTracking({
          orderId,
          fulfillmentOrderId: match.fulfillmentOrderId,
          fulfillmentOrderLineItems: [{ id: match.focLineItemId, quantity: match.quantity }],
          trackingNumber: result.trackingNumber,
          trackingUrl: result.trackingUrl,
        });
        fulfilled.push(result.trackingNumber);
      } catch (err) {
        log.error('createFulfillmentWithTracking failed for line item', {
          orderId,
          lineItemId: payload.lineItemId,
          trackingNumber: result.trackingNumber,
          ...describeAxiosError(err),
        });
      }
    }

    log.info('Guide(s) created and fulfillment(s) updated', {
      orderId,
      fulfilled,
      unmatched,
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
