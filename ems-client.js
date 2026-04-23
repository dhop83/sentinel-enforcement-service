// ─── EMS Client with Circuit Breaker ─────────────────────────────────────────

const EMS_BASE_URL = process.env.SENTINEL_EMS_URL;
const EMS_USER     = process.env.SENTINEL_EMS_USERNAME || 'admin';
const EMS_PASS     = process.env.SENTINEL_EMS_PASSWORD;

function emsAuth() {
  return 'Basic ' + Buffer.from(`${EMS_USER}:${EMS_PASS}`).toString('base64');
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const circuit = {
  failures: 0,
  lastFailure: null,
  state: 'CLOSED', // CLOSED = normal, OPEN = skip EMS calls
  threshold: 10,
  resetAfterMs: 15000,
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

function circuitSuccess() {
  circuit.failures = 0;
  circuit.state = 'CLOSED';
}

function circuitFailure() {
  circuit.failures++;
  circuit.lastFailure = Date.now();
  if (circuit.failures >= circuit.threshold) {
    circuit.state = 'OPEN';
    console.warn(`[circuit] OPEN — EMS unreachable after ${circuit.failures} failures`);
  }
}

// ─── EMS API Calls ────────────────────────────────────────────────────────────

async function emsGet(path) {
  const url = `${EMS_BASE_URL}/ems/api/v5${path}`;
  const res = await fetch(url, {
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
  const res = await fetch(`${EMS_BASE_URL}/ems/api/v5${path}`, {
    method: 'POST',
    headers: {
      Authorization: emsAuth(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EMS ${res.status} on POST ${path}: ${text}`);
  }
  return res.json();
}

// Fetch entitlement + embedded product keys from EMS
export async function fetchEntitlementFromEMS(entitlementId) {
  if (!circuitAllow()) throw new Error('circuit_open');

  try {
    const data = await emsGet(`/entitlements/${entitlementId}?embed=productKeys,customer`);
    circuitSuccess();
    return data;
  } catch (err) {
    circuitFailure();
    throw err;
  }
}

// Activate against entitlement (consumes 1 token)
export async function activateEntitlement(entitlementId, userId) {
  const body = {
    activations: {
      activation: [
        {
          quantity: 1,
          activatee: { uniqueId: userId },
        }
      ]
    }
  };
  return emsPost(`/entitlements/${entitlementId}/activations`, body);
}

// Deactivate (return token to pool)
export async function deactivateEntitlement(entitlementId, activationId) {
  const res = await fetch(
    `${EMS_BASE_URL}/ems/api/v5/entitlements/${entitlementId}/activations/${activationId}`,
    {
      method: 'DELETE',
      headers: { Authorization: emsAuth() },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) throw new Error(`EMS deactivate failed: ${res.status}`);
  return true;
}

export function getCircuitState() {
  return { ...circuit };
}
