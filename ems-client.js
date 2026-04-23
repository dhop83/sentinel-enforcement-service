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

async function emsPost(path, body) {
  const url = `${EMS_BASE_URL}/ems/api/v5${path}`;
  console.log(`[ems] POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: emsAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[ems] ${res.status} on POST ${path} — ${text}`);
    throw new Error(`EMS ${res.status} on POST ${path}: ${text}`);
  }
  return res.json();
}

// Permanent cache: entitlementId → { internalUid, pkId, raw }
const entitlementCache = new Map();

async function resolveEntitlement(entitlementId) {
  if (entitlementCache.has(entitlementId)) return entitlementCache.get(entitlementId);

  // Step 1: resolve to internal UID
  let internalUid;
  try {
    const data = await emsGet(`/entitlements/${entitlementId}`);
    internalUid = data?.entitlement?.id || data?.id;
  } catch (err) {
    if (err.message.includes('404')) {
      // eId lookup
      const list = await emsGet(`/entitlements?eId=${entitlementId}&limit=1`);
      const found = list?.entitlements?.entitlement?.[0];
      if (!found) throw new Error(`No entitlement found for: ${entitlementId}`);
      internalUid = found.id;
      console.log(`[ems] Resolved eId ${entitlementId} → ${internalUid}`);
    } else {
      throw err;
    }
  }

  // Step 2: fetch full entitlement with internal UID (no embed needed — item comes back by default)
  const fullData = await emsGet(`/entitlements/${internalUid}`);
  const ent = fullData?.entitlement || fullData;
  const pkId = ent?.productKeys?.productKey?.[0]?.pkId;

  if (!pkId) throw new Error(`No pkId found on entitlement: ${entitlementId}`);

  console.log(`[ems] Resolved — uid=${internalUid} pkId=${pkId}`);
  const resolved = { internalUid, pkId, raw: ent };
  entitlementCache.set(entitlementId, resolved);
  return resolved;
}

export async function fetchEntitlementFromEMS(entitlementId) {
  if (!circuitAllow()) throw new Error('circuit_open');
  try {
    const { raw } = await resolveEntitlement(entitlementId);
    circuitSuccess();
    return raw;
  } catch (err) {
    circuitFailure();
    throw err;
  }
}

export async function activateEntitlement(entitlementId, userId) {
  const { pkId } = await resolveEntitlement(entitlementId);
  console.log(`[ems] bulkActivate pkId=${pkId} userId=${userId}`);

  const body = {
    bulkActivation: {
      activationProductKeys: {
        activationProductKey: [{ pkId, activationQuantity: 1 }]
      }
    }
  };

  return emsPost('/activations/bulkActivate', body);
}

export async function deactivateEntitlement(entitlementId, activationId) {
  const { internalUid } = await resolveEntitlement(entitlementId);
  const res = await fetch(`${EMS_BASE_URL}/ems/api/v5/entitlements/${internalUid}/activations/${activationId}`, {
    method: 'DELETE',
    headers: { Authorization: emsAuth() },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`EMS deactivate failed: ${res.status}`);
  return true;
}

export function getCircuitState() { return { ...circuit }; }
