import { CONFIG } from '@/lib/config';
import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryPostgres } from '@/lib/db/postgres';
import { getRelationshipsMySQL } from '@/lib/db/mysql';
import { getRelationshipsSQLite } from '@/lib/db/sqlite';
import type { DBType, ToolResponse, DatabaseCredentials } from '@/lib/types';

function resolveSchema(db: DBType, schema?: string): string {
  const fallback = db === 'postgres' ? 'public' : 'dbo';
  const resolved = (schema || fallback).trim();

  if (!CONFIG.app.allowedSchemas.includes(resolved)) {
    throw new Error(`Schema ${resolved} is not allowed. Allowed schemas: ${CONFIG.app.allowedSchemas.join(', ')}.`);
  }

  return resolved;
}

export async function getRelationships(
  db: DBType,
  table?: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ relationships: Array<Record<string, unknown>> }>> {
  try {
    const resolvedSchema = resolveSchema(db, schema);
    const data = await readThroughMetadataCache({
      db,
      tool: 'getRelationships',
      schema: resolvedSchema,
      params: { table: table ?? 'all' },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.relationships,
      fetcher: async () => {
        if (db === 'postgres') {
          const result = await queryPostgres(
            `SELECT
               tc.constraint_name,
               tc.table_schema,
               tc.table_name,
               kcu.column_name,
               ccu.table_schema AS foreign_table_schema,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema = $1
               AND ($2::text IS NULL OR tc.table_name = $2)
             ORDER BY tc.table_name, tc.constraint_name`,
            [resolvedSchema, table ?? null],
            credentials?.postgres
          );

          return { relationships: result.rows };
        }

        if (db === 'mssql') {
          const result = await queryMSSQL(
            `SELECT
               fk.name AS constraint_name,
               sch_parent.name AS table_schema,
               parent_tbl.name AS table_name,
               parent_col.name AS column_name,
               sch_ref.name AS foreign_table_schema,
               ref_tbl.name AS foreign_table_name,
               ref_col.name AS foreign_column_name
             FROM sys.foreign_keys fk
             INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
             INNER JOIN sys.tables parent_tbl ON fkc.parent_object_id = parent_tbl.object_id
             INNER JOIN sys.schemas sch_parent ON parent_tbl.schema_id = sch_parent.schema_id
             INNER JOIN sys.columns parent_col ON fkc.parent_object_id = parent_col.object_id AND fkc.parent_column_id = parent_col.column_id
             INNER JOIN sys.tables ref_tbl ON fkc.referenced_object_id = ref_tbl.object_id
             INNER JOIN sys.schemas sch_ref ON ref_tbl.schema_id = sch_ref.schema_id
             INNER JOIN sys.columns ref_col ON fkc.referenced_object_id = ref_col.object_id AND fkc.referenced_column_id = ref_col.column_id
             WHERE sch_parent.name = @schemaName
               AND (@tableName IS NULL OR parent_tbl.name = @tableName)
             ORDER BY parent_tbl.name, fk.name`,
            {
              schemaName: resolvedSchema,
              tableName: table ?? null
            },
            credentials?.mssql
          );

          return { relationships: result.rows };
        }

        if (db === 'mysql') {
          const relationships = await getRelationshipsMySQL(table, credentials);
          return { relationships: relationships as Array<Record<string, unknown>> };
        }

        if (db === 'sqlite') {
          const relationships = await getRelationshipsSQLite(table, credentials);
          return { relationships: relationships as Array<Record<string, unknown>> };
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
      error: error instanceof Error ? error.message : 'Failed to read relationships.'
    };
  }
}
