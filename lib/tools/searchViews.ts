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

function clampLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit ?? NaN) ? Number(limit) : 10;
  return Math.max(1, Math.min(20, requested));
}

export async function searchViews(
  db: DBType,
  query: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ query: string; matches: Array<{ schema?: string; view: string }> }>> {
  try {
    const search = query.trim();
    if (!search) {
      throw new Error('Search query is required.');
    }

    const rowLimit = clampLimit(limit);

    if (db === 'postgres') {
      const schemas = resolveSchemas(db, schema);
      const result = await queryPostgres<{ schema_name: string; view_name: string }>(
        `SELECT table_schema AS schema_name,
                table_name AS view_name
         FROM information_schema.views
         WHERE table_schema = ANY($1::text[])
           AND table_name ILIKE $2
         ORDER BY table_schema, table_name
         LIMIT $3`,
        [schemas, `%${search}%`, rowLimit],
        credentials?.postgres
      );

      return {
        success: true,
        data: {
          query: search,
          matches: result.rows.map((row) => ({ schema: row.schema_name, view: row.view_name }))
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const schemas = resolveSchemas(db, schema);
      const params: Record<string, unknown> = { pattern: `%${search}%` };
      const schemaPlaceholders = schemas.map((schemaName, index) => {
        const paramName = `schema${index}`;
        params[paramName] = schemaName;
        return `@${paramName}`;
      }).join(', ');

      const result = await queryMSSQL(
        `SELECT sch.name AS schema_name,
                v.name AS view_name
         FROM sys.views v
         INNER JOIN sys.schemas sch ON v.schema_id = sch.schema_id
         WHERE sch.name IN (${schemaPlaceholders})
           AND v.name LIKE @pattern
         ORDER BY sch.name, v.name`,
        params,
        credentials?.mssql
      );

      return {
        success: true,
        data: {
          query: search,
          matches: (result.rows as Array<{ schema_name: string; view_name: string }>).slice(0, rowLimit).map((row) => ({ schema: row.schema_name, view: row.view_name }))
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `SELECT TABLE_SCHEMA AS schema_name,
                TABLE_NAME AS view_name
         FROM INFORMATION_SCHEMA.VIEWS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME LIKE ?
         ORDER BY TABLE_NAME`,
        credentials,
        [`%${search}%`]
      )) as Array<{ schema_name: string; view_name: string }>;

      return {
        success: true,
        data: {
          query: search,
          matches: rows.slice(0, rowLimit).map((row) => ({ schema: row.schema_name, view: row.view_name }))
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const rows = (await querySQLite(
        `SELECT name AS view_name
         FROM sqlite_master
         WHERE type = 'view'
           AND name LIKE ?
         ORDER BY name`,
        credentials,
        [`%${search}%`]
      )) as Array<{ view_name: string }>;

      return {
        success: true,
        data: {
          query: search,
          matches: rows.slice(0, rowLimit).map((row) => ({ view: row.view_name }))
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
      error: error instanceof Error ? error.message : 'Failed to search views.'
    };
  }
}