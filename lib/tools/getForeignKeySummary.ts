import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { getRelationships } from '@/lib/tools/getRelationships';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

type RelationshipRow = Record<string, unknown>;

function extractValue(row: RelationshipRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }

  return '';
}

export async function getForeignKeySummary(
  db: DBType,
  table?: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ total_relationships: number; local_tables: number; referenced_tables: number; preview: Array<Record<string, unknown>>; truncated: boolean }>> {
  try {
    const rowLimit = Math.max(1, Math.min(5, Number.isFinite(limit ?? NaN) ? Number(limit) : 5));
    const data = await readThroughMetadataCache({
      db,
      tool: 'getForeignKeySummary',
      schema,
      params: { table: table ?? 'all', limit: rowLimit },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.analytics,
      fetcher: async () => {
        const result = await getRelationships(db, table, schema, credentials);

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to summarize foreign keys.');
        }

        const relationships = result.data.relationships as RelationshipRow[];
        const localTables = new Set<string>();
        const referencedTables = new Set<string>();

        const preview = relationships.slice(0, rowLimit).map((row) => {
          const localTable = extractValue(row, ['table_name', 'table', 'parent_table']);
          const localSchema = extractValue(row, ['table_schema', 'schema_name', 'schema']);
          const localColumn = extractValue(row, ['column_name', 'column', 'parent_column']);
          const referencedTable = extractValue(row, ['foreign_table_name', 'referenced_table', 'foreign_table']);
          const referencedSchema = extractValue(row, ['foreign_table_schema', 'referenced_schema_name', 'referenced_schema']);
          const referencedColumn = extractValue(row, ['foreign_column_name', 'referenced_column', 'foreign_column']);

          if (localTable) {
            localTables.add(`${localSchema}.${localTable}`);
          }

          if (referencedTable) {
            referencedTables.add(`${referencedSchema}.${referencedTable}`);
          }

          return {
            local_schema: localSchema || undefined,
            local_table: localTable,
            local_column: localColumn,
            referenced_schema: referencedSchema || undefined,
            referenced_table: referencedTable,
            referenced_column: referencedColumn
          };
        });

        for (const row of relationships) {
          const localTable = extractValue(row, ['table_name', 'table', 'parent_table']);
          const localSchema = extractValue(row, ['table_schema', 'schema_name', 'schema']);
          const referencedTable = extractValue(row, ['foreign_table_name', 'referenced_table', 'foreign_table']);
          const referencedSchema = extractValue(row, ['foreign_table_schema', 'referenced_schema_name', 'referenced_schema']);

          if (localTable) {
            localTables.add(`${localSchema}.${localTable}`);
          }
          if (referencedTable) {
            referencedTables.add(`${referencedSchema}.${referencedTable}`);
          }
        }

        return {
          total_relationships: relationships.length,
          local_tables: localTables.size,
          referenced_tables: referencedTables.size,
          preview,
          truncated: relationships.length > preview.length
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
      error: error instanceof Error ? error.message : 'Failed to summarize foreign keys.'
    };
  }
}