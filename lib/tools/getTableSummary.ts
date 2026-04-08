import { CONFIG } from '@/lib/config';
import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { getSchemaSQLite, querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter, truncateText } from '@/lib/tools/toolUtils';

type ColumnRow = {
  name: string;
  type: string;
  nullable: boolean;
  ordinal_position?: number;
  column_key?: string;
};

function quotePg(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteMssql(identifier: string): string {
  return `[${identifier.replace(/]/g, ']]')}]`;
}

function quoteMysql(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function quoteSqlite(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function getColumns(db: DBType, table: string, schema?: string, credentials?: DatabaseCredentials): Promise<ColumnRow[]> {
  if (db === 'postgres') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryPostgres<{ name: string; type: string; nullable: boolean; ordinal_position: number }>(
      `SELECT column_name AS name,
              data_type AS type,
              is_nullable = 'YES' AS nullable,
              ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [resolvedSchema, table],
      credentials?.postgres
    );

    return result.rows;
  }

  if (db === 'mssql') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryMSSQL(
      `SELECT column_name AS name,
              data_type AS type,
              CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END AS nullable,
              ordinal_position
       FROM information_schema.columns
       WHERE table_schema = @schemaName AND table_name = @tableName
       ORDER BY ordinal_position`,
      {
        schemaName: resolvedSchema,
        tableName: table
      },
      credentials?.mssql
    );

    return result.rows as ColumnRow[];
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT COLUMN_NAME AS name,
              COLUMN_TYPE AS type,
              IS_NULLABLE = 'YES' AS nullable,
              ORDINAL_POSITION AS ordinal_position,
              COLUMN_KEY AS column_key
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      credentials,
      [table]
    )) as Array<ColumnRow>;

    return rows;
  }

  if (db === 'sqlite') {
    const rows = (await querySQLite(`PRAGMA table_info(${quoteSqlite(table)})`, credentials)) as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    return rows.map((row, index) => ({
      name: row.name,
      type: row.type,
      nullable: row.notnull === 0,
      ordinal_position: index + 1,
      column_key: row.pk > 0 ? 'PRI' : undefined
    }));
  }

  return [];
}

async function getPrimaryKeyColumns(db: DBType, table: string, schema?: string, credentials?: DatabaseCredentials): Promise<string[]> {
  if (db === 'postgres') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryPostgres<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1
         AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [resolvedSchema, table],
      credentials?.postgres
    );

    return result.rows.map((row) => row.column_name);
  }

  if (db === 'mssql') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryMSSQL(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = @schemaName
         AND tc.table_name = @tableName
       ORDER BY kcu.ordinal_position`,
      { schemaName: resolvedSchema, tableName: table },
      credentials?.mssql
    );

    return (result.rows as Array<{ column_name: string }>).map((row) => row.column_name);
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI'
       ORDER BY ORDINAL_POSITION`,
      credentials,
      [table]
    )) as Array<{ column_name: string }>;

    return rows.map((row) => row.column_name);
  }

  if (db === 'sqlite') {
    const rows = (await querySQLite(`PRAGMA table_info(${quoteSqlite(table)})`, credentials)) as Array<{ name: string; pk: number }>;
    return rows
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
  }

  return [];
}

export async function getTableSummary(
  db: DBType,
  table: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ table: string; schema: string; column_count: number; columns_preview: ColumnRow[]; has_more_columns: boolean; primary_key_columns: string[] }>> {
  try {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const data = await readThroughMetadataCache({
      db,
      tool: 'getTableSummary',
      schema: resolvedSchema,
      params: { table },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.summary,
      fetcher: async () => {
        const columns = await getColumns(db, table, schema, credentials);
        const primaryKeyColumns = await getPrimaryKeyColumns(db, table, schema, credentials);
        const previewLimit = CONFIG.app.previewRows || 5;
        const columnsPreview = columns.slice(0, previewLimit).map((column) => ({
          name: column.name,
          type: column.type,
          nullable: column.nullable,
          ordinal_position: column.ordinal_position,
          column_key: column.column_key
        }));

        return {
          table,
          schema: resolvedSchema,
          column_count: columns.length,
          columns_preview: columnsPreview,
          has_more_columns: columns.length > columnsPreview.length,
          primary_key_columns: primaryKeyColumns
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
      error: error instanceof Error ? error.message : 'Failed to summarize table.'
    };
  }
}