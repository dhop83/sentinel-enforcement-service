import {
  fetchEntitlementFromEMS,
  activateEntitlement,
  deactivateEntitlement,
} from './ems-client.js';

import {
  cacheGet,
  cacheSet,
  cacheInvalidate,
  isRefreshing,
  markRefreshing,
  clearRefreshing,
} from './cache.js';

const FAIL_MODE = (process.env.ENFORCEMENT_FAIL_MODE || 'open').toLowerCase();

// ─── Parse EMS entitlement into a clean decision object ───────────────────────

function parseEntitlement(raw) {
  const state = raw?.state || 'UNKNOWN';
  const endDate = raw?.endDate;
  const productKeys = raw?.productKeys?.productKey || [];

  // Build feature map: featureName → { id, available, activated }
  const features = {};
  for (const pk of productKeys) {
    const name = pk?.product?.name || pk?.product?.identifier;
    if (name) {
      features[name.toLowerCase()] = {
        id: pk?.product?.id,
        availableQuantity: pk?.availableQuantity ?? null,
        activatedQuantity: pk?.activatedQuantity ?? null,
        totalQuantity: pk?.quantity ?? null,
      };
    }
  }

  const isActive = state === 'ACTIVE' || state === 'COMPLETED';
  const isExpired = endDate ? new Date(endDate) < new Date() : false;

  return {
    id: raw?.id,
    state,
    isActive,
    isExpired,
    customer: raw?.customer?.name || raw?.customer?.id || 'unknown',
    endDate: endDate || null,
    features,
    raw,
  };
}

// ─── Fetch + cache entitlement ────────────────────────────────────────────────

async function getEntitlement(entitlementId) {
  const cacheKey = `ent:${entitlementId}`;
  const cached = await cacheGet(cacheKey);

  // FRESH — return immediately
  if (cached.hit && cached.fresh) {
    return { entitlement: cached.value, fromCache: true, stale: false };
  }

  // STALE — return immediately + trigger background refresh
  if (cached.hit && cached.stale) {
    if (!isRefreshing(cacheKey)) {
      markRefreshing(cacheKey);
      fetchEntitlementFromEMS(entitlementId)
        .then(raw => cacheSet(cacheKey, parseEntitlement(raw)))
        .catch(err => console.warn(`[enforcement] Background refresh failed for ${entitlementId}:`, err.message))
        .finally(() => clearRefreshing(cacheKey));
    }
    return { entitlement: cached.value, fromCache: true, stale: true };
  }

  // MISS — synchronous EMS call
  try {
    const raw = await fetchEntitlementFromEMS(entitlementId);
    const entitlement = parseEntitlement(raw);
    await cacheSet(cacheKey, entitlement);
    return { entitlement, fromCache: false, stale: false };
  } catch (err) {
    // EMS unreachable — apply fail mode
    if (FAIL_MODE === 'open') {
      console.warn(`[enforcement] EMS unreachable — fail-open for ${entitlementId}`);
      return {
        entitlement: null,
        fromCache: false,
        stale: false,
        failOpen: true,
        error: err.message,
      };
    }
    throw err;
  }
}

// ─── Main: Check ──────────────────────────────────────────────────────────────
// Validates entitlement state + feature access + qty
// Does NOT consume a token — call activate() for that

export async function check(entitlementId, featureId) {
  const start = Date.now();

  let result;
  try {
    result = await getEntitlement(entitlementId);
  } catch (err) {
    return {
      valid: false,
      reason: 'ems_unreachable',
      detail: err.message,
      latencyMs: Date.now() - start,
    };
  }

  // Fail-open: EMS down, no cache — allow through
  if (result.failOpen) {
    return {
      valid: true,
      reason: 'fail_open',
      warning: 'EMS unreachable — access granted by fail-open policy',
      latencyMs: Date.now() - start,
    };
  }

  const { entitlement } = result;

  // Check 1: entitlement active
  if (!entitlement.isActive) {
    return {
      valid: false,
      reason: 'entitlement_inactive',
      state: entitlement.state,
      customer: entitlement.customer,
      latencyMs: Date.now() - start,
    };
  }

  // Check 2: not expired
  if (entitlement.isExpired) {
    return {
      valid: false,
      reason: 'entitlement_expired',
      endDate: entitlement.endDate,
      customer: entitlement.customer,
      latencyMs: Date.now() - start,
    };
  }

  // Check 3: feature entitlement (if featureId provided)
  if (featureId) {
    const featureKey = featureId.toLowerCase();
    const feature = entitlement.features[featureKey];

    if (!feature) {
      return {
        valid: false,
        reason: 'feature_not_entitled',
        feature: featureId,
        availableFeatures: Object.keys(entitlement.features),
        customer: entitlement.customer,
        latencyMs: Date.now() - start,
      };
    }

    // Check 4: quantity available (if qty is tracked)
    if (feature.availableQuantity !== null && feature.availableQuantity <= 0) {
      return {
        valid: false,
        reason: 'quota_exceeded',
        feature: featureId,
        activatedQuantity: feature.activatedQuantity,
        totalQuantity: feature.totalQuantity,
        availableQuantity: feature.availableQuantity,
        customer: entitlement.customer,
        latencyMs: Date.now() - start,
      };
    }

    return {
      valid: true,
      reason: 'ok',
      feature: featureId,
      availableQuantity: feature.availableQuantity,
      activatedQuantity: feature.activatedQuantity,
      totalQuantity: feature.totalQuantity,
      customer: entitlement.customer,
      fromCache: result.fromCache,
      stale: result.stale,
      latencyMs: Date.now() - start,
    };
  }

  // No feature check — just entitlement validity
  return {
    valid: true,
    reason: 'ok',
    customer: entitlement.customer,
    features: Object.keys(entitlement.features),
    fromCache: result.fromCache,
    stale: result.stale,
    latencyMs: Date.now() - start,
  };
}

// ─── Activate: Check + Consume Token ─────────────────────────────────────────

export async function activate(entitlementId, featureId, userId) {
  const start = Date.now();

  // First run the validity check
  const validity = await check(entitlementId, featureId);
  if (!validity.valid && validity.reason !== 'fail_open') {
    return { success: false, ...validity };
  }

  // Call EMS to activate (consume 1 token)
  try {
    const activation = await activateEntitlement(entitlementId, userId);

    // Invalidate cache — qty just changed
    await cacheInvalidate(`ent:${entitlementId}`);

    return {
      success: true,
      activationId: activation?.activation?.id || activation?.id,
      customer: validity.customer,
      feature: featureId,
      userId,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      reason: 'activation_failed',
      detail: err.message,
      latencyMs: Date.now() - start,
    };
  }
}

// ─── Deactivate: Return Token to Pool ────────────────────────────────────────

export async function deactivate(entitlementId, activationId) {
  try {
    await deactivateEntitlement(entitlementId, activationId);
    await cacheInvalidate(`ent:${entitlementId}`);
    return { success: true };
  } catch (err) {
    return { success: false, detail: err.message };
  }
}

// ─── Invalidate cache entry (called by webhook) ───────────────────────────────

export async function invalidate(entitlementId) {
  await cacheInvalidate(`ent:${entitlementId}`);
}
