import { CONFIG } from '@/lib/config';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

function resolveSchemas(db: DBType, schema?: string): string[] {
  const fallback = db === 'postgres' ? 'public' : 'dbo';

  if (schema) {
    const resolved = schema.trim();

    if (!CONFIG.app.allowedSchemas.includes(resolved)) {
      throw new Error(`Schema ${resolved} is not allowed. Allowed schemas: ${CONFIG.app.allowedSchemas.join(', ')}.`);
    }

    return [resolved];
  }

  return CONFIG.app.allowedSchemas.length > 0 ? CONFIG.app.allowedSchemas : [fallback];
}

export async function searchTables(
  db: DBType,
  query: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ query: string; matches: Array<{ schema?: string; table: string }> }>> {
  try {
    const search = query.trim();

    if (!search) {
      throw new Error('Search query is required.');
    }

    if (db === 'postgres') {
      const schemas = resolveSchemas(db, schema);
      const result = await queryPostgres<{ schemaname: string; tablename: string }>(
        `SELECT schemaname, tablename
         FROM pg_catalog.pg_tables
         WHERE schemaname = ANY($1::text[])
           AND tablename ILIKE $2
         ORDER BY schemaname, tablename`,
        [schemas, `%${search}%`],
        credentials?.postgres
      );

      return {
        success: true,
        data: {
          query: search,
          matches: result.rows.map((row) => ({
            schema: row.schemaname,
            table: row.tablename
          }))
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const schemas = resolveSchemas(db, schema);
      const params: Record<string, unknown> = {
        pattern: `%${search}%`
      };
      const schemaPlaceholders = schemas
        .map((schemaName, index) => {
          const paramName = `schema${index}`;
          params[paramName] = schemaName;
          return `@${paramName}`;
        })
        .join(', ');

      const result = await queryMSSQL(
        `SELECT sch.name AS schema_name, tbl.name AS table_name
         FROM sys.tables tbl
         INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
         WHERE sch.name IN (${schemaPlaceholders})
           AND tbl.name LIKE @pattern
         ORDER BY sch.name, tbl.name`,
        params,
        credentials?.mssql
      );

      return {
        success: true,
        data: {
          query: search,
          matches: (result.rows as Array<{ schema_name: string; table_name: string }>).map((row) => ({
            schema: row.schema_name,
            table: row.table_name
          }))
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const result = (await queryMySQL(
        `SELECT TABLE_NAME AS table_name
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME LIKE ?
         ORDER BY TABLE_NAME`,
        credentials,
        [`%${search}%`]
      )) as Array<{ table_name: string }>;

      return {
        success: true,
        data: {
          query: search,
          matches: result.map((row) => ({
            table: row.table_name
          }))
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const result = (await querySQLite(
        `SELECT name AS table_name
         FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name LIKE ?
         ORDER BY name`,
        credentials,
        [`%${search}%`]
      )) as Array<{ table_name: string }>;

      return {
        success: true,
        data: {
          query: search,
          matches: result.map((row) => ({
            table: row.table_name
          }))
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
      error: error instanceof Error ? error.message : 'Failed to search tables.'
    };
  }
}