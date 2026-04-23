import express from 'express';
import { check, activate, deactivate, invalidate } from './enforcement.js';
import { initRedis, cacheStats } from './cache.js';
import { getCircuitState } from './ems-client.js';

const app  = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ENFORCEMENT_API_KEY;

app.use(express.json());

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open (dev mode)
  const provided = req.headers['x-enforcement-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  const stats = await cacheStats();
  const circuit = getCircuitState();
  res.json({
    status: 'ok',
    service: 'sentinel-enforcement-service',
    failMode: process.env.ENFORCEMENT_FAIL_MODE || 'open',
    cache: stats,
    circuit: {
      state: circuit.state,
      failures: circuit.failures,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /validate ───────────────────────────────────────────────────────────
// Check entitlement validity + feature access + qty
// Does NOT consume a token

app.post('/validate', requireApiKey, async (req, res) => {
  const { entitlementId, feature } = req.body;

  if (!entitlementId) {
    return res.status(400).json({ error: 'entitlementId is required' });
  }

  try {
    const result = await check(entitlementId, feature);
    const statusCode = result.valid ? 200 : 403;
    return res.status(statusCode).json(result);
  } catch (err) {
    console.error('[validate] Error:', err.message);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// ─── POST /activate ───────────────────────────────────────────────────────────
// Validate + consume 1 token from the entitlement pool

app.post('/activate', requireApiKey, async (req, res) => {
  const { entitlementId, feature, userId } = req.body;

  if (!entitlementId || !userId) {
    return res.status(400).json({ error: 'entitlementId and userId are required' });
  }

  try {
    const result = await activate(entitlementId, feature, userId);
    const statusCode = result.success ? 200 : 403;
    return res.status(statusCode).json(result);
  } catch (err) {
    console.error('[activate] Error:', err.message);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// ─── POST /deactivate ─────────────────────────────────────────────────────────
// Return token to pool

app.post('/deactivate', requireApiKey, async (req, res) => {
  const { entitlementId, activationId } = req.body;

  if (!entitlementId || !activationId) {
    return res.status(400).json({ error: 'entitlementId and activationId are required' });
  }

  try {
    const result = await deactivate(entitlementId, activationId);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// ─── POST /webhook/ems ────────────────────────────────────────────────────────
// EMS pushes state changes here → instant cache invalidation

app.post('/webhook/ems', async (req, res) => {
  res.status(200).json({ received: true }); // acknowledge fast

  const { entityId, activityName, currentState } = req.body;
  console.log(`[webhook] ${activityName} — entity: ${entityId}`);

  const INVALIDATING_EVENTS = [
    'ENTITLEMENT_DISABLED',
    'ENTITLEMENT_SUSPENDED',
    'ENTITLEMENT_ENABLED',
    'ENTITLEMENT_EXPIRED',
    'ENTITLEMENT_UPDATED',
    'ACTIVATION_CREATED',
    'ACTIVATION_REVOKED',
    'ACTIVATION_UPDATED',
  ];

  // Try to get entitlement ID from currentState or entityId
  let entitlementId = entityId;
  try {
    const state = JSON.parse(currentState || '{}');
    entitlementId = state?.entitlement?.id || state?.activation?.entitlement?.id || entityId;
  } catch { /* use entityId */ }

  if (INVALIDATING_EVENTS.includes(activityName) && entitlementId) {
    await invalidate(entitlementId);
    console.log(`[webhook] Cache invalidated for entitlement: ${entitlementId}`);
  }
});

// ─── GET /cache/invalidate/:entitlementId ─────────────────────────────────────
// Manual cache invalidation for testing

app.delete('/cache/:entitlementId', requireApiKey, async (req, res) => {
  await invalidate(req.params.entitlementId);
  res.json({ invalidated: req.params.entitlementId });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  await initRedis();
  app.listen(PORT, () => {
    console.log(`[enforcement] Service running on port ${PORT}`);
    console.log(`[enforcement] Fail mode: ${process.env.ENFORCEMENT_FAIL_MODE || 'open'}`);
    console.log(`[enforcement] EMS tenant: ${process.env.SENTINEL_EMS_URL}`);
    console.log(`[enforcement] API key: ${API_KEY ? 'set' : 'NOT SET (open dev mode)'}`);
  });
}

boot();
