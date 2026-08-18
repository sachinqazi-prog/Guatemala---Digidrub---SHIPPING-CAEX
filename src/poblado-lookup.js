/**
 * Poblado lookup.
 *
 * We pre-fetch all poblados from CAEX (via scripts/fetch-all-poblados.js)
 * and store them in data/poblados.json. At runtime we fuzzy-match the
 * Shopify city name against that list, scoped to the resolved department.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'poblados.json');

let poblados = [];
let byDepartment = new Map();

/**
 * Load poblados from disk into memory. Call once at startup.
 */
export function loadPoblados() {
  if (!fs.existsSync(DATA_FILE)) {
    log.warn(`No poblados data file at ${DATA_FILE}. Run \`npm run fetch-poblados\` first.`);
    return;
  }

  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  poblados = JSON.parse(raw);
  byDepartment = new Map();
  for (const p of poblados) {
    // Normalize CodigoDepto to a 2-digit string so lookups match CAEX's dept codes ("01", "02", ..., "22")
    const deptKey = String(p.CodigoDepto).padStart(2, '0');
    if (!byDepartment.has(deptKey)) byDepartment.set(deptKey, []);
    byDepartment.get(deptKey).push(p);
  }
  log.info(`Loaded ${poblados.length} poblados across ${byDepartment.size} departments`);
}

/**
 * Normalize a string for fuzzy matching: lowercase, strip accents, strip extra spaces.
 */
function normalize(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the best CAEX poblado code for a given Shopify city + department code.
 *
 * Matching strategy (cascading):
 *  1. Exact normalized match within department
 *  2. startsWith match within department
 *  3. contains match within department
 *  4. First poblado in department (last-resort default)
 *  5. null (unresolvable — middleware falls back to flat rate)
 */
export function findPobladoCode(cityName, departamentoCode) {
  if (!departamentoCode) return null;
  const candidates = byDepartment.get(departamentoCode);
  if (!candidates || candidates.length === 0) return null;

  const needle = normalize(cityName);
  if (!needle) {
    // No city name — return the first poblado (usually the department capital)
    return candidates[0].Codigo;
  }

  // 1. Exact match
  for (const p of candidates) {
    if (normalize(p.Nombre) === needle) return p.Codigo;
  }
  // 2. startsWith
  for (const p of candidates) {
    if (normalize(p.Nombre).startsWith(needle)) return p.Codigo;
  }
  // 3. contains
  for (const p of candidates) {
    if (normalize(p.Nombre).includes(needle)) return p.Codigo;
  }
  // 4. Last resort: first poblado in that department
  log.warn(`No fuzzy match for city "${cityName}" in dept ${departamentoCode}; defaulting to first poblado`);
  return candidates[0].Codigo;
}

/**
 * Lookup a poblado by its CAEX code. Used for red-zone detection etc.
 */
export function getPobladoByCode(code) {
  return poblados.find((p) => String(p.Codigo) === String(code));
}
