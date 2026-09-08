/**
 * Ashley Products API — via cPanel proxy.
 *
 * WHY A PROXY: Render's outbound traffic cannot reach 186.189.221.19
 * directly — confirmed via repeated timeouts in production
 * (products-api.js's direct-connection version consistently failed
 * with "timeout of 10000ms exceeded" on every real order tested).
 * The ashley-sync-guatemala PHP sync, hosted on cPanel, CAN reach
 * that same server (confirmed via its own connections test). Rather
 * than negotiate IP whitelisting for Render's shared outbound ranges
 * with whoever manages that internal server, a small PHP proxy
 * (products_proxy.php) sits on cPanel — the network that already
 * works — and re-exposes just the one field this file needs
 * (Cantidad_de_piezas) over normal public HTTPS.
 *
 * This file is now much simpler than its direct-connection
 * predecessor: no token management, no auth dance — just one
 * authenticated GET to the proxy per SKU, still cached daily per SKU
 * exactly as before.
 */
import axios from 'axios';
import { log } from './logger.js';
import { cacheGet, cacheSet } from './cache.js';

const PRODUCTS_PROXY_URL = process.env.PRODUCTS_PROXY_URL; // e.g. https://yourdomain.com/ashley-sync-guatemala/products_proxy.php
const PRODUCTS_PROXY_KEY = process.env.PRODUCTS_PROXY_KEY; // must match the shared key in products_proxy.php

// Piece counts don't change often — cache per SKU for a day, same as
// the direct-connection version.
const PIECE_COUNT_CACHE_TTL_SECONDS = Number(process.env.PRODUCTS_API_CACHE_TTL_SECONDS || 86400);

/**
 * Returns the real Cantidad_de_piezas for a SKU (how many physical
 * pieces/boxes ONE UNIT of this product ships as), or `null` if it
 * can't be determined (proxy unreachable, SKU not found, missing
 * config). Callers should fall back to a sane default (1) when null —
 * never block guide generation on this being unavailable.
 */
export async function getCantidadDePiezas(sku) {
  if (!sku) return null;

  const cacheKey = `products_api:cantidad_piezas:${sku}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  if (!PRODUCTS_PROXY_URL || !PRODUCTS_PROXY_KEY) {
    log.error('Missing PRODUCTS_PROXY_URL / PRODUCTS_PROXY_KEY in env — cannot look up Cantidad_de_piezas', { sku });
    return null;
  }

  try {
    const { data } = await axios.get(PRODUCTS_PROXY_URL, {
      params: { sku, key: PRODUCTS_PROXY_KEY },
      timeout: 10000,
    });

    if (!data?.ok) {
      log.warn('Products proxy returned no usable Cantidad_de_piezas — caller should fall back', {
        sku,
        error: data?.error,
        rawValue: data?.raw_value,
      });
      cacheSet(cacheKey, null, PIECE_COUNT_CACHE_TTL_SECONDS);
      return null;
    }

    const pieces = Number(data.cantidad_de_piezas);
    if (!Number.isFinite(pieces) || pieces <= 0) {
      log.warn('Products proxy returned an invalid cantidad_de_piezas value', { sku, value: data.cantidad_de_piezas });
      cacheSet(cacheKey, null, PIECE_COUNT_CACHE_TTL_SECONDS);
      return null;
    }

    cacheSet(cacheKey, pieces, PIECE_COUNT_CACHE_TTL_SECONDS);
    return pieces;
  } catch (err) {
    log.error('Products proxy request failed', {
      sku,
      status: err?.response?.status,
      message: err?.response?.data || err?.message,
    });
    // Don't cache failures — a transient proxy/network issue shouldn't
    // poison the cache for a full day; let the next order retry.
    return null;
  }
}
