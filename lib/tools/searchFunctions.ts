import { CONFIG } from '@/lib/config';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
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

export async function searchFunctions(
  db: DBType,
  query: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ query: string; matches: Array<{ schema?: string; function: string; return_type?: string }> }>> {
  try {
    const search = query.trim();
    if (!search) {
      throw new Error('Search query is required.');
    }

    const rowLimit = clampLimit(limit);

    if (db === 'postgres') {
      const schemas = resolveSchemas(db, schema);
      const result = await queryPostgres<{ schema_name: string; function_name: string; return_type: string | null }>(
        `SELECT routine_schema AS schema_name,
                routine_name AS function_name,
                data_type AS return_type
         FROM information_schema.routines
         WHERE routine_type = 'FUNCTION'
           AND routine_schema = ANY($1::text[])
           AND routine_name ILIKE $2
         ORDER BY routine_schema, routine_name
         LIMIT $3`,
        [schemas, `%${search}%`, rowLimit],
        credentials?.postgres
      );

      return {
        success: true,
        data: {
          query: search,
          matches: result.rows.map((row) => ({ schema: row.schema_name, function: row.function_name, return_type: row.return_type ?? undefined }))
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
        `SELECT routine_schema AS schema_name,
                routine_name AS function_name,
                data_type AS return_type
         FROM information_schema.routines
         WHERE routine_type = 'FUNCTION'
           AND routine_schema IN (${schemaPlaceholders})
           AND routine_name LIKE @pattern
         ORDER BY routine_schema, routine_name`,
        params,
        credentials?.mssql
      );

      return {
        success: true,
        data: {
          query: search,
          matches: (result.rows as Array<{ schema_name: string; function_name: string; return_type: string | null }>).slice(0, rowLimit).map((row) => ({
            schema: row.schema_name,
            function: row.function_name,
            return_type: row.return_type ?? undefined
          }))
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `SELECT routine_schema AS schema_name,
                routine_name AS function_name,
                data_type AS return_type
         FROM information_schema.routines
         WHERE routine_type = 'FUNCTION'
           AND routine_schema = DATABASE()
           AND routine_name LIKE ?
         ORDER BY routine_name`,
        credentials,
        [`%${search}%`]
      )) as Array<{ schema_name: string; function_name: string; return_type: string | null }>;

      return {
        success: true,
        data: {
          query: search,
          matches: rows.slice(0, rowLimit).map((row) => ({
            schema: row.schema_name,
            function: row.function_name,
            return_type: row.return_type ?? undefined
          }))
        },
        error: null
      };
    }

    return {
      success: true,
      data: { query: search, matches: [] },
      error: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to search functions.'
    };
  }
}