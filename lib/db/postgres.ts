import { Pool, type PoolClient, type QueryConfig, type QueryResultRow } from 'pg';

import { CONFIG } from '@/lib/config';
import type { DatabaseCredentials } from '@/lib/types';

let pool: Pool | null = null;

function logPostgresEvent(message: string, error?: unknown): void {
  if (error) {
    console.error(`[postgres] ${message}`, error);
    return;
  }

  console.info(`[postgres] ${message}`);
}

function getPool(): Pool {
  if (!CONFIG.postgres.url) {
    throw new Error('POSTGRES_URL is not configured.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: CONFIG.postgres.url,
      max: 10,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      connectionTimeoutMillis: CONFIG.app.queryTimeoutMs
    });

    pool.on('error', (error) => {
      logPostgresEvent('pool error; discarding static pool', error);
      pool = null;
    });

    logPostgresEvent('static pool created');
  }

  return pool;
}

function getDynamicPool(credentials: DatabaseCredentials['postgres']): Pool {
  if (!credentials) {
    throw new Error('PostgreSQL credentials not provided.');
  }

  const connectionString = `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${credentials.host}:${credentials.port}/${credentials.database}`;

  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    connectionTimeoutMillis: CONFIG.app.queryTimeoutMs
  });
}

async function acquireClient(currentPool: Pool): Promise<PoolClient> {
  return currentPool.connect();
}

export async function queryPostgres<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  credentials?: DatabaseCredentials['postgres']
) {
  const isDynamic = Boolean(credentials);
  const currentPool = credentials ? getDynamicPool(credentials) : getPool();
  let client: PoolClient | null = null;
  let releaseError: Error | undefined;

  try {
    client = await acquireClient(currentPool);

    const result = await client.query<T>({
      text: sql,
      values: params,
      query_timeout: CONFIG.app.queryTimeoutMs
    } as QueryConfig<unknown[]>);

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map((field: { name: string }) => field.name)
    };
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error('Failed to execute PostgreSQL query.');
    logPostgresEvent('query failed', releaseError);
    throw releaseError;
  } finally {
    if (client) {
      client.release(releaseError);
    }

    if (isDynamic) {
      try {
        await currentPool.end();
        logPostgresEvent('dynamic pool closed');
      } catch (error) {
        logPostgresEvent('failed to close dynamic pool', error);
      }
    }
  }
}
