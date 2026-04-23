// ─── Cache: In-memory (default) + Redis (when REDIS_URL is set) ───────────────
//
// Strategy: stale-while-revalidate
//   - FRESH  (age < TTL)       → serve immediately, no EMS call
//   - STALE  (TTL < age < MAX) → serve immediately + refresh in background
//   - EXPIRED (age > MAX)      → must fetch from EMS synchronously

const TTL_MS       = parseInt(process.env.CACHE_TTL_MS       || '120000'); // 2 min fresh
const STALE_MAX_MS = parseInt(process.env.CACHE_STALE_MAX_MS || '300000'); // 5 min stale ok
const MAX_SIZE     = parseInt(process.env.CACHE_MAX_SIZE      || '10000');  // LRU eviction

// ─── In-Memory Store ──────────────────────────────────────────────────────────

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    return this.store.get(key) || null;
  }

  set(key, value) {
    // LRU eviction — delete oldest if at capacity
    if (this.store.size >= MAX_SIZE && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, cachedAt: Date.now() });
  }

  delete(key) {
    this.store.delete(key);
  }

  size() {
    return this.store.size;
  }

  keys() {
    return [...this.store.keys()];
  }
}

// ─── Redis Store (optional) ───────────────────────────────────────────────────

class RedisCache {
  constructor(client) {
    this.client = client;
    this.prefix = 'ems:enforcement:';
  }

  async get(key) {
    try {
      const raw = await this.client.get(this.prefix + key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async set(key, value) {
    try {
      const entry = { value, cachedAt: Date.now() };
      // Store for STALE_MAX_MS — cache layer handles freshness logic
      await this.client.setEx(
        this.prefix + key,
        Math.ceil(STALE_MAX_MS / 1000),
        JSON.stringify(entry)
      );
    } catch (err) {
      console.warn('[cache] Redis set failed:', err.message);
    }
  }

  async delete(key) {
    try {
      await this.client.del(this.prefix + key);
    } catch { /* ignore */ }
  }

  async size() {
    try {
      const keys = await this.client.keys(this.prefix + '*');
      return keys.length;
    } catch { return -1; }
  }
}

// ─── Cache Manager ────────────────────────────────────────────────────────────

let store = new MemoryCache();
let refreshing = new Set(); // track in-flight background refreshes

export async function initRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('[cache] Using in-memory cache (no REDIS_URL set)');
    return;
  }

  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: redisUrl });
    await client.connect();
    store = new RedisCache(client);
    console.log('[cache] Redis connected —', redisUrl);
  } catch (err) {
    console.warn('[cache] Redis failed, falling back to memory:', err.message);
  }
}

function isFresh(entry) {
  return Date.now() - entry.cachedAt < TTL_MS;
}

function isUsable(entry) {
  return Date.now() - entry.cachedAt < STALE_MAX_MS;
}

// Main cache read — returns { hit, fresh, stale, value }
export async function cacheGet(key) {
  const entry = await store.get(key);
  if (!entry) return { hit: false };

  if (isFresh(entry))   return { hit: true, fresh: true,  value: entry.value };
  if (isUsable(entry))  return { hit: true, fresh: false, stale: true, value: entry.value };

  // Fully expired — must re-fetch
  return { hit: false };
}

export async function cacheSet(key, value) {
  await store.set(key, value);
}

export async function cacheInvalidate(key) {
  console.log(`[cache] Invalidating: ${key}`);
  await store.delete(key);
}

export function isRefreshing(key) {
  return refreshing.has(key);
}

export function markRefreshing(key) {
  refreshing.add(key);
}

export function clearRefreshing(key) {
  refreshing.delete(key);
}

export async function cacheStats() {
  const size = typeof store.size === 'function' ? await store.size() : store.store?.size || 0;
  return {
    type: store instanceof MemoryCache ? 'memory' : 'redis',
    size,
    ttlMs: TTL_MS,
    staleMaxMs: STALE_MAX_MS,
    maxSize: MAX_SIZE,
  };
}
