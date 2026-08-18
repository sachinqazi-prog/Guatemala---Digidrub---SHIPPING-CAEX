import axios from 'axios';
import { log } from './logger.js';
import { cacheGet, cacheSet } from './cache.js';

// How long a product's metafields stay cached before we re-fetch from
// Shopify. costo_de_envio changes rarely, so this trades a bit of
// staleness for a checkout that doesn't wait on the Admin API.
const METAFIELD_CACHE_TTL_SECONDS = Number(process.env.METAFIELD_CACHE_TTL_SECONDS || 3600);

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';

let cachedAccessToken = null;
let tokenFetchedAt = 0;

// Keep token briefly in memory. If Shopify expires it sooner, 401 flow below will refresh it.
const TOKEN_TTL_MS = 50 * 60 * 1000;

function getBaseUrl() {
  return `https://${SHOP}/admin/api/${API_VERSION}`;
}

function isTokenFresh() {
  return cachedAccessToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS;
}

async function requestNewAccessToken() {
  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing Shopify client credentials in env');
  }

  const url = `https://${SHOP}/admin/oauth/access_token`;

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

  log.info('Fetched new Shopify Admin access token');
  return token;
}

async function getAccessToken() {
  if (isTokenFresh()) return cachedAccessToken;
  return requestNewAccessToken();
}

async function shopifyGet(path, retryOnAuthError = true) {
  const token = await getAccessToken();

  try {
    const { data } = await axios.get(`${getBaseUrl()}${path}`, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return data;
  } catch (err) {
    const status = err?.response?.status;

    if ((status === 401 || status === 403) && retryOnAuthError) {
      log.warn('Shopify token rejected, refreshing token and retrying once', {
        status,
        path,
      });

      await requestNewAccessToken();

      return shopifyGet(path, false);
    }

    log.error('Shopify GET failed', {
      status,
      path,
      message: err?.response?.data || err.message,
    });

    throw err;
  }
}

export async function getVariantMetafields(variantId) {
  const cacheKey = `variant_metafields:${variantId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await shopifyGet(`/variants/${variantId}/metafields.json`);
    const metafields = data?.metafields || [];
    cacheSet(cacheKey, metafields, METAFIELD_CACHE_TTL_SECONDS);
    return metafields;
  } catch (err) {
    log.error('Failed to fetch variant metafields', {
      variantId,
      message: err.message,
    });
    return [];
  }
}

/**
 * costo_de_envio is set on the PRODUCT in Shopify admin (Product metafields
 * section), not on the variant — these are two separate resources in
 * Shopify's API, each with their own metafields.json endpoint. This is the
 * one shipping-rules.js should call for costo_de_envio.
 */
export async function getProductMetafields(productId) {
  const cacheKey = `product_metafields:${productId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await shopifyGet(`/products/${productId}/metafields.json`);
    const metafields = data?.metafields || [];
    cacheSet(cacheKey, metafields, METAFIELD_CACHE_TTL_SECONDS);
    return metafields;
  } catch (err) {
    log.error('Failed to fetch product metafields', {
      productId,
      message: err.message,
    });
    return [];
  }
}

/**
 * Call this from an admin/products webhook handler (e.g. products/update)
 * to invalidate a variant's cached metafields the moment costo_de_envio
 * changes, instead of waiting out the TTL.
 */
export function invalidateVariantMetafieldsCache(variantId) {
  cacheSet(`variant_metafields:${variantId}`, null, 0);
}

export function invalidateProductMetafieldsCache(productId) {
  cacheSet(`product_metafields:${productId}`, null, 0);
}
