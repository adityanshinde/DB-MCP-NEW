import { getFunctionSummary } from '@/lib/tools/getFunctionSummary';
import { getProcedureSummary } from '@/lib/tools/getProcedureSummary';
import { getTableSummary } from '@/lib/tools/getTableSummary';
import { getViewSummary } from '@/lib/tools/getViewSummary';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

type ObjectType = 'table' | 'view' | 'procedure' | 'function';

type Difference = {
  field: string;
  left: string;
  right: string;
};

function safeStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectDifferences(leftSnapshot: Record<string, unknown>, rightSnapshot: Record<string, unknown>): Difference[] {
  const fields = new Set([...Object.keys(leftSnapshot), ...Object.keys(rightSnapshot)]);
  const differences: Difference[] = [];

  for (const field of fields) {
    const left = safeStringify(leftSnapshot[field]);
    const right = safeStringify(rightSnapshot[field]);

    if (left !== right) {
      differences.push({ field, left, right });
    }
  }

  return differences;
}

async function getSnapshot(
  db: DBType,
  objectType: ObjectType,
  name: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<Record<string, unknown> | null> {
  if (objectType === 'table') {
    const result = await getTableSummary(db, name, schema, credentials);
    return result.success && result.data ? result.data : null;
  }

  if (objectType === 'view') {
    const result = await getViewSummary(db, name, schema, credentials);
    return result.success && result.data ? result.data : null;
  }

  if (objectType === 'procedure') {
    const result = await getProcedureSummary(db, name, schema, credentials);
    return result.success && result.data ? {
      supported: result.data.supported,
      routine: result.data.routine,
      parameter_count: result.data.parameters.length,
      parameters_preview: result.data.parameters.slice(0, 5)
    } : null;
  }

  if (objectType === 'function') {
    const result = await getFunctionSummary(db, name, schema, credentials);
    return result.success && result.data ? {
      supported: result.data.supported,
      routine: result.data.routine,
      parameter_count: result.data.parameters.length,
      parameters_preview: result.data.parameters.slice(0, 5)
    } : null;
  }

  return null;
}

export async function compareObjectVersions(
  db: DBType,
  objectType: ObjectType,
  leftName: string,
  rightName: string,
  schema?: string,
  leftSchema?: string,
  rightSchema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ object_type: ObjectType; left: { name: string; schema?: string }; right: { name: string; schema?: string }; left_snapshot: Record<string, unknown> | null; right_snapshot: Record<string, unknown> | null; differences: Difference[] }>> {
  try {
    const leftSnapshot = await getSnapshot(db, objectType, leftName, leftSchema || schema, credentials);
    const rightSnapshot = await getSnapshot(db, objectType, rightName, rightSchema || schema, credentials);

    const differences = leftSnapshot && rightSnapshot ? collectDifferences(leftSnapshot, rightSnapshot) : [];

    return {
      success: true,
      data: {
        object_type: objectType,
        left: { name: leftName, schema: leftSchema || schema },
        right: { name: rightName, schema: rightSchema || schema },
        left_snapshot: leftSnapshot,
        right_snapshot: rightSnapshot,
        differences
      },
      error: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to compare object versions.'
    };
  }
}