import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter, quoteIdentifier } from '@/lib/tools/toolUtils';

function clampLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit ?? NaN) ? Number(limit) : 5;
  return Math.max(1, Math.min(5, requested));
}

export async function getSampleRows(
  db: DBType,
  table: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ table: string; schema: string; limit: number; rows: unknown[] }>> {
  try {
    const rowLimit = clampLimit(limit);
    const resolvedSchema = normalizeSchemaFilter(db, schema);

    if (db === 'postgres') {
      const result = await queryPostgres(
        `SELECT *
         FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}
         LIMIT $1`,
        [rowLimit],
        credentials?.postgres
      );

      return {
        success: true,
        data: { table, schema: resolvedSchema, limit: rowLimit, rows: result.rows },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SELECT TOP (@rowLimit) *
         FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
        { rowLimit },
        credentials?.mssql
      );

      return {
        success: true,
        data: { table, schema: resolvedSchema, limit: rowLimit, rows: result.rows },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `SELECT *
         FROM ${quoteIdentifier(db, table)}
         LIMIT ?`,
        credentials,
        [rowLimit]
      )) as unknown[];

      return {
        success: true,
        data: { table, schema: resolvedSchema, limit: rowLimit, rows },
        error: null
      };
    }

    if (db === 'sqlite') {
      const rows = (await querySQLite(
        `SELECT *
         FROM ${quoteIdentifier(db, table)}
         LIMIT ?`,
        credentials,
        [rowLimit]
      )) as unknown[];

      return {
        success: true,
        data: { table, schema: resolvedSchema, limit: rowLimit, rows },
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
      error: error instanceof Error ? error.message : 'Failed to sample rows.'
    };
  }
}