import crypto from 'node:crypto';

import { Redis } from '@upstash/redis';

type CacheEnvelope<T> = {
  value: T;
  expiresAt: number;
};

type CacheMetrics = {
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  l2Errors: number;
  dbFetches: number;
  payloadBytesWritten: number;
  payloadBytesRead: number;
  payloadTooLarge: number;
};

type ReadThroughCacheOptions<T> = {
  key: string;
  ttlSeconds: number;
  fetcher: () => Promise<T>;
};

type ReadThroughCacheResult<T> = {
  value: T;
  cacheStatus: 'l1' | 'l2' | 'miss';
};

const L1_ENABLED = process.env.MCP_CACHE_L1 !== 'false';
const L1_MAX_ENTRIES = Math.max(1, Number(process.env.MCP_CACHE_L1_MAX_ENTRIES || '256'));
const MAX_PAYLOAD_BYTES = Math.max(10_000, Number(process.env.MCP_CACHE_MAX_PAYLOAD_BYTES || '500000'));

let redisClient: Redis | null | undefined;
const l1Cache = new Map<string, CacheEnvelope<unknown>>();
const cacheMetrics: CacheMetrics = {
  l1Hits: 0,
  l1Misses: 0,
  l2Hits: 0,
  l2Misses: 0,
  l2Errors: 0,
  dbFetches: 0,
  payloadBytesWritten: 0,
  payloadBytesRead: 0,
  payloadTooLarge: 0
};

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function buildStableHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function measurePayloadBytes(value: unknown): number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value);
  }

  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }

  return Buffer.byteLength(JSON.stringify(value));
}

function recordPayloadBytes(value: unknown, direction: 'read' | 'write'): number {
  const bytes = measurePayloadBytes(value);
  if (direction === 'read') {
    cacheMetrics.payloadBytesRead += bytes;
  } else {
    cacheMetrics.payloadBytesWritten += bytes;
  }

  return bytes;
}

function parseEnvelope<T>(raw: unknown): CacheEnvelope<T> | null {
  if (!raw) {
    return null;
  }

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CacheEnvelope<T>;
    } catch {
      return null;
    }
  }

  if (typeof raw === 'object') {
    const envelope = raw as Partial<CacheEnvelope<T>>;
    if (typeof envelope.expiresAt === 'number' && 'value' in envelope) {
      return envelope as CacheEnvelope<T>;
    }
  }

  return null;
}

function getRedisClient(): Redis | null {
  if (redisClient !== undefined) {
    return redisClient;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    redisClient = null;
    return null;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function getL1<T>(key: string): T | null {
  const entry = l1Cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    l1Cache.delete(key);
    return null;
  }

  return entry.value as T;
}

function pruneL1(): void {
  while (l1Cache.size > L1_MAX_ENTRIES) {
    const oldestKey = l1Cache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }

    l1Cache.delete(oldestKey);
  }
}

function setL1<T>(key: string, value: T, ttlSeconds: number): void {
  if (!L1_ENABLED) {
    return;
  }

  l1Cache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000
  });

  pruneL1();
}

async function getL2<T>(key: string): Promise<T | null> {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  try {
    const raw = await client.get<unknown>(key);
    if (!raw) {
      return null;
    }

    recordPayloadBytes(raw, 'read');

    const parsed = parseEnvelope<T>(raw);
    if (!parsed || parsed.expiresAt <= Date.now()) {
      return null;
    }

    return parsed.value;
  } catch (error) {
    cacheMetrics.l2Errors += 1;
    console.warn('[tool-cache] L2 read failed; falling back to source.', error);
    return null;
  }
}

async function setL2<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  try {
    const payload: CacheEnvelope<T> = {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000
    };

    const serialized = JSON.stringify(payload);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_PAYLOAD_BYTES) {
      cacheMetrics.payloadTooLarge += 1;
      console.warn(`[tool-cache] payload too large (${bytes} bytes > ${MAX_PAYLOAD_BYTES}); skipping cache write for ${key}`);
      return;
    }

    recordPayloadBytes(serialized, 'write');
    await client.set(key, serialized, { ex: ttlSeconds });
  } catch (error) {
    cacheMetrics.l2Errors += 1;
    console.warn('[tool-cache] L2 write failed; continuing without cache.', error);
  }
}

export function getToolCacheMetrics(): CacheMetrics & { l1Size: number } {
  return {
    ...cacheMetrics,
    l1Size: l1Cache.size
  };
}

export async function readThroughCacheDetailed<T>(options: ReadThroughCacheOptions<T>): Promise<ReadThroughCacheResult<T>> {
  const l1Value = getL1<T>(options.key);
  if (l1Value !== null) {
    cacheMetrics.l1Hits += 1;
    recordPayloadBytes(l1Value, 'read');
    return { value: l1Value, cacheStatus: 'l1' };
  }

  cacheMetrics.l1Misses += 1;

  const l2Value = await getL2<T>(options.key);
  if (l2Value !== null) {
    cacheMetrics.l2Hits += 1;
    recordPayloadBytes(l2Value, 'read');
    setL1(options.key, l2Value, options.ttlSeconds);
    return { value: l2Value, cacheStatus: 'l2' };
  }

  cacheMetrics.l2Misses += 1;
  cacheMetrics.dbFetches += 1;

  const value = await options.fetcher();
  setL1(options.key, value, options.ttlSeconds);
  await setL2(options.key, value, options.ttlSeconds);
  return { value, cacheStatus: 'miss' };
}

export async function readThroughCache<T>(options: ReadThroughCacheOptions<T>): Promise<T> {
  const result = await readThroughCacheDetailed(options);
  return result.value;
}