import { CONFIG } from '@/lib/config';
import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { getTablesSQLite, querySQLite } from '@/lib/db/sqlite';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

function resolveSchema(db: DBType, schema?: string): string {
  const fallback = db === 'postgres' ? 'public' : 'dbo';
  const resolved = (schema || fallback).trim();

  if (!CONFIG.app.allowedSchemas.includes(resolved)) {
    throw new Error(`Schema ${resolved} is not allowed. Allowed schemas: ${CONFIG.app.allowedSchemas.join(', ')}.`);
  }

  return resolved;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function getIndexes(
  db: DBType,
  table?: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ indexes: Array<Record<string, unknown>> }>> {
  try {
    const resolvedSchema = resolveSchema(db, schema);

    const data = await readThroughMetadataCache({
      db,
      tool: 'getIndexes',
      schema: resolvedSchema,
      params: { table: table ?? 'all' },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.indexes,
      fetcher: async () => {
        if (db === 'postgres') {
          const result = await queryPostgres(
            `SELECT schemaname AS schema_name,
                    tablename AS table_name,
                    indexname AS index_name,
                    indexdef AS definition
             FROM pg_indexes
             WHERE schemaname = $1
               AND ($2::text IS NULL OR tablename = $2)
             ORDER BY tablename, indexname`,
            [resolvedSchema, table ?? null],
            credentials?.postgres
          );

          return { indexes: result.rows };
        }

        if (db === 'mssql') {
          const result = await queryMSSQL(
            `SELECT sch.name AS schema_name,
                    tbl.name AS table_name,
                    idx.name AS index_name,
                    idx.is_unique,
                    idx.is_primary_key,
                    idx.type_desc AS index_type,
                    col.name AS column_name,
                    ic.key_ordinal
             FROM sys.indexes idx
             INNER JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
             INNER JOIN sys.tables tbl ON idx.object_id = tbl.object_id
             INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
             INNER JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
             WHERE sch.name = @schemaName
               AND (@tableName IS NULL OR tbl.name = @tableName)
               AND idx.is_hypothetical = 0
               AND idx.name IS NOT NULL
             ORDER BY tbl.name, idx.name, ic.key_ordinal`,
            {
              schemaName: resolvedSchema,
              tableName: table ?? null
            },
            credentials?.mssql
          );

          return { indexes: result.rows as Array<Record<string, unknown>> };
        }

        if (db === 'mysql') {
          const rows = (await queryMySQL(
            `SELECT TABLE_SCHEMA AS schema_name,
                    TABLE_NAME AS table_name,
                    INDEX_NAME AS index_name,
                    NON_UNIQUE AS is_non_unique,
                    SEQ_IN_INDEX AS key_ordinal,
                    COLUMN_NAME AS column_name,
                    INDEX_TYPE AS index_type,
                    COLLATION AS collation_order,
                    CARDINALITY AS cardinality
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND (? IS NULL OR TABLE_NAME = ?)
             ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
            credentials,
            [table ?? null, table ?? null]
          )) as Array<Record<string, unknown>>;

          return { indexes: rows };
        }

        if (db === 'sqlite') {
          const tables = table ? [table] : await getTablesSQLite(credentials);
          const indexes: Array<Record<string, unknown>> = [];

          for (const currentTable of tables) {
            const tableIndexes = (await querySQLite(
              `PRAGMA index_list(${quoteSqliteIdentifier(currentTable)})`,
              credentials
            )) as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;

            for (const indexRow of tableIndexes || []) {
              const indexColumns = (await querySQLite(
                `PRAGMA index_info(${quoteSqliteIdentifier(indexRow.name)})`,
                credentials
              )) as Array<{ seqno: number; cid: number; name: string | null }>;

              indexes.push({
                table_name: currentTable,
                index_name: indexRow.name,
                unique: indexRow.unique === 1,
                origin: indexRow.origin,
                partial: indexRow.partial === 1,
                columns: indexColumns.map((column) => column.name)
              });
            }
          }

          return { indexes };
        }

        throw new Error('Unsupported database type');
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
      error: error instanceof Error ? error.message : 'Failed to get indexes.'
    };
  }
}