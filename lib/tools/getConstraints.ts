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

export async function getConstraints(
  db: DBType,
  table?: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ constraints: Array<Record<string, unknown>> }>> {
  try {
    const resolvedSchema = resolveSchema(db, schema);

    const data = await readThroughMetadataCache({
      db,
      tool: 'getConstraints',
      schema: resolvedSchema,
      params: { table: table ?? 'all' },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.constraints,
      fetcher: async () => {
        if (db === 'postgres') {
          const result = await queryPostgres(
            `SELECT tc.table_schema AS schema_name,
                    tc.table_name,
                    tc.constraint_name,
                    tc.constraint_type,
                    kcu.column_name,
                    ccu.table_schema AS referenced_schema_name,
                    ccu.table_name AS referenced_table_name,
                    ccu.column_name AS referenced_column_name,
                    cc.check_clause
             FROM information_schema.table_constraints tc
             LEFT JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
             LEFT JOIN information_schema.constraint_column_usage ccu
               ON tc.constraint_name = ccu.constraint_name
              AND tc.table_schema = ccu.table_schema
             LEFT JOIN information_schema.check_constraints cc
               ON tc.constraint_name = cc.constraint_name
             WHERE tc.table_schema = $1
               AND ($2::text IS NULL OR tc.table_name = $2)
             ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
            [resolvedSchema, table ?? null],
            credentials?.postgres
          );

          return { constraints: result.rows };
        }

        if (db === 'mssql') {
          const result = await queryMSSQL(
            `WITH key_constraints AS (
               SELECT sch.name AS schema_name,
                      tbl.name AS table_name,
                      kc.name AS constraint_name,
                      kc.type_desc AS constraint_type,
                      col.name AS column_name,
                      CAST(NULL AS sysname) AS referenced_schema_name,
                      CAST(NULL AS sysname) AS referenced_table_name,
                      CAST(NULL AS sysname) AS referenced_column_name,
                      CAST(NULL AS nvarchar(max)) AS check_clause
               FROM sys.key_constraints kc
               INNER JOIN sys.tables tbl ON kc.parent_object_id = tbl.object_id
               INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
               INNER JOIN sys.index_columns ic ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
               INNER JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
               WHERE sch.name = @schemaName
                 AND (@tableName IS NULL OR tbl.name = @tableName)
             ),
             foreign_keys AS (
               SELECT sch.name AS schema_name,
                      parent_tbl.name AS table_name,
                      fk.name AS constraint_name,
                      fk.type_desc AS constraint_type,
                      parent_col.name AS column_name,
                      sch_ref.name AS referenced_schema_name,
                      ref_tbl.name AS referenced_table_name,
                      ref_col.name AS referenced_column_name,
                      CAST(NULL AS nvarchar(max)) AS check_clause
               FROM sys.foreign_keys fk
               INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
               INNER JOIN sys.tables parent_tbl ON fkc.parent_object_id = parent_tbl.object_id
               INNER JOIN sys.schemas sch ON parent_tbl.schema_id = sch.schema_id
               INNER JOIN sys.columns parent_col ON fkc.parent_object_id = parent_col.object_id AND fkc.parent_column_id = parent_col.column_id
               INNER JOIN sys.tables ref_tbl ON fkc.referenced_object_id = ref_tbl.object_id
               INNER JOIN sys.schemas sch_ref ON ref_tbl.schema_id = sch_ref.schema_id
               INNER JOIN sys.columns ref_col ON fkc.referenced_object_id = ref_col.object_id AND fkc.referenced_column_id = ref_col.column_id
               WHERE sch.name = @schemaName
                 AND (@tableName IS NULL OR parent_tbl.name = @tableName)
             ),
             check_constraints AS (
               SELECT sch.name AS schema_name,
                      tbl.name AS table_name,
                      cc.name AS constraint_name,
                      'CHECK_CONSTRAINT' AS constraint_type,
                      CAST(NULL AS sysname) AS column_name,
                      CAST(NULL AS sysname) AS referenced_schema_name,
                      CAST(NULL AS sysname) AS referenced_table_name,
                      CAST(NULL AS sysname) AS referenced_column_name,
                      cc.definition AS check_clause
               FROM sys.check_constraints cc
               INNER JOIN sys.tables tbl ON cc.parent_object_id = tbl.object_id
               INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
               WHERE sch.name = @schemaName
                 AND (@tableName IS NULL OR tbl.name = @tableName)
             )
             SELECT * FROM key_constraints
             UNION ALL
             SELECT * FROM foreign_keys
             UNION ALL
             SELECT * FROM check_constraints
             ORDER BY table_name, constraint_name, column_name`,
            {
              schemaName: resolvedSchema,
              tableName: table ?? null
            },
            credentials?.mssql
          );

          return { constraints: result.rows as Array<Record<string, unknown>> };
        }

        if (db === 'mysql') {
          const rows = (await queryMySQL(
            `SELECT tc.TABLE_SCHEMA AS schema_name,
                    tc.TABLE_NAME AS table_name,
                    tc.CONSTRAINT_NAME AS constraint_name,
                    tc.CONSTRAINT_TYPE AS constraint_type,
                    kcu.COLUMN_NAME AS column_name,
                    kcu.REFERENCED_TABLE_SCHEMA AS referenced_schema_name,
                    kcu.REFERENCED_TABLE_NAME AS referenced_table_name,
                    kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
                    cc.CHECK_CLAUSE AS check_clause
             FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
             LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
               ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
              AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
              AND tc.TABLE_NAME = kcu.TABLE_NAME
             LEFT JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
               ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
              AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
             WHERE tc.TABLE_SCHEMA = DATABASE()
               AND (? IS NULL OR tc.TABLE_NAME = ?)
             ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
            credentials,
            [table ?? null, table ?? null]
          )) as Array<Record<string, unknown>>;

          return { constraints: rows };
        }

        if (db === 'sqlite') {
          const tables = table ? [table] : await getTablesSQLite(credentials);
          const constraints: Array<Record<string, unknown>> = [];

          for (const currentTable of tables) {
            const columns = (await querySQLite(
              `PRAGMA table_info(${quoteSqliteIdentifier(currentTable)})`,
              credentials
            )) as Array<{ name: string; pk: number }>;

            const primaryKeyColumns = columns
              .filter((column) => column.pk > 0)
              .sort((left, right) => left.pk - right.pk)
              .map((column) => column.name);

            if (primaryKeyColumns.length > 0) {
              constraints.push({
                schema_name: 'main',
                table_name: currentTable,
                constraint_name: `pk_${currentTable}`,
                constraint_type: 'PRIMARY_KEY',
                column_name: primaryKeyColumns.join(', ')
              });
            }

            const foreignKeys = (await querySQLite(
              `PRAGMA foreign_key_list(${quoteSqliteIdentifier(currentTable)})`,
              credentials
            )) as Array<{ id: number; seq: number; table: string; from: string; to: string }>;

            for (const foreignKey of foreignKeys) {
              constraints.push({
                schema_name: 'main',
                table_name: currentTable,
                constraint_name: `fk_${currentTable}_${foreignKey.id}`,
                constraint_type: 'FOREIGN_KEY',
                column_name: foreignKey.from,
                referenced_table_name: foreignKey.table,
                referenced_column_name: foreignKey.to
              });
            }

            const indexes = (await querySQLite(
              `PRAGMA index_list(${quoteSqliteIdentifier(currentTable)})`,
              credentials
            )) as Array<{ seq: number; name: string; unique: number; origin: string; partial: number }>;

            for (const indexRow of indexes || []) {
              if (indexRow.unique !== 1 || indexRow.origin === 'pk') {
                continue;
              }

              const indexColumns = (await querySQLite(
                `PRAGMA index_info(${quoteSqliteIdentifier(indexRow.name)})`,
                credentials
              )) as Array<{ seqno: number; cid: number; name: string | null }>;

              constraints.push({
                schema_name: 'main',
                table_name: currentTable,
                constraint_name: indexRow.name,
                constraint_type: 'UNIQUE',
                column_name: indexColumns.map((column) => column.name).filter(Boolean).join(', ')
              });
            }
          }

          return { constraints };
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
      error: error instanceof Error ? error.message : 'Failed to get constraints.'
    };
  }
}