import express from 'express';
import { check, activate, deactivate, invalidate } from './enforcement.js';
import { initRedis, cacheStats } from './cache.js';
import { getCircuitState } from './ems-client.js';

const app  = express();
const PORT = process.env.PORT || 8081;import express from 'express';
import { check, activate, deactivate, invalidate } from './enforcement.js';
import { initRedis, cacheStats } from './cache.js';
import { getCircuitState } from './ems-client.js';

const app  = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ENFORCEMENT_API_KEY;

app.use(express.json());

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-enforcement-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (provided !== API_KEY) return res.status(401).json({ error: 'invalid_api_key' });
  next();
}

app.get('/', async (req, res) => {
  const stats = await cacheStats();
  const circuit = getCircuitState();
  res.json({ status: 'ok', service: 'sentinel-enforcement-service', failMode: process.env.ENFORCEMENT_FAIL_MODE || 'open', cache: stats, circuit: { state: circuit.state, failures: circuit.failures }, timestamp: new Date().toISOString() });
});

app.post('/validate', requireApiKey, async (req, res) => {
  const { entitlementId, feature } = req.body;
  if (!entitlementId) return res.status(400).json({ error: 'entitlementId is required' });
  try {
    const result = await check(entitlementId, feature);
    return res.status(result.valid ? 200 : 403).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

app.post('/activate', requireApiKey, async (req, res) => {
  const { entitlementId, feature, userId } = req.body;
  if (!entitlementId || !userId) return res.status(400).json({ error: 'entitlementId and userId are required' });
  try {
    const result = await activate(entitlementId, feature, userId);
    return res.status(result.success ? 200 : 403).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

app.post('/deactivate', requireApiKey, async (req, res) => {
  const { entitlementId, activationId } = req.body;
  if (!entitlementId || !activationId) return res.status(400).json({ error: 'entitlementId and activationId are required' });
  try {
    const result = await deactivate(entitlementId, activationId);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

app.post('/webhook/ems', async (req, res) => {
  res.status(200).json({ received: true });
  const { entityId, activityName, currentState } = req.body;
  console.log(`[webhook] ${activityName} — entity: ${entityId}`);
  const INVALIDATING_EVENTS = ['ENTITLEMENT_DISABLED','ENTITLEMENT_SUSPENDED','ENTITLEMENT_ENABLED','ENTITLEMENT_EXPIRED','ENTITLEMENT_UPDATED','ACTIVATION_CREATED','ACTIVATION_REVOKED','ACTIVATION_UPDATED'];
  let entitlementId = entityId;
  try {
    const state = JSON.parse(currentState || '{}');
    entitlementId = state?.entitlement?.id || state?.activation?.entitlement?.id || entityId;
  } catch { /* use entityId */ }
  if (INVALIDATING_EVENTS.includes(activityName) && entitlementId) {
    await invalidate(entitlementId);
    console.log(`[webhook] Cache invalidated: ${entitlementId}`);
  }
});

app.delete('/cache/:entitlementId', requireApiKey, async (req, res) => {
  await invalidate(req.params.entitlementId);
  res.json({ invalidated: req.params.entitlementId });
});

// ─── Debug: raw EMS connectivity ─────────────────────────────────────────────
app.get('/debug/ems', async (req, res) => {
  const auth = 'Basic ' + Buffer.from(`${process.env.SENTINEL_EMS_USERNAME}:${process.env.SENTINEL_EMS_PASSWORD}`).toString('base64');
  const results = {};
  try {
    const r = await fetch(`${process.env.SENTINEL_EMS_URL}/ems/api/v5/entitlements?limit=1`, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    results.list = { status: r.status, ok: r.ok };
  } catch (e) { results.list = { error: e.message }; }
  res.json({ authHeader: auth.substring(0, 20) + '...', results });
});

// ─── Debug: raw activation POST ──────────────────────────────────────────────
app.get('/debug/activate', async (req, res) => {
  const uid = req.query.uid || '0e9072f2-5d12-4360-a6ac-ba6d90327073';
  const auth = 'Basic ' + Buffer.from(`${process.env.SENTINEL_EMS_USERNAME}:${process.env.SENTINEL_EMS_PASSWORD}`).toString('base64');
  const body = { activations: { activation: [{ quantity: 1 }] } };
  const url = `${process.env.SENTINEL_EMS_URL}/ems/api/v5/entitlements/${uid}/activations`;
  console.log(`[debug] POST ${url}`);
  try {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    res.json({ url, status: r.status, ok: r.ok, response: text.substring(0, 800) });
  } catch (err) {
    res.json({ url, error: err.message });
  }
});

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

// ─── GET /debug/ems ───────────────────────────────────────────────────────────
// Tests raw EMS connectivity and auth — remove in production

app.get('/debug/ems', async (req, res) => {
  try {
    const url = `${process.env.SENTINEL_EMS_URL}/ems/api/v5/entitlements?limit=1`;
    const auth = 'Basic ' + Buffer.from(
      `${process.env.SENTINEL_EMS_USERNAME}:${process.env.SENTINEL_EMS_PASSWORD}`
    ).toString('base64');

    const emsRes = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    const body = await emsRes.text();
    res.json({
      status: emsRes.status,
      ok: emsRes.ok,
      url,
      authHeader: auth.substring(0, 20) + '...',
      body: body.substring(0, 500),
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});



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
