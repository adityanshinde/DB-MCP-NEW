import { CONFIG } from '@/lib/config';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { getTablesSQLite, querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter } from '@/lib/tools/toolUtils';

type ColumnMatch = {
  schema?: string;
  table: string;
  column: string;
  data_type: string;
  nullable: boolean;
};

function quoteSqlite(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function clampLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit ?? NaN) ? Number(limit) : 10;
  return Math.max(1, Math.min(20, requested));
}

export async function searchColumns(
  db: DBType,
  query: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ query: string; matches: ColumnMatch[] }>> {
  try {
    const search = query.trim();
    if (!search) {
      throw new Error('Search query is required.');
    }

    const rowLimit = clampLimit(limit);
    const schemaFilter = normalizeSchemaFilter(db, schema);

    if (db === 'postgres') {
      const result = await queryPostgres<{ schema_name: string; table_name: string; column_name: string; data_type: string; is_nullable: string }>(
        `SELECT table_schema AS schema_name,
                table_name,
                column_name,
                data_type,
                is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1
           AND column_name ILIKE $2
         ORDER BY table_name, ordinal_position
         LIMIT $3`,
        [schemaFilter, `%${search}%`, rowLimit],
        credentials?.postgres
      );

      return {
        success: true,
        data: {
          query: search,
          matches: result.rows.map((row) => ({
            schema: row.schema_name,
            table: row.table_name,
            column: row.column_name,
            data_type: row.data_type,
            nullable: row.is_nullable === 'YES'
          }))
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SELECT table_schema AS schema_name,
                table_name,
                column_name,
                data_type,
                is_nullable
         FROM information_schema.columns
         WHERE table_schema = @schemaName
           AND column_name LIKE @pattern
         ORDER BY table_name, ordinal_position`,
        { schemaName: schemaFilter, pattern: `%${search}%` },
        credentials?.mssql
      );

      return {
        success: true,
        data: {
          query: search,
          matches: (result.rows as Array<{ schema_name: string; table_name: string; column_name: string; data_type: string; is_nullable: string }>).slice(0, rowLimit).map((row) => ({
            schema: row.schema_name,
            table: row.table_name,
            column: row.column_name,
            data_type: row.data_type,
            nullable: row.is_nullable === 'YES'
          }))
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `SELECT TABLE_SCHEMA AS schema_name,
                TABLE_NAME AS table_name,
                COLUMN_NAME AS column_name,
                DATA_TYPE AS data_type,
                IS_NULLABLE AS is_nullable
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND COLUMN_NAME LIKE ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        credentials,
        [`%${search}%`]
      )) as Array<{ schema_name: string; table_name: string; column_name: string; data_type: string; is_nullable: string }>;

      return {
        success: true,
        data: {
          query: search,
          matches: rows.slice(0, rowLimit).map((row) => ({
            schema: row.schema_name,
            table: row.table_name,
            column: row.column_name,
            data_type: row.data_type,
            nullable: row.is_nullable === 'YES'
          }))
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const tables = await getTablesSQLite(credentials);
      const matches: ColumnMatch[] = [];

      for (const table of tables) {
        if (matches.length >= rowLimit) {
          break;
        }

        const columns = (await querySQLite(`PRAGMA table_info(${quoteSqlite(table)})`, credentials)) as Array<{ name: string; type: string; notnull: number }>;
        for (const column of columns) {
          if (column.name.toLowerCase().includes(search.toLowerCase())) {
            matches.push({
              schema: schemaFilter,
              table,
              column: column.name,
              data_type: column.type,
              nullable: column.notnull === 0
            });

            if (matches.length >= rowLimit) {
              break;
            }
          }
        }
      }

      return {
        success: true,
        data: { query: search, matches },
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
      error: error instanceof Error ? error.message : 'Failed to search columns.'
    };
  }
}