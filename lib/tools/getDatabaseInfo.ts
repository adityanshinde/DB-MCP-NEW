import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

export async function getDatabaseInfo(
  db: DBType,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ database: Record<string, unknown> }>> {
  try {
    if (db === 'postgres') {
      const result = await queryPostgres(
        `SELECT current_database() AS database_name,
                current_user AS current_user,
                current_schema() AS current_schema,
                version() AS version`,
        [],
        credentials?.postgres
      );

      return {
        success: true,
        data: { database: result.rows[0] ?? {} },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SELECT DB_NAME() AS database_name,
                SUSER_SNAME() AS current_user,
                ORIGINAL_LOGIN() AS original_login,
                SCHEMA_NAME() AS current_schema,
                @@VERSION AS version`,
        {},
        credentials?.mssql
      );

      return {
        success: true,
        data: { database: (result.rows[0] as Record<string, unknown>) ?? {} },
        error: null
      };
    }

    if (db === 'mysql') {
      const result = (await queryMySQL(
        `SELECT DATABASE() AS database_name,
                CURRENT_USER() AS current_user,
                USER() AS session_user,
                VERSION() AS version`,
        credentials
      )) as Array<Record<string, unknown>>;

      return {
        success: true,
        data: { database: result[0] ?? {} },
        error: null
      };
    }

    if (db === 'sqlite') {
      const databases = (await querySQLite('PRAGMA database_list', credentials)) as Array<Record<string, unknown>>;
      const result = (await querySQLite('SELECT sqlite_version() AS version', credentials)) as Array<Record<string, unknown>>;

      return {
        success: true,
        data: {
          database: {
            databases,
            version: result[0] ?? {}
          }
        },
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
      error: error instanceof Error ? error.message : 'Failed to read database info.'
    };
  }
}