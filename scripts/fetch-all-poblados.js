/**
 * One-time script: fetch ALL poblados from CAEX (all 22 departments)
 * and save to data/poblados.json for runtime lookup.
 *
 * Run with: npm run fetch-poblados
 *
 * Re-run monthly or when CAEX notifies of new coverage.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDepartamentos, getPoblados } from '../src/caex.js';
import { log } from '../src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'poblados.json');

async function main() {
  log.info('Fetching all departments…');
  const depts = await getDepartamentos();
  log.info(`Got ${depts.length} departments`);

  const all = [];
  for (const dept of depts) {
    log.info(`  Fetching poblados for ${dept.Codigo} (${dept.Nombre})…`);
    try {
      const poblados = await getPoblados(dept.Codigo);
      log.info(`    → ${poblados.length} poblados`);
      all.push(...poblados);
    } catch (err) {
      log.error(`    Failed for ${dept.Codigo}: ${err.message}`);
    }
    // Gentle delay to be polite to CAEX's API
    await new Promise((r) => setTimeout(r, 300));
  }

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
  log.info(`✅ Wrote ${all.length} poblados → ${OUT}`);
}

main().catch((err) => {
  log.error('fetch-all-poblados failed', err.stack || err.message);
  process.exit(1);
});
