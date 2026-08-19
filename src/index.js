import 'dotenv/config';
import express from 'express';
import { handleRatesRequest } from './rates-handler.js';
import { handleOrderPaid } from './order-paid-handler.js';
import { loadPoblados } from './poblado-lookup.js';
import { getDepartamentos, getPoblados } from './caex.js';
import { log } from './logger.js';
const app = express();
// Raw body only for Shopify webhooks
app.use('/shopify/order-paid', express.raw({ type: '*/*', limit: '1mb' }));
// JSON parser for everything else
app.use((req, res, next) => {
  if (req.path === '/shopify/order-paid') {
    req.rawBody = req.body?.toString('utf8') || '';
    try {
      req.body = JSON.parse(req.rawBody || '{}');
    } catch {
      req.body = {};
    }
    return next();
  }
  return express.json({ limit: '1mb' })(req, res, next);
});
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.post('/shopify/rates', handleRatesRequest);
app.post('/test/rates', handleRatesRequest);
app.post('/shopify/order-paid', handleOrderPaid);

// TEMPORARY DEBUG ROUTES — used to look up real CAEX department/poblado
// codes since Render's free plan has no Shell access. No auth, so
// REMOVE these once CAEX_ORIGEN_POBLADO is confirmed correct.
app.get('/debug/departamentos', async (req, res) => {
  try {
    const depts = await getDepartamentos();
    res.json(depts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/debug/poblados/:deptCode', async (req, res) => {
  try {
    const poblados = await getPoblados(req.params.deptCode);
    res.json(poblados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.json({
    service: 'CAEX Shopify Middleware',
    endpoints: ['/health', '/shopify/rates', '/test/rates', '/shopify/order-paid'],
  });
});
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});
const port = Number(process.env.PORT) || 3000;
loadPoblados();
app.listen(port, () => {
  log.info(`CAEX middleware listening on port ${port}`);
  log.info(`Health check: http://localhost:${port}/health`);
});
