import mysql from 'mysql2/promise';

import { CONFIG } from '@/lib/config';
import type { DatabaseCredentials } from '@/lib/types';

let defaultPool: mysql.Pool | null = null;

function logMySqlEvent(message: string, error?: unknown): void {
  if (error) {
    console.error(`[mysql] ${message}`, error);
    return;
  }

  console.info(`[mysql] ${message}`);
}

function getDefaultPool(): mysql.Pool {
  if (defaultPool) return defaultPool;

  const host = process.env.MYSQL_HOST || 'localhost';
  const port = parseInt(process.env.MYSQL_PORT || '3306');
  const user = process.env.MYSQL_USER || 'root';
  const password = process.env.MYSQL_PASSWORD || '';
  const database = process.env.MYSQL_DATABASE || '';

  defaultPool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });

  logMySqlEvent('default pool created');

  return defaultPool;
}

function getDynamicPool(credentials: DatabaseCredentials): mysql.Pool {
  if (!credentials.mysql) {
    throw new Error('MySQL credentials not provided');
  }

  return mysql.createPool({
    host: credentials.mysql.host,
    port: credentials.mysql.port,
    user: credentials.mysql.username,
    password: credentials.mysql.password,
    database: credentials.mysql.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });
}

async function withPoolConnection<T>(credentials: DatabaseCredentials | undefined, work: (connection: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const pool = credentials ? getDynamicPool(credentials) : getDefaultPool();
  let connection: mysql.PoolConnection | null = null;

  try {
    connection = await pool.getConnection();
    return await work(connection);
  } finally {
    connection?.release();

    if (credentials) {
      try {
        await pool.end();
        logMySqlEvent('dynamic pool closed');
      } catch (error) {
        logMySqlEvent('failed to close dynamic pool', error);
      }
    }
  }
}

export async function queryMySQL(
  query: string,
  credentials?: DatabaseCredentials,
  params: unknown[] = []
): Promise<unknown> {
  return withPoolConnection(credentials, async (connection) => {
    const [rows] = await connection.query({ sql: query, timeout: CONFIG.app.queryTimeoutMs }, params);
    return rows;
  });
}

export async function getTablesMySQL(
  credentials?: DatabaseCredentials
): Promise<string[]> {
  return withPoolConnection(credentials, async (connection) => {
    const [rows] = await connection.query(
      'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()'
    );

    return (rows as Array<{ TABLE_NAME: string }>).map((row) => row.TABLE_NAME);
  });
}

export async function getSchemaMySQL(
  table: string,
  credentials?: DatabaseCredentials
): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
  return withPoolConnection(credentials, async (connection) => {
    const [rows] = await connection.query(
      'SELECT COLUMN_NAME as name, COLUMN_TYPE as type, IS_NULLABLE as nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table]
    );

    return (rows as Array<{ name: string; type: string; nullable: string }>).map(
      (row) => ({
        name: row.name,
        type: row.type,
        nullable: row.nullable === 'YES'
      })
    );
    });
}

export async function getRelationshipsMySQL(
  table?: string,
  credentials?: DatabaseCredentials
): Promise<Array<{ constraint: string; table: string; column: string; referenced_table: string; referenced_column: string }>> {
  return withPoolConnection(credentials, async (connection) => {
    let query = `
      SELECT 
        CONSTRAINT_NAME as constraint,
        TABLE_NAME as \`table\`,
        COLUMN_NAME as \`column\`,
        REFERENCED_TABLE_NAME as referenced_table,
        REFERENCED_COLUMN_NAME as referenced_column
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
    `;

    const params: string[] = [];
    if (table) {
      query += ' AND TABLE_NAME = ?';
      params.push(table);
    }

    const [rows] = await connection.query(query, params);
    return rows as Array<{ constraint: string; table: string; column: string; referenced_table: string; referenced_column: string }>;
  });
}
