import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import { getTableSchema } from '@/lib/tools/getSchema';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter, quoteIdentifier } from '@/lib/tools/toolUtils';

function clampRowLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit ?? NaN) ? Number(limit) : 5;
  return Math.max(1, Math.min(5, requested));
}

function normalizeRequestedColumns(columns: string[] | undefined, availableColumns: string[]): string[] {
  const selected = Array.isArray(columns) ? columns.map((column) => column.trim()).filter(Boolean) : [];
  const filtered = selected.length > 0 ? selected.filter((column) => availableColumns.includes(column)) : availableColumns.slice(0, 5);
  return filtered.slice(0, 5);
}

async function getAvailableColumns(db: DBType, table: string, schema?: string, credentials?: DatabaseCredentials): Promise<string[]> {
  const result = await getTableSchema(db, table, schema, credentials);
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to read table schema.');
  }

  return (result.data.columns as Array<Record<string, unknown>>)
    .map((column) => String(column.name ?? column.column_name ?? ''))
    .filter(Boolean);
}

export async function getTableSampleByColumns(
  db: DBType,
  table: string,
  schema?: string,
  columns?: string[],
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ table: string; schema: string; columns: string[]; row_limit: number; rows: Array<Record<string, unknown>>; truncated: boolean }>> {
  try {
    const rowLimit = clampRowLimit(limit);
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const availableColumns = await getAvailableColumns(db, table, schema, credentials);
    const selectedColumns = normalizeRequestedColumns(columns, availableColumns);

    if (selectedColumns.length === 0) {
      throw new Error('No matching columns were found for sampling.');
    }

    const selectList = selectedColumns.map((column) => quoteIdentifier(db, column)).join(', ');

    if (db === 'postgres') {
      const result = await queryPostgres<Record<string, unknown>>(
        `SELECT ${selectList}
         FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}
         LIMIT $1`,
        [rowLimit],
        credentials?.postgres
      );

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          columns: selectedColumns,
          row_limit: rowLimit,
          rows: result.rows,
          truncated: availableColumns.length > selectedColumns.length
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SELECT TOP (@rowLimit) ${selectList}
         FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
        { rowLimit },
        credentials?.mssql
      );

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          columns: selectedColumns,
          row_limit: rowLimit,
          rows: result.rows as Array<Record<string, unknown>>,
          truncated: availableColumns.length > selectedColumns.length
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `SELECT ${selectList}
         FROM ${quoteIdentifier(db, table)}
         LIMIT ?`,
        credentials,
        [rowLimit]
      )) as Array<Record<string, unknown>>;

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          columns: selectedColumns,
          row_limit: rowLimit,
          rows,
          truncated: availableColumns.length > selectedColumns.length
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const rows = (await querySQLite(
        `SELECT ${selectList}
         FROM ${quoteIdentifier(db, table)}
         LIMIT ?`,
        credentials,
        [rowLimit]
      )) as Array<Record<string, unknown>>;

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          columns: selectedColumns,
          row_limit: rowLimit,
          rows,
          truncated: availableColumns.length > selectedColumns.length
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
      error: error instanceof Error ? error.message : 'Failed to sample columns.'
    };
  }
}