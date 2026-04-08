import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import { getTableSchema } from '@/lib/tools/getSchema';
import { normalizeSchemaFilter, quoteIdentifier } from '@/lib/tools/toolUtils';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

type ColumnStat = {
  column: string;
  data_type: string;
  nullable: boolean;
  total_rows: number;
  non_null_rows: number;
  null_rows: number;
  distinct_rows: number;
};

function clampLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit ?? NaN) ? Number(limit) : 5;
  return Math.max(1, Math.min(5, requested));
}

async function getColumns(db: DBType, table: string, schema?: string, credentials?: DatabaseCredentials): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
  const result = await getTableSchema(db, table, schema, credentials);
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to read table schema.');
  }

  return (result.data.columns as Array<Record<string, unknown>>).map((column) => ({
    name: String(column.name ?? column.column_name ?? ''),
    type: String(column.type ?? column.data_type ?? ''),
    nullable: Boolean(column.nullable ?? (String(column.is_nullable ?? '').toUpperCase() === 'YES'))
  }));
}

async function getTotalRows(db: DBType, table: string, schema?: string, credentials?: DatabaseCredentials): Promise<number> {
  const resolvedSchema = normalizeSchemaFilter(db, schema);

  if (db === 'postgres') {
    const result = await queryPostgres<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
      [],
      credentials?.postgres
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  if (db === 'mssql') {
    const result = await queryMSSQL(
      `SELECT COUNT(*) AS count
       FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
      {},
      credentials?.mssql
    );
    return Number((result.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT COUNT(*) AS count
       FROM ${quoteIdentifier(db, table)}`,
      credentials
    )) as Array<{ count: number | string }>;
    return Number(rows[0]?.count ?? 0);
  }

  if (db === 'sqlite') {
    const rows = (await querySQLite(
      `SELECT COUNT(*) AS count
       FROM ${quoteIdentifier(db, table)}`,
      credentials
    )) as Array<{ count: number | string }>;
    return Number(rows[0]?.count ?? 0);
  }

  return 0;
}

async function getColumnStat(db: DBType, table: string, column: string, schema?: string, credentials?: DatabaseCredentials): Promise<ColumnStat> {
  const resolvedSchema = normalizeSchemaFilter(db, schema);
  const totalRows = await getTotalRows(db, table, schema, credentials);

  if (db === 'postgres') {
    const result = await queryPostgres<{ non_null_rows: string; null_rows: string; distinct_rows: string }>(
      `SELECT COUNT(${quoteIdentifier(db, column)}) AS non_null_rows,
              COUNT(*) - COUNT(${quoteIdentifier(db, column)}) AS null_rows,
              COUNT(DISTINCT ${quoteIdentifier(db, column)}) AS distinct_rows
       FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
      [],
      credentials?.postgres
    );
    const row = result.rows[0] ?? { non_null_rows: '0', null_rows: '0', distinct_rows: '0' };
    return {
      column,
      data_type: '',
      nullable: true,
      total_rows: totalRows,
      non_null_rows: Number(row.non_null_rows),
      null_rows: Number(row.null_rows),
      distinct_rows: Number(row.distinct_rows)
    };
  }

  if (db === 'mssql') {
    const result = await queryMSSQL(
      `SELECT COUNT([${column.replace(/]/g, ']]')}]) AS non_null_rows,
              COUNT(*) - COUNT([${column.replace(/]/g, ']]')}]) AS null_rows,
              COUNT(DISTINCT [${column.replace(/]/g, ']]')}]) AS distinct_rows
       FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
      {},
      credentials?.mssql
    );
    const row = result.rows[0] as { non_null_rows?: number | string; null_rows?: number | string; distinct_rows?: number | string } | undefined;
    return {
      column,
      data_type: '',
      nullable: true,
      total_rows: totalRows,
      non_null_rows: Number(row?.non_null_rows ?? 0),
      null_rows: Number(row?.null_rows ?? 0),
      distinct_rows: Number(row?.distinct_rows ?? 0)
    };
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT COUNT(${quoteIdentifier(db, column)}) AS non_null_rows,
              COUNT(*) - COUNT(${quoteIdentifier(db, column)}) AS null_rows,
              COUNT(DISTINCT ${quoteIdentifier(db, column)}) AS distinct_rows
       FROM ${quoteIdentifier(db, table)}`,
      credentials
    )) as Array<{ non_null_rows: number | string; null_rows: number | string; distinct_rows: number | string }>;

    const row = rows[0] ?? { non_null_rows: 0, null_rows: 0, distinct_rows: 0 };
    return {
      column,
      data_type: '',
      nullable: true,
      total_rows: totalRows,
      non_null_rows: Number(row.non_null_rows),
      null_rows: Number(row.null_rows),
      distinct_rows: Number(row.distinct_rows)
    };
  }

  if (db === 'sqlite') {
    const rows = (await querySQLite(
      `SELECT COUNT(${quoteIdentifier(db, column)}) AS non_null_rows,
              COUNT(*) - COUNT(${quoteIdentifier(db, column)}) AS null_rows,
              COUNT(DISTINCT ${quoteIdentifier(db, column)}) AS distinct_rows
       FROM ${quoteIdentifier(db, table)}`,
      credentials
    )) as Array<{ non_null_rows: number | string; null_rows: number | string; distinct_rows: number | string }>;

    const row = rows[0] ?? { non_null_rows: 0, null_rows: 0, distinct_rows: 0 };
    return {
      column,
      data_type: '',
      nullable: true,
      total_rows: totalRows,
      non_null_rows: Number(row.non_null_rows),
      null_rows: Number(row.null_rows),
      distinct_rows: Number(row.distinct_rows)
    };
  }

  return {
    column,
    data_type: '',
    nullable: true,
    total_rows: totalRows,
    non_null_rows: 0,
    null_rows: 0,
    distinct_rows: 0
  };
}

export async function getColumnStats(
  db: DBType,
  table: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ table: string; schema: string; total_rows: number; columns: ColumnStat[]; truncated: boolean }>> {
  try {
    const rowLimit = clampLimit(limit);
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const columns = await getColumns(db, table, schema, credentials);
    const selectedColumns = columns.slice(0, rowLimit);
    const stats: ColumnStat[] = [];

    for (const column of selectedColumns) {
      const stat = await getColumnStat(db, table, column.name, schema, credentials);
      stats.push({
        ...stat,
        data_type: column.type,
        nullable: column.nullable
      });
    }

    const totalRows = stats[0]?.total_rows ?? 0;

    return {
      success: true,
      data: {
        table,
        schema: resolvedSchema,
        total_rows: totalRows,
        columns: stats,
        truncated: columns.length > stats.length
      },
      error: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to compute column stats.'
    };
  }
}