const EMS_BASE_URL = process.env.SENTINEL_EMS_URL;
const EMS_USER     = process.env.SENTINEL_EMS_USERNAME || 'admin';
const EMS_PASS     = process.env.SENTINEL_EMS_PASSWORD;

function emsAuth() {
  return 'Basic ' + Buffer.from(`${EMS_USER}:${EMS_PASS}`).toString('base64');
}

const circuit = {
  failures: 0, lastFailure: null, state: 'CLOSED', threshold: 10, resetAfterMs: 15000,
};

function circuitAllow() {
  if (circuit.state === 'OPEN') {
    if (Date.now() - circuit.lastFailure > circuit.resetAfterMs) {
      circuit.state = 'HALF_OPEN';
      console.log('[circuit] Half-open — testing EMS...');
      return true;
    }
    return false;
  }
  return true;
}

function circuitSuccess() { circuit.failures = 0; circuit.state = 'CLOSED'; }
function circuitFailure() {
  circuit.failures++;
  circuit.lastFailure = Date.now();
  if (circuit.failures >= circuit.threshold) {
    circuit.state = 'OPEN';
    console.warn(`[circuit] OPEN after ${circuit.failures} failures`);
  }
}

async function emsGet(path) {
  const res = await fetch(`${EMS_BASE_URL}/ems/api/v5${path}`, {
    headers: { Authorization: emsAuth(), Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[ems] ${res.status} on GET ${path} — ${body}`);
    throw new Error(`EMS ${res.status} on GET ${path}: ${body}`);
  }
  return res.json();
}

// eId → internal UID resolver (cached permanently)
const uidCache = new Map();

async function resolveUid(entitlementId) {
  if (uidCache.has(entitlementId)) return uidCache.get(entitlementId);

  // Try direct fetch first (works if already internal UID)
  try {
    const data = await emsGet(`/entitlements/${entitlementId}`);
    const uid = data?.entitlement?.id || entitlementId;
    uidCache.set(entitlementId, uid);
    return uid;
  } catch (err) {
    if (err.message.includes('404')) {
      // It's an eId — search for internal UID
      const list = await emsGet(`/entitlements?eId=${entitlementId}&limit=1`);
      const found = list?.entitlements?.entitlement?.[0];
      if (!found) throw new Error(`No entitlement found for: ${entitlementId}`);
      console.log(`[ems] Resolved eId ${entitlementId} → ${found.id}`);
      uidCache.set(entitlementId, found.id);
      return found.id;
    }
    throw err;
  }
}

export async function fetchEntitlementFromEMS(entitlementId) {
  if (!circuitAllow()) throw new Error('circuit_open');
  try {
    const uid = await resolveUid(entitlementId);
    const data = await emsGet(`/entitlements/${uid}`);
    circuitSuccess();
    return data.entitlement || data;
  } catch (err) {
    circuitFailure();
    throw err;
  }
}

export async function activateEntitlement(entitlementId, userId) {
  const uid = await resolveUid(entitlementId);
  console.log(`[ems] Activating uid=${uid}`);
  const body = { activations: { activation: [{ quantity: 1 }] } };
  const res = await fetch(`${EMS_BASE_URL}/ems/api/v5/entitlements/${uid}/activations`, {
    method: 'POST',
    headers: { Authorization: emsAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[ems] activation failed ${res.status}: ${text}`);
    throw new Error(`EMS ${res.status} on POST activations: ${text}`);
  }
  return res.json();
}

export async function deactivateEntitlement(entitlementId, activationId) {
  const uid = await resolveUid(entitlementId);
  const res = await fetch(`${EMS_BASE_URL}/ems/api/v5/entitlements/${uid}/activations/${activationId}`, {
    method: 'DELETE',
    headers: { Authorization: emsAuth() },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`EMS deactivate failed: ${res.status}`);
  return true;
}

export function getCircuitState() { return { ...circuit }; }
