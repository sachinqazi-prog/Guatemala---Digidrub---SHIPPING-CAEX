/**
 * Ashley's internal Products API (WS_ApiAshley).
 *
 * Used to fetch the REAL Cantidad_de_piezas per SKU — the number of
 * physical pieces/boxes a single unit of a product actually ships as
 * (e.g. SKU 428628 "COMEDOR BRECKINGTON" = 5 pieces per unit,
 * confirmed via a real API call). caex.js's GenerarGuia needs this
 * exact value per CAEX's own spec (Point 9 of "Explanation of the
 * GenerarGuia method") — using item.quantity alone is WRONG whenever
 * a single ordered unit is itself a multi-box product; this was an
 * open/unresolved gap until now.
 *
 * Two-step flow, both confirmed via real Postman requests:
 *   1. GET  http://186.189.221.19/WS_ApiAshley/Token
 *      Body (x-www-form-urlencoded): username, password, grant_type=password
 *      -> { access_token, token_type: "bearer", expires_in: 3599 }
 *      NOTE: this is a GET request WITH a body, confirmed working
 *      exactly as configured in Postman. That's non-standard for an
 *      OAuth2 password-grant token request (normally POST), but is
 *      replicated here as-is rather than "corrected" to POST, since
 *      the real server was only confirmed to accept it this way.
 *   2. GET  http://186.189.221.19/WS_ApiAshley/api/values/GetProductoid?id={SKU}
 *      -> product record including "Cantidad_de_piezas" (returned as
 *      a STRING, e.g. "5", not a number — parse defensively).
 *      Requires `Authorization: Bearer {access_token}` from step 1.
 *
 * POSTMAN GOTCHA (noted earlier in this project, baked in here from
 * the start): if this were built via an HTTP client that inherits
 * auth from a parent/collection-level Basic Auth config, that would
 * silently override a manually-set Bearer header. Not applicable here
 * since axios calls are independent per-request with no inherited
 * auth — flagging only so the gotcha isn't reintroduced if this ever
 * gets refactored through a shared client.
 */
import axios from 'axios';
import { log } from './logger.js';
import { cacheGet, cacheSet } from './cache.js';

const PRODUCTS_API_BASE = process.env.PRODUCTS_API_BASE || 'http://186.189.221.19/WS_ApiAshley';
const PRODUCTS_API_USERNAME = process.env.PRODUCTS_API_USERNAME || 'UAumenta';
const PRODUCTS_API_PASSWORD = process.env.PRODUCTS_API_PASSWORD || 'ufuzBNAKMEeuYÑÑijAal5AmHOsQv';

// Confirmed via real request: expires_in: 3599 (~1 hour). This is
// SHORTER than Shopify's/CAEX's tokens — do not reuse the 50-minute
// pattern from shopify.js verbatim without checking this value if the
// API's behavior ever changes.
const TOKEN_TTL_MS = 50 * 60 * 1000; // refresh a bit before the real ~60min expiry

// Piece counts don't change often — cache per SKU for a day, per the
// project's own earlier note ("daily/weekly cache reasonable"). Don't
// hit this live on every order.
const PIECE_COUNT_CACHE_TTL_SECONDS = Number(process.env.PRODUCTS_API_CACHE_TTL_SECONDS || 86400);

let cachedAccessToken = null;
let tokenFetchedAt = 0;

function isTokenFresh() {
  return cachedAccessToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS;
}

async function requestNewAccessToken() {
  const url = `${PRODUCTS_API_BASE}/Token`;

  const body = new URLSearchParams({
    username: PRODUCTS_API_USERNAME,
    password: PRODUCTS_API_PASSWORD,
    grant_type: 'password',
  });

  try {
    // Deliberately axios({ method: 'get', data }) rather than
    // axios.get(url, config) — the latter's shorthand does not send a
    // body on GET in all axios versions. This mirrors exactly what
    // was confirmed working in Postman: a GET request carrying a
    // x-www-form-urlencoded body.
    const { data } = await axios({
      method: 'get',
      url,
      data: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    const token = data?.access_token;
    if (!token) {
      throw new Error('Products API token response missing access_token');
    }

    cachedAccessToken = token;
    tokenFetchedAt = Date.now();

    log.info('Fetched new Ashley Products API access token', {
      expiresInSec: data?.expires_in,
    });

    return token;
  } catch (err) {
    log.error('Failed to fetch Ashley Products API token', {
      status: err?.response?.status,
      message: err?.response?.data || err?.message,
    });
    throw err;
  }
}

async function getAccessToken() {
  if (isTokenFresh()) return cachedAccessToken;
  return requestNewAccessToken();
}

/**
 * Fetches a single product's full record from the Products API,
 * refreshing the token and retrying once on a 401/403 mid-request —
 * same pattern used for Shopify's own token in shopify.js.
 */
async function fetchProduct(sku, { retryOnAuthError = true } = {}) {
  const token = await getAccessToken();
  const url = `${PRODUCTS_API_BASE}/api/values/GetProductoid`;

  try {
    const { data } = await axios.get(url, {
      params: { id: sku },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return data;
  } catch (err) {
    const status = err?.response?.status;

    if ((status === 401 || status === 403) && retryOnAuthError) {
      log.warn('Products API token rejected, refreshing and retrying once', { sku, status });
      await requestNewAccessToken();
      return fetchProduct(sku, { retryOnAuthError: false });
    }

    log.error('Products API GetProductoid call failed', {
      sku,
      status,
      message: err?.response?.data || err?.message,
    });
    throw err;
  }
}

/**
 * Returns the real Cantidad_de_piezas for a SKU (how many physical
 * pieces/boxes ONE UNIT of this product ships as), or `null` if it
 * can't be determined (API error, SKU not found, missing/unparseable
 * field). Callers should fall back to a sane default (1) when null —
 * never block guide generation on this being unavailable.
 *
 * Cached per SKU for PIECE_COUNT_CACHE_TTL_SECONDS, since this value
 * changes rarely and we don't want a live external call on every
 * order-paid webhook.
 */
export async function getCantidadDePiezas(sku) {
  if (!sku) return null;

  const cacheKey = `products_api:cantidad_piezas:${sku}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  try {
    const product = await fetchProduct(sku);

    // Confirmed via real response for SKU 428628: the field name is
    // exactly "Cantidad_de_piezas" and its value is a STRING ("5"),
    // not a number — parse defensively rather than assuming a type.
    const raw = product?.Cantidad_de_piezas;
    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      log.warn('Products API returned no usable Cantidad_de_piezas — caller should fall back', {
        sku,
        rawValue: raw,
      });
      cacheSet(cacheKey, null, PIECE_COUNT_CACHE_TTL_SECONDS);
      return null;
    }

    cacheSet(cacheKey, parsed, PIECE_COUNT_CACHE_TTL_SECONDS);
    return parsed;
  } catch (err) {
    // Already logged inside fetchProduct/requestNewAccessToken. Don't
    // cache failures — a transient outage shouldn't poison the cache
    // for a full day; just let the next order retry.
    return null;
  }
}
