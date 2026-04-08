import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter, quoteIdentifier } from '@/lib/tools/toolUtils';

export async function getRowCount(
  db: DBType,
  table: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ table: string; schema: string; row_count: number }>> {
  try {
    const resolvedSchema = normalizeSchemaFilter(db, schema);

    if (db === 'postgres') {
      const result = await queryPostgres<{ row_count: string }>(
        `SELECT COUNT(*)::bigint AS row_count
         FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
        [],
        credentials?.postgres
      );

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          row_count: Number(result.rows[0]?.row_count ?? 0)
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SELECT COUNT_BIG(*) AS row_count
         FROM ${quoteIdentifier(db, resolvedSchema)}.${quoteIdentifier(db, table)}`,
        {},
        credentials?.mssql
      );

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          row_count: Number((result.rows[0] as { row_count?: number | string } | undefined)?.row_count ?? 0)
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `SELECT COUNT(*) AS row_count
         FROM ${quoteIdentifier(db, table)}`,
        credentials
      )) as Array<{ row_count: number | string }>;

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          row_count: Number(rows[0]?.row_count ?? 0)
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const rows = (await querySQLite(
        `SELECT COUNT(*) AS row_count
         FROM ${quoteIdentifier(db, table)}`,
        credentials
      )) as Array<{ row_count: number | string }>;

      return {
        success: true,
        data: {
          table,
          schema: resolvedSchema,
          row_count: Number(rows[0]?.row_count ?? 0)
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
      error: error instanceof Error ? error.message : 'Failed to count rows.'
    };
  }
}