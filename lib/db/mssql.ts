import sql from 'mssql';

import { CONFIG } from '@/lib/config';
import type { DatabaseCredentials } from '@/lib/types';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function logMssqlEvent(message: string, error?: unknown): void {
  if (error) {
    console.error(`[mssql] ${message}`, error);
    return;
  }

  console.info(`[mssql] ${message}`);
}

function createStaticPool(): Promise<sql.ConnectionPool> {
  if (CONFIG.mssql.connectionString.trim()) {
    const connectionPool = new sql.ConnectionPool(CONFIG.mssql.connectionString);
    connectionPool.on('error', (error) => {
      logMssqlEvent('pool error observed', error);
    });

    logMssqlEvent('static pool created');
    return connectionPool.connect();
  }

  throw new Error('MSSQL credentials are not fully configured. Set MSSQL_CONNECTION_STRING.');
}

function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = createStaticPool();
  }

  return poolPromise as Promise<sql.ConnectionPool>;
}

function getDynamicPool(credentials: DatabaseCredentials['mssql']): Promise<sql.ConnectionPool> {
  if (!credentials) {
    throw new Error('MSSQL credentials not provided.');
  }

  const connectionPool = new sql.ConnectionPool({
    user: credentials.username,
    password: credentials.password,
    server: credentials.server,
    database: credentials.database,
    options: {
      encrypt: true,
      trustServerCertificate: false
    },
    connectionTimeout: CONFIG.app.queryTimeoutMs,
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 5_000
    }
  });

  connectionPool.on('error', (error) => {
    logMssqlEvent('dynamic pool error observed', error);
  });

  logMssqlEvent('dynamic pool created');
  return connectionPool.connect();
}

export async function queryMSSQL(
  sqlText: string,
  params: Record<string, unknown> = {},
  credentials?: DatabaseCredentials['mssql']
) {
  const isDynamic = Boolean(credentials);
  const pool = credentials ? await getDynamicPool(credentials) : await getPool();
  let didFail = false;

  try {
    const request = pool.request();
    (request as sql.Request & { timeout: number }).timeout = CONFIG.app.queryTimeoutMs;

    for (const [name, value] of Object.entries(params)) {
      request.input(name, value as never);
    }

    const result = await request.query(sqlText);

    return {
      rows: result.recordset,
      rowCount: result.rowsAffected?.[0] ?? result.recordset.length,
      columns: Object.keys(result.recordset[0] ?? {})
    };
  } catch (error) {
    didFail = true;
    const normalizedError = error instanceof Error ? error : new Error('Failed to execute MSSQL query.');
    logMssqlEvent('query failed', normalizedError);
    throw normalizedError;
  } finally {
    if (isDynamic) {
      try {
        await pool.close();
        logMssqlEvent(didFail ? 'dynamic pool closed after failure' : 'dynamic pool closed');
      } catch (error) {
        logMssqlEvent('failed to close dynamic pool', error);
      }
    }
  }
}
