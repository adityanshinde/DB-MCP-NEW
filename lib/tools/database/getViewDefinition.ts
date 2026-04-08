import { CONFIG } from '@/lib/config';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

function resolveSchema(db: DBType, schema?: string): string {
  const fallback = db === 'postgres' ? 'public' : 'dbo';
  const resolved = (schema || fallback).trim();

  if (!CONFIG.app.allowedSchemas.includes(resolved)) {
    throw new Error(`Schema ${resolved} is not allowed. Allowed schemas: ${CONFIG.app.allowedSchemas.join(', ')}.`);
  }

  return resolved;
}

export async function getViewDefinition(
  db: DBType,
  view: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ view: string; schema?: string; definition: string | null }>> {
  try {
    if (db === 'postgres') {
      const resolvedSchema = resolveSchema(db, schema);
      const result = await queryPostgres<{ schema_name: string; view_name: string; definition: string | null }>(
        `SELECT table_schema AS schema_name,
                table_name AS view_name,
                view_definition AS definition
         FROM information_schema.views
         WHERE table_schema = $1
           AND table_name = $2`,
        [resolvedSchema, view],
        credentials?.postgres
      );

      const row = result.rows[0] ?? null;
      return {
        success: true,
        data: {
          view,
          schema: row?.schema_name ?? resolvedSchema,
          definition: row?.definition ?? null
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const resolvedSchema = resolveSchema(db, schema);
      const result = await queryMSSQL(
        `SELECT sch.name AS schema_name,
                v.name AS view_name,
                OBJECT_DEFINITION(v.object_id) AS definition
         FROM sys.views v
         INNER JOIN sys.schemas sch ON v.schema_id = sch.schema_id
         WHERE sch.name = @schemaName
           AND v.name = @viewName`,
        {
          schemaName: resolvedSchema,
          viewName: view
        },
        credentials?.mssql
      );

      const row = result.rows[0] as { schema_name?: string; definition?: string | null } | undefined;
      return {
        success: true,
        data: {
          view,
          schema: row?.schema_name ?? resolvedSchema,
          definition: row?.definition ?? null
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const result = (await queryMySQL(
        `SELECT TABLE_SCHEMA AS schema_name,
                TABLE_NAME AS view_name,
                VIEW_DEFINITION AS definition
         FROM INFORMATION_SCHEMA.VIEWS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?`,
        credentials,
        [view]
      )) as Array<{ schema_name: string; view_name: string; definition: string | null }>;

      const row = result[0] ?? null;
      return {
        success: true,
        data: {
          view,
          schema: row?.schema_name,
          definition: row?.definition ?? null
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const result = (await querySQLite(
        `SELECT name AS view_name, sql AS definition
         FROM sqlite_master
         WHERE type = 'view'
           AND name = ?`,
        credentials,
        [view]
      )) as Array<{ view_name: string; definition: string | null }>;

      const row = result[0] ?? null;
      return {
        success: true,
        data: {
          view,
          definition: row?.definition ?? null
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
      error: error instanceof Error ? error.message : 'Failed to read view definition.'
    };
  }
}