import { getRelationships } from '@/lib/tools/getRelationships';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

type RelationEdge = {
  from: string;
  to: string;
  column?: string;
  referenced_column?: string;
  direction: 'forward' | 'reverse';
};

function resolveSchema(db: DBType, schema?: string): string {
  return (schema || (db === 'postgres' ? 'public' : 'dbo')).trim();
}

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

export async function getRelationPath(
  db: DBType,
  sourceTable: string,
  targetTable: string,
  schema?: string,
  limit?: number,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ source: string; target: string; found: boolean; path: string[]; edges: RelationEdge[]; truncated: boolean }>> {
  try {
    const resolvedSchema = resolveSchema(db, schema);
    const result = await getRelationships(db, undefined, schema, credentials);

    if (!result.success || !result.data) {
      return {
        success: false,
        data: null,
        error: result.error
      };
    }

    const allRelationships = result.data.relationships as Array<Record<string, unknown>>;
    const maxDepth = Math.max(1, Math.min(20, Number.isFinite(limit ?? NaN) ? Number(limit) : 10));
    const sourceId = nodeId(resolvedSchema, sourceTable);
    const targetId = nodeId(resolvedSchema, targetTable);

    const adjacency = new Map<string, Array<{ next: string; edge: RelationEdge }>>();

    for (const row of allRelationships) {
      const localSchema = extractValue(row, ['table_schema', 'schema_name', 'schema']);
      const localTable = extractValue(row, ['table_name', 'table', 'parent_table']);
      const localColumn = extractValue(row, ['column_name', 'column', 'parent_column']);
      const referencedSchema = extractValue(row, ['foreign_table_schema', 'referenced_schema_name', 'referenced_schema']);
      const referencedTable = extractValue(row, ['foreign_table_name', 'referenced_table', 'foreign_table']);
      const referencedColumn = extractValue(row, ['foreign_column_name', 'referenced_column', 'foreign_column']);

      if (!localTable || !referencedTable) {
        continue;
      }

      const from = nodeId(localSchema || resolvedSchema, localTable);
      const to = nodeId(referencedSchema || resolvedSchema, referencedTable);

      const forwardEdge: RelationEdge = {
        from,
        to,
        column: localColumn || undefined,
        referenced_column: referencedColumn || undefined,
        direction: 'forward'
      };

      const reverseEdge: RelationEdge = {
        from: to,
        to: from,
        column: referencedColumn || undefined,
        referenced_column: localColumn || undefined,
        direction: 'reverse'
      };

      const fromNeighbors = adjacency.get(from) || [];
      fromNeighbors.push({ next: to, edge: forwardEdge });
      adjacency.set(from, fromNeighbors);

      const toNeighbors = adjacency.get(to) || [];
      toNeighbors.push({ next: from, edge: reverseEdge });
      adjacency.set(to, toNeighbors);
    }

    const queue: Array<{ node: string; path: string[]; edges: RelationEdge[] }> = [{ node: sourceId, path: [sourceId], edges: [] }];
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.node === targetId) {
        return {
          success: true,
          data: {
            source: sourceId,
            target: targetId,
            found: true,
            path: current.path,
            edges: current.edges,
            truncated: current.edges.length >= maxDepth
          },
          error: null
        };
      }

      if (current.edges.length >= maxDepth) {
        continue;
      }

      const neighbors = adjacency.get(current.node) || [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor.next)) {
          continue;
        }

        visited.add(neighbor.next);
        queue.push({
          node: neighbor.next,
          path: [...current.path, neighbor.next],
          edges: [...current.edges, neighbor.edge]
        });
      }
    }

    return {
      success: true,
      data: {
        source: sourceId,
        target: targetId,
        found: false,
        path: [],
        edges: [],
        truncated: allRelationships.length > 0
      },
      error: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to find relation path.'
    };
  }
}