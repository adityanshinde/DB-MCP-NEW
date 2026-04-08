import { getTableSchema } from '@/lib/tools/getSchema';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';

type ComparedColumn = {
  name: string;
  left_type?: string;
  right_type?: string;
  left_nullable?: boolean;
  right_nullable?: boolean;
};

function normalizeColumns(columns: Array<Record<string, unknown>>): Array<{ name: string; type: string; nullable: boolean }> {
  return columns.map((column) => ({
    name: String(column.name ?? column.column_name ?? ''),
    type: String(column.type ?? column.data_type ?? ''),
    nullable: Boolean(column.nullable ?? (String(column.is_nullable ?? '').toUpperCase() === 'YES'))
  }));
}

export async function compareSchema(
  db: DBType,
  leftTable: string,
  rightTable: string,
  leftSchema?: string,
  rightSchema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ left: { table: string; schema?: string }; right: { table: string; schema?: string }; added_columns: string[]; removed_columns: string[]; changed_columns: ComparedColumn[]; shared_columns: string[] }>> {
  try {
    const left = await getTableSchema(db, leftTable, leftSchema, credentials);
    const right = await getTableSchema(db, rightTable, rightSchema, credentials);

    if (!left.success) {
      return {
        success: false,
        data: null,
        error: left.error
      };
    }

    if (!right.success) {
      return {
        success: false,
        data: null,
        error: right.error
      };
    }

    const leftColumns = normalizeColumns(left.data?.columns ?? []);
    const rightColumns = normalizeColumns(right.data?.columns ?? []);
    const leftMap = new Map(leftColumns.map((column) => [column.name, column]));
    const rightMap = new Map(rightColumns.map((column) => [column.name, column]));
    const sharedColumns: string[] = [];
    const addedColumns: string[] = [];
    const removedColumns: string[] = [];
    const changedColumns: ComparedColumn[] = [];

    for (const [name, leftColumn] of leftMap.entries()) {
      if (!rightMap.has(name)) {
        removedColumns.push(name);
        continue;
      }

      sharedColumns.push(name);
      const rightColumn = rightMap.get(name)!;
      if (leftColumn.type !== rightColumn.type || leftColumn.nullable !== rightColumn.nullable) {
        changedColumns.push({
          name,
          left_type: leftColumn.type,
          right_type: rightColumn.type,
          left_nullable: leftColumn.nullable,
          right_nullable: rightColumn.nullable
        });
      }
    }

    for (const [name] of rightMap.entries()) {
      if (!leftMap.has(name)) {
        addedColumns.push(name);
      }
    }

    return {
      success: true,
      data: {
        left: { table: leftTable, schema: left.data?.schema },
        right: { table: rightTable, schema: right.data?.schema },
        added_columns: addedColumns,
        removed_columns: removedColumns,
        changed_columns: changedColumns,
        shared_columns: sharedColumns
      },
      error: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to compare schema.'
    };
  }
}