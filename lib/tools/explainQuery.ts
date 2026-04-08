import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import { querySQLite } from '@/lib/db/sqlite';
import { validateReadOnlyQuery } from '@/lib/validators/queryValidator';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { truncateText } from '@/lib/tools/toolUtils';

export async function explainQuery(
  db: DBType,
  query: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ db: DBType; query: string; plan: string[]; plan_preview: string }>> {
  try {
    const validated = validateReadOnlyQuery(query);

    if (db === 'postgres') {
      const result = await queryPostgres<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${validated}`,
        [],
        credentials?.postgres
      );

      const plan = result.rows.map((row) => row['QUERY PLAN']).filter(Boolean);
      return {
        success: true,
        data: {
          db,
          query: validated,
          plan,
          plan_preview: truncateText(plan.join('\n'), 500)
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(
        `SET SHOWPLAN_TEXT ON;
         ${validated};
         SET SHOWPLAN_TEXT OFF;`,
        {},
        credentials?.mssql
      );

      const plan = result.rows.map((row) => JSON.stringify(row));
      return {
        success: true,
        data: {
          db,
          query: validated,
          plan,
          plan_preview: truncateText(plan.join('\n'), 500)
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(
        `EXPLAIN ${validated}`,
        credentials
      )) as Array<Record<string, unknown>>;

      const plan = rows.map((row) => JSON.stringify(row));
      return {
        success: true,
        data: {
          db,
          query: validated,
          plan,
          plan_preview: truncateText(plan.join('\n'), 500)
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const rows = (await querySQLite(
        `EXPLAIN QUERY PLAN ${validated}`,
        credentials
      )) as Array<Record<string, unknown>>;

      const plan = rows.map((row) => JSON.stringify(row));
      return {
        success: true,
        data: {
          db,
          query: validated,
          plan,
          plan_preview: truncateText(plan.join('\n'), 500)
        },
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
      error: error instanceof Error ? error.message : 'Failed to explain query.'
    };
  }
}