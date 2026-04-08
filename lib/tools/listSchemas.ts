import { CONFIG } from '@/lib/config';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

export async function listSchemas(
  db: DBType,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ schemas: string[] }>> {
  try {
    if (db === 'postgres') {
      const result = await queryPostgres<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
         ORDER BY schema_name`,
        [],
        credentials?.postgres
      );

      const allowedSchemas = new Set(CONFIG.app.allowedSchemas);
      const schemas = result.rows
        .map((row) => row.schema_name)
        .filter((schemaName) => allowedSchemas.has(schemaName));

      return {
        success: true,
        data: { schemas },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SELECT name AS schema_name
         FROM sys.schemas
         WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA')
         ORDER BY name`,
        {},
        credentials?.mssql
      );

      const allowedSchemas = new Set(CONFIG.app.allowedSchemas);
      const schemas = (result.rows as Array<{ schema_name: string }>)
        .map((row) => row.schema_name)
        .filter((schemaName) => allowedSchemas.has(schemaName));

      return {
        success: true,
        data: { schemas },
        error: null
      };
    }

    if (db === 'mysql') {
      const result = (await queryMySQL(
        'SELECT DATABASE() AS schema_name',
        credentials
      )) as Array<{ schema_name: string | null }>;

      const schemas = result
        .map((row) => row.schema_name)
        .filter((schemaName): schemaName is string => Boolean(schemaName));

      return {
        success: true,
        data: { schemas },
        error: null
      };
    }

    if (db === 'sqlite') {
      const result = (await querySQLite('PRAGMA database_list', credentials)) as Array<{ name: string }>;
      const schemas = result.map((row) => row.name).filter(Boolean);

      return {
        success: true,
        data: { schemas },
        error: null
      };
    }

    return {
      success: false,
      data: null,
      error: 'Unsupported database type'
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to list schemas.'
    };
  }
}