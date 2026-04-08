import type { DBType, DatabaseCredentials } from '@/lib/types';

import { buildStableHash, getToolCacheMetrics, readThroughCache } from '@/lib/cache/toolCache';

type MetadataCacheOptions<T> = {
  db: DBType;
  tool: string;
  ttlSeconds: number;
  schema?: string;
  params?: Record<string, unknown>;
  credentials?: DatabaseCredentials;
  fetcher: () => Promise<T>;
};

export const METADATA_CACHE_TTLS = {
  tableSchema: 6 * 60 * 60,
  procedures: 30 * 60,
  relationships: 2 * 60 * 60,
  indexes: 2 * 60 * 60,
  constraints: 2 * 60 * 60,
  summary: 60 * 60,
  analytics: 30 * 60
} as const;

function normalizeKeyPart(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'all';
}

function fingerprintCredentials(credentials?: DatabaseCredentials): string {
  if (!credentials) {
    return 'default';
  }

  return buildStableHash(credentials);
}

function buildParamsHash(params?: Record<string, unknown>): string {
  return buildStableHash(params ?? {});
}

function buildCacheKey(options: Pick<MetadataCacheOptions<unknown>, 'db' | 'tool' | 'schema' | 'params' | 'credentials'>): string {
  const schemaPart = normalizeKeyPart(options.schema);
  const credentialPart = fingerprintCredentials(options.credentials);
  const paramsPart = buildParamsHash(options.params);

  return `metadata:${options.db}:${schemaPart}:${options.tool}:${credentialPart}:${paramsPart}`;
}

export function getMetadataCacheKey(options: Pick<MetadataCacheOptions<unknown>, 'db' | 'tool' | 'schema' | 'params' | 'credentials'>): string {
  return buildCacheKey(options);
}

export function getMetadataCacheMetrics(): ReturnType<typeof getToolCacheMetrics> {
  return getToolCacheMetrics();
}

export async function readThroughMetadataCache<T>(options: MetadataCacheOptions<T>): Promise<T> {
  return readThroughCache({
    key: buildCacheKey(options),
    ttlSeconds: options.ttlSeconds,
    fetcher: options.fetcher
  });
}