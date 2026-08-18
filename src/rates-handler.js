import { buildLocalRates } from './shipping-rules.js';
import { log } from './logger.js';

// Shopify's own rate-request timeout is dynamic (up to ~10s) and, if we
// miss it, Shopify silently discards our whole response and shows its own
// backup rate instead — which drops BOTH our custom options, including
// pickup. This internal budget makes sure we always answer well inside
// that window, even on a cache miss / slow CAEX response.
const INTERNAL_TIMEOUT_MS = Number(process.env.RATES_INTERNAL_TIMEOUT_MS || 6000);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`rates handler exceeded ${ms}ms internal budget`)), ms)),
  ]);
}

export async function handleRatesRequest(req, res) {
  const startedAt = Date.now();
  const payload = req.body?.rate;

  log.info('RAW /shopify/rates body', req.body);

  if (!payload) {
    log.warn('Received /shopify/rates with no rate payload');
    return res.status(400).json({ rates: [] });
  }

  try {
    log.info('Incoming Shopify rate payload summary', {
      destination: payload?.destination,
      currency: payload?.currency,
      itemCount: payload?.items?.length || 0,
    });
    log.info('Incoming Shopify rate items', payload?.items || []);

    const rates = await withTimeout(buildLocalRates(payload), INTERNAL_TIMEOUT_MS);

    log.info('Calculated local rates', rates);

    const durationMs = Date.now() - startedAt;
    log.info(`Returning ${rates.length} local rate(s) in ${durationMs}ms`);

    return res.json({ rates });
  } catch (err) {
    log.error('Unexpected error in rates handler — returning pickup + flat home fallback so a customer never sees only one option', err.stack || err.message);
    const currency = payload?.currency || 'GTQ';
    const fallbackHomeGtq = Number(process.env.FALLBACK_COSTO_ENVIO_GTQ || 612);
    return res.json({
      rates: [
        {
          service_name: 'Recoge Bodega Ashley',
          service_code: 'ASHLEY_PICKUP_STORE',
          total_price: 0,
          description: 'Recoge tu pedido sin costo',
          currency,
        },
        {
          service_name: 'Envío a domicilio',
          service_code: 'ASHLEY_HOME_GUA_PAID',
          total_price: Math.round(fallbackHomeGtq * 100),
          description: 'Costo estimado (no se pudo calcular la tarifa)',
          currency,
        },
      ],
    });
  }
}
