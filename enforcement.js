import { fetchEntitlementFromEMS, activateEntitlement, deactivateEntitlement } from './ems-client.js';
import { cacheGet, cacheSet, cacheInvalidate, isRefreshing, markRefreshing, clearRefreshing } from './cache.js';

const FAIL_MODE = (process.env.ENFORCEMENT_FAIL_MODE || 'open').toLowerCase();

function parseEntitlement(raw) {
  const state = raw?.state || 'UNKNOWN';
  const endDate = raw?.expiry?.endDate || null;
  const productKeys = raw?.productKeys?.productKey || [];

  // Correct path: productKeys[].item.itemProduct.itemProductFeatures.itemProductFeature[]
  const features = {};
  for (const pk of productKeys) {
    const featureList = pk?.item?.itemProduct?.itemProductFeatures?.itemProductFeature || [];
    for (const f of featureList) {
      const name = f?.feature?.nameVersion?.name;
      if (name) {
        features[name.toLowerCase()] = {
          id: f?.feature?.id,
          availableQuantity: pk?.availableQuantity ?? null,
          activatedQuantity: (pk?.totalQuantity ?? 0) - (pk?.availableQuantity ?? 0),
          totalQuantity: pk?.totalQuantity ?? null,
        };
      }
    }
  }

  const isActive = ['ENABLE', 'ACTIVE', 'COMPLETED'].includes(state);
  const isExpired = endDate ? new Date(endDate) < new Date() : false;

  return {
    id: raw?.id,
    eId: raw?.eId,
    state,
    isActive,
    isExpired,
    customer: raw?.customer?.name || raw?.customer?.id || 'unknown',
    endDate,
    features,
  };
}

async function getEntitlement(entitlementId) {
  const cacheKey = `ent:${entitlementId}`;
  const cached = await cacheGet(cacheKey);

  if (cached.hit && cached.fresh) return { entitlement: cached.value, fromCache: true, stale: false };

  if (cached.hit && cached.stale) {
    if (!isRefreshing(cacheKey)) {
      markRefreshing(cacheKey);
      fetchEntitlementFromEMS(entitlementId)
        .then(raw => cacheSet(cacheKey, parseEntitlement(raw)))
        .catch(err => console.warn(`[enforcement] Background refresh failed:`, err.message))
        .finally(() => clearRefreshing(cacheKey));
    }
    return { entitlement: cached.value, fromCache: true, stale: true };
  }

  try {
    const raw = await fetchEntitlementFromEMS(entitlementId);
    const entitlement = parseEntitlement(raw);
    console.log(`[enforcement] Parsed entitlement — state: ${entitlement.state}, isActive: ${entitlement.isActive}, features: ${JSON.stringify(Object.keys(entitlement.features))}`);
    await cacheSet(cacheKey, entitlement);
    return { entitlement, fromCache: false, stale: false };
  } catch (err) {
    if (FAIL_MODE === 'open') {
      console.warn(`[enforcement] EMS unreachable — fail-open for ${entitlementId}`);
      return { entitlement: null, fromCache: false, stale: false, failOpen: true, error: err.message };
    }
    throw err;
  }
}

function runChecks(entitlement, featureId, start) {
  if (!entitlement.isActive) return { valid: false, reason: 'entitlement_inactive', state: entitlement.state, customer: entitlement.customer, latencyMs: Date.now() - start };
  if (entitlement.isExpired) return { valid: false, reason: 'entitlement_expired', customer: entitlement.customer, latencyMs: Date.now() - start };
  if (featureId) {
    const feature = entitlement.features[featureId.toLowerCase()];
    if (!feature) return { valid: false, reason: 'feature_not_entitled', feature: featureId, availableFeatures: Object.keys(entitlement.features), customer: entitlement.customer, latencyMs: Date.now() - start };
    if (feature.availableQuantity !== null && feature.availableQuantity <= 0) return { valid: false, reason: 'quota_exceeded', feature: featureId, availableQuantity: feature.availableQuantity, totalQuantity: feature.totalQuantity, customer: entitlement.customer, latencyMs: Date.now() - start };
    return { valid: true, feature: featureId, availableQuantity: feature.availableQuantity, activatedQuantity: feature.activatedQuantity, totalQuantity: feature.totalQuantity, customer: entitlement.customer };
  }
  return { valid: true, features: Object.keys(entitlement.features), customer: entitlement.customer };
}

export async function check(entitlementId, featureId) {
  const start = Date.now();
  let result;
  try { result = await getEntitlement(entitlementId); }
  catch (err) { return { valid: false, reason: 'ems_unreachable', detail: err.message, latencyMs: Date.now() - start }; }
  if (result.failOpen) return { valid: true, reason: 'fail_open', latencyMs: Date.now() - start };
  const checks = runChecks(result.entitlement, featureId, start);
  return { ...checks, reason: checks.valid ? 'ok' : checks.reason, fromCache: result.fromCache, stale: result.stale, latencyMs: Date.now() - start };
}

export async function activate(entitlementId, featureId, userId) {
  const start = Date.now();
  let result;
  try { result = await getEntitlement(entitlementId); }
  catch (err) { return { success: false, reason: 'ems_unreachable', detail: err.message, latencyMs: Date.now() - start }; }

  if (!result.failOpen) {
    const checks = runChecks(result.entitlement, featureId, start);
    if (!checks.valid) return { success: false, ...checks };
  }

  const activationUid = result.entitlement?.id || entitlementId;
  try {
    const activation = await activateEntitlement(activationUid, userId);
    await cacheInvalidate(`ent:${entitlementId}`);
    const activationId = activation?.activations?.activation?.[0]?.id || activation?.activation?.id || activation?.id;
    return { success: true, activationId, customer: result.entitlement?.customer, feature: featureId, userId, latencyMs: Date.now() - start };
  } catch (err) {
    return { success: false, reason: 'activation_failed', detail: err.message, latencyMs: Date.now() - start };
  }
}

export async function deactivate(entitlementId, activationId) {
  const cached = await cacheGet(`ent:${entitlementId}`);
  const internalUid = cached?.value?.id || entitlementId;
  try {
    await deactivateEntitlement(internalUid, activationId);
    await cacheInvalidate(`ent:${entitlementId}`);
    return { success: true };
  } catch (err) { return { success: false, detail: err.message }; }
}

export async function invalidate(entitlementId) {
  await cacheInvalidate(`ent:${entitlementId}`);
}
