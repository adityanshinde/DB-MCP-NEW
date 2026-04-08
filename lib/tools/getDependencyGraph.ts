import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { getRelationships } from '@/lib/tools/getRelationships';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

type GraphNode = {
  id: string;
  type: 'table' | 'view';
};

type GraphEdge = {
  from: string;
  to: string;
  kind: 'foreign_key';
  column?: string;
  referenced_column?: string;
};

function extractValue(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }

  return '';
}

function nodeId(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export async function getDependencyGraph(
  db: DBType,
  table?: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ root?: string; node_count: number; edge_count: number; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>> {
  try {
    const rowLimit = Math.max(1, Math.min(20, Number.isFinite(limit ?? NaN) ? Number(limit) : 10));
    const data = await readThroughMetadataCache({
      db,
      tool: 'getDependencyGraph',
      schema,
      params: { table: table ?? 'all', limit: rowLimit },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.analytics,
      fetcher: async () => {
        const result = await getRelationships(db, table, schema, credentials);
        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to build dependency graph.');
        }

        const relationships = result.data.relationships as Array<Record<string, unknown>>;
        const nodes = new Map<string, GraphNode>();
        const edges: GraphEdge[] = [];

        for (const row of relationships) {
          if (edges.length >= rowLimit) {
            break;
          }

          const localSchema = extractValue(row, ['table_schema', 'schema_name', 'schema', 'table_schema_name']);
          const localTable = extractValue(row, ['table_name', 'table', 'parent_table']);
          const localColumn = extractValue(row, ['column_name', 'column', 'parent_column']);
          const referencedSchema = extractValue(row, ['foreign_table_schema', 'referenced_schema_name', 'referenced_schema']);
          const referencedTable = extractValue(row, ['foreign_table_name', 'referenced_table', 'foreign_table']);
          const referencedColumn = extractValue(row, ['foreign_column_name', 'referenced_column', 'foreign_column']);

          if (!localTable || !referencedTable) {
            continue;
          }

          const fromId = nodeId(localSchema || schema || 'dbo', localTable);
          const toId = nodeId(referencedSchema || schema || 'dbo', referencedTable);

          nodes.set(fromId, { id: fromId, type: 'table' });
          nodes.set(toId, { id: toId, type: 'table' });

          edges.push({
            from: fromId,
            to: toId,
            kind: 'foreign_key',
            column: localColumn || undefined,
            referenced_column: referencedColumn || undefined
          });
        }

        return {
          root: table ? nodeId(schema || 'dbo', table) : undefined,
          node_count: nodes.size,
          edge_count: edges.length,
          nodes: Array.from(nodes.values()),
          edges,
          truncated: relationships.length > edges.length
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
      error: error instanceof Error ? error.message : 'Failed to build dependency graph.'
    };
  }
}