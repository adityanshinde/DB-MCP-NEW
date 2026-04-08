import { CONFIG } from '@/lib/config';
import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter, truncateText } from '@/lib/tools/toolUtils';

type ColumnRow = {
  name: string;
  type: string;
  nullable: boolean;
};

function quoteSqlite(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function getColumns(db: DBType, view: string, schema?: string, credentials?: DatabaseCredentials): Promise<ColumnRow[]> {
  if (db === 'postgres') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryPostgres<ColumnRow>(
      `SELECT column_name AS name,
              data_type AS type,
              is_nullable = 'YES' AS nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [resolvedSchema, view],
      credentials?.postgres
    );
    return result.rows;
  }

  if (db === 'mssql') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryMSSQL(
      `SELECT column_name AS name,
              data_type AS type,
              CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END AS nullable
       FROM information_schema.columns
       WHERE table_schema = @schemaName AND table_name = @viewName
       ORDER BY ordinal_position`,
      { schemaName: resolvedSchema, viewName: view },
      credentials?.mssql
    );
    return result.rows as ColumnRow[];
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT COLUMN_NAME AS name,
              COLUMN_TYPE AS type,
              IS_NULLABLE = 'YES' AS nullable
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      credentials,
      [view]
    )) as ColumnRow[];
    return rows;
  }

  if (db === 'sqlite') {
    const rows = (await querySQLite(`PRAGMA table_info(${quoteSqlite(view)})`, credentials)) as Array<{ name: string; type: string; notnull: number }>;
    return rows.map((row) => ({ name: row.name, type: row.type, nullable: row.notnull === 0 }));
  }

  return [];
}

async function getDefinition(db: DBType, view: string, schema?: string, credentials?: DatabaseCredentials): Promise<string> {
  if (db === 'postgres') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryPostgres<{ definition: string | null }>(
      `SELECT view_definition AS definition
       FROM information_schema.views
       WHERE table_schema = $1 AND table_name = $2`,
      [resolvedSchema, view],
      credentials?.postgres
    );
    return result.rows[0]?.definition ?? '';
  }

  if (db === 'mssql') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryMSSQL(
      `SELECT OBJECT_DEFINITION(v.object_id) AS definition
       FROM sys.views v
       INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
       WHERE s.name = @schemaName AND v.name = @viewName`,
      { schemaName: resolvedSchema, viewName: view },
      credentials?.mssql
    );
    return String((result.rows[0] as { definition?: string | null } | undefined)?.definition ?? '');
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT VIEW_DEFINITION AS definition
       FROM INFORMATION_SCHEMA.VIEWS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      credentials,
      [view]
    )) as Array<{ definition: string | null }>;
    return rows[0]?.definition ?? '';
  }

  if (db === 'sqlite') {
    const rows = (await querySQLite(
      `SELECT sql AS definition
       FROM sqlite_master
       WHERE type = 'view' AND name = ?`,
      credentials,
      [view]
    )) as Array<{ definition: string | null }>;
    return rows[0]?.definition ?? '';
  }

  return '';
}

export async function getViewSummary(
  db: DBType,
  view: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ view: string; schema: string; column_count: number; columns_preview: ColumnRow[]; has_more_columns: boolean; definition_preview: string }>> {
  try {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const data = await readThroughMetadataCache({
      db,
      tool: 'getViewSummary',
      schema: resolvedSchema,
      params: { view },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.summary,
      fetcher: async () => {
        const columns = await getColumns(db, view, schema, credentials);
        const definition = await getDefinition(db, view, schema, credentials);
        const previewLimit = CONFIG.app.previewRows || 5;
        const columnsPreview = columns.slice(0, previewLimit);

        return {
          view,
          schema: resolvedSchema,
          column_count: columns.length,
          columns_preview: columnsPreview,
          has_more_columns: columns.length > columnsPreview.length,
          definition_preview: truncateText(definition, 250)
        };
      }
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to summarize view.'
    };
  }
}