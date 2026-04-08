import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { getRoutineSummary } from '@/lib/tools/getRoutineSummary';

export async function getProcedureSummary(
  db: DBType,
  procedure: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ supported: boolean; routine: Record<string, unknown> | null; parameters: Array<Record<string, unknown>> }>> {
  return getRoutineSummary(db, 'PROCEDURE', procedure, schema, credentials);
}