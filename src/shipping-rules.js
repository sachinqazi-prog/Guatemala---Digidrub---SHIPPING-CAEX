import { resolveDepartamento } from './province-mapping.js';
import { findPobladoCode } from './poblado-lookup.js';
import { getRate } from './caex.js';
import { getProductMetafields } from './shopify-client.js';
import { log } from './logger.js';

const GUATEMALA_DEPT_CODE = '07';
const FREE_SHIPPING_THRESHOLD_GTQ = Number(process.env.FREE_SHIPPING_THRESHOLD_GTQ || 250);

// Last-resort value when an item has no costo_de_envio metafield set.
// Used once per such line item (not multiplied by quantity).
const FALLBACK_COSTO_ENVIO_GTQ = Number(process.env.FALLBACK_COSTO_ENVIO_GTQ || 612);

export const SERVICE_CODES = {
  HOME_GUA_FREE: 'ASHLEY_HOME_GUA_FREE',
  HOME_GUA_PAID: 'ASHLEY_HOME_GUA_PAID',
  HOME_OTHER_CAEX: 'ASHLEY_HOME_OTHER_CAEX',
  PICKUP_STORE: 'ASHLEY_PICKUP_STORE',
};

export function getServiceCodeMeta(serviceCode) {
  switch (serviceCode) {
    case SERVICE_CODES.HOME_GUA_FREE:
      return { shippingChoice: 'home', codigoDespacho: 2, shouldGenerateGuide: false };
    case SERVICE_CODES.HOME_GUA_PAID:
      return { shippingChoice: 'home', codigoDespacho: 2, shouldGenerateGuide: false };
    case SERVICE_CODES.HOME_OTHER_CAEX:
      return { shippingChoice: 'home', codigoDespacho: 8, shouldGenerateGuide: true };
    case SERVICE_CODES.PICKUP_STORE:
      return { shippingChoice: 'pickup', codigoDespacho: 3, shouldGenerateGuide: false };
    default:
      return null;
  }
}

function getSubtotalGtq(items = []) {
  const subtotalMinor = items.reduce((sum, item) => {
    const price = Number(item.price || 0);
    const quantity = Number(item.quantity || 1);
    return sum + price * quantity;
  }, 0);
  return subtotalMinor / 100;
}

/**
 * Look up each line item's costo_de_envio metafield (in parallel, via the
 * cached getProductMetafields) and multiply it by that item's quantity.
 * costo_de_envio lives on the PRODUCT in Shopify admin, so this looks up
 * by product_id — NOT variant_id, which is a separate metafield resource
 * and would never find this value.
 * Sums across ALL items in the cart, so two different products each add
 * their own shipping cost instead of only one price being shown.
 *
 * An item with no costo_de_envio value falls back to the flat
 * FALLBACK_COSTO_ENVIO_GTQ for that item only (not the whole cart).
 */
async function estimateShippingCostForItems(items) {
  const results = await Promise.all(
    items.map(async (item) => {
      const quantity = Number(item.quantity || 1);
      try {
        const metafields = await getProductMetafields(item.product_id);
        const mf = metafields.find(
          (m) => m.namespace === 'custom' && m.key === 'costo_de_envio'
        );
        const value = mf ? Number(mf.value) : NaN;

        if (Number.isFinite(value)) {
          return { name: item.name, product_id: item.product_id, source: 'metafield', costGtq: value * quantity };
        }
      } catch (err) {
        log.warn('Metafield lookup failed for item — using flat fallback', {
          product_id: item.product_id,
          err: err.message,
        });
      }

      return { name: item.name, product_id: item.product_id, source: 'flat_default', costGtq: FALLBACK_COSTO_ENVIO_GTQ };
    })
  );

  const totalCostGtq = results.reduce((sum, r) => sum + r.costGtq, 0);
  return { totalCostGtq, itemBreakdown: results };
}

/**
 * Cart shipping cost = sum of every line item's costo_de_envio × quantity.
 * Always metafield-based — weight and CAEX are not used for pricing here.
 */
async function getShippingCost({ items }) {
  const { totalCostGtq, itemBreakdown } = await estimateShippingCostForItems(items);

  const usedFallback = itemBreakdown.some((r) => r.source === 'flat_default');
  if (usedFallback) {
    log.warn('One or more items had no costo_de_envio metafield — used flat fallback for those items', {
      itemBreakdown,
    });
  }

  log.info('Per-item shipping cost breakdown (summed for cart)', { itemBreakdown, totalCostGtq });

  return { priceGtq: totalCostGtq, usedFallback, detail: 'metafield_sum' };
}

export async function buildLocalRates(payload) {
  const destination = payload?.destination || {};
  const items = payload?.items || [];
  const currency = payload?.currency || 'GTQ';

  const deptCode = resolveDepartamento({
    province: destination?.province,
    province_code: destination?.province_code,
  });

  const destPobladoCode = findPobladoCode(destination?.city, deptCode);

  const subtotalGtq = getSubtotalGtq(items);
  const isGuatemalaDept = deptCode === GUATEMALA_DEPT_CODE;

  const costResult = await getShippingCost({ items });

  if (costResult.usedFallback) {
    log.warn('Rate quote used flat fallback pricing for one or more items missing a costo_de_envio metafield', {
      destination,
      subtotalGtq,
      detail: costResult.detail,
      fallbackPriceGtq: costResult.priceGtq,
    });
  }

  const rates = [
    {
      service_name: 'Recoge Bodega Ashley',
      service_code: SERVICE_CODES.PICKUP_STORE,
      total_price: 0,
      description: 'Recoge tu pedido sin costo',
      currency,
    },
  ];

  const isFreeShippingPromo = isGuatemalaDept && subtotalGtq >= FREE_SHIPPING_THRESHOLD_GTQ;

  if (isFreeShippingPromo) {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_GUA_FREE,
      total_price: 0,
      description: `Envío gratis en Guatemala para compras desde Q${FREE_SHIPPING_THRESHOLD_GTQ}`,
      currency,
    });
  } else if (isGuatemalaDept) {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_GUA_PAID,
      total_price: Math.round(costResult.priceGtq * 100),
      description: costResult.usedFallback
        ? 'Costo estimado (uno o más productos sin tarifa configurada)'
        : 'Tarifa según costo de envío de cada producto',
      currency,
    });
  } else {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_OTHER_CAEX,
      total_price: Math.round(costResult.priceGtq * 100),
      description: costResult.usedFallback
        ? 'Costo estimado (uno o más productos sin tarifa configurada)'
        : 'Tarifa según costo de envío de cada producto',
      currency,
    });
  }

  return rates;
}
