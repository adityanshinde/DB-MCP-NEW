import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { Redis } from '@upstash/redis';

import { CONFIG } from '@/lib/config';
import { buildStableHash } from '@/lib/cache/toolCache';
import type { DatabaseCredentials, GitHubCredentials, UserCredentials } from '@/lib/types';

type ByocSessionRecord = {
  createdAt: number;
  updatedAt: number;
  credentials: UserCredentials;
};

type ByocRequestContext = {
  token?: string;
  credentials?: UserCredentials;
};

const requestContext = new AsyncLocalStorage<ByocRequestContext>();
let redisClient: Redis | null | undefined;

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

function getEncryptionKey(): Buffer {
  const rawKey = process.env.MCP_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!rawKey) {
    throw new Error('MCP_CREDENTIALS_ENCRYPTION_KEY is not configured.');
  }

  return crypto.createHash('sha256').update(rawKey).digest();
}

function encryptPayload(payload: ByocSessionRecord): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const serialized = JSON.stringify(payload);

  const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptPayload(payload: string): ByocSessionRecord {
  const [ivText, tagText, ciphertextText] = payload.split('.');

  if (!ivText || !tagText || !ciphertextText) {
    throw new Error('Encrypted BYOC payload is malformed.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final()
  ]).toString('utf8');

  return JSON.parse(decrypted) as ByocSessionRecord;
}

function getSessionKey(token: string): string {
  return `byoc:session:${buildStableHash(token)}`;
}

function getSessionTtlSeconds(): number {
  return CONFIG.byoc.sessionTtlSeconds;
}

export function runWithByocRequestContext<T>(context: ByocRequestContext, work: () => T): T {
  return requestContext.run(context, work);
}

export function getActiveByocRequestContext(): ByocRequestContext | undefined {
  return requestContext.getStore();
}

export function getActiveUserCredentials(): UserCredentials | undefined {
  return requestContext.getStore()?.credentials;
}

export function getActiveDatabaseCredentials(db: DatabaseCredentials['type']): DatabaseCredentials | undefined {
  const credentials = getActiveUserCredentials()?.db;
  if (!credentials || credentials.type !== db) {
    return undefined;
  }

  return credentials;
}

export function getActiveGitHubCredentials(): GitHubCredentials | undefined {
  return getActiveUserCredentials()?.github;
}

export function fingerprintDatabaseCredentials(credentials?: DatabaseCredentials): string {
  return buildStableHash(credentials ?? getActiveUserCredentials()?.db ?? null);
}

export function fingerprintGitHubCredentials(credentials?: GitHubCredentials): string {
  return buildStableHash(credentials ?? getActiveGitHubCredentials() ?? null);
}

export function isByocLoginConfigured(): boolean {
  return Boolean(process.env.MCP_APP_PASSWORD?.trim() && process.env.MCP_CREDENTIALS_ENCRYPTION_KEY?.trim());
}

export function verifyByocPassword(password: string): boolean {
  const configured = process.env.MCP_APP_PASSWORD?.trim();
  if (!configured) {
    return false;
  }

  const provided = password.trim();
  if (!provided) {
    return false;
  }

  const configuredBuffer = Buffer.from(configured, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (configuredBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(configuredBuffer, providedBuffer);
}

export async function createByocSessionToken(): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionRecord: ByocSessionRecord = {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    credentials: {}
  };

  const client = getRedisClient();
  if (!client) {
    throw new Error('Upstash Redis is required to persist BYOC sessions.');
  }

  await client.set(getSessionKey(token), encryptPayload(sessionRecord), {
    ex: getSessionTtlSeconds()
  });

  return token;
}

export async function loadByocSessionCredentials(token: string): Promise<UserCredentials | null> {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  const encrypted = await client.get<string>(getSessionKey(token));
  if (!encrypted) {
    return null;
  }

  const record = decryptPayload(encrypted);
  return record.credentials;
}

export async function saveByocSessionCredentials(token: string, credentials: UserCredentials): Promise<UserCredentials> {
  const client = getRedisClient();
  if (!client) {
    throw new Error('Upstash Redis is required to persist BYOC sessions.');
  }

  const existing = await loadByocSessionCredentials(token);
  if (existing === null) {
    throw new Error('Unknown BYOC session token.');
  }

  const merged: UserCredentials = {
    db: credentials.db ?? existing?.db,
    github: credentials.github ?? existing?.github
  };

  const sessionRecord: ByocSessionRecord = {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    credentials: merged
  };

  await client.set(getSessionKey(token), encryptPayload(sessionRecord), {
    ex: getSessionTtlSeconds()
  });

  return merged;
}

export async function clearByocSession(token: string): Promise<void> {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  await client.del(getSessionKey(token));
}

export function readByocToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization')?.trim();
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice('bearer '.length).trim();
    if (token) {
      return token;
    }
  }

  const headerToken = request.headers.get('X-Byoc-Token')?.trim();
  return headerToken || null;
}

export function readBodyCredentials(body: unknown): UserCredentials | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const maybeBody = body as { credentials?: UserCredentials };
  return maybeBody.credentials;
}
