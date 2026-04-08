import { CONFIG } from '@/lib/config';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryPostgres } from '@/lib/db/postgres';
import { queryMySQL } from '@/lib/db/mysql';
import { querySQLite } from '@/lib/db/sqlite';
import { validateReadOnlyQuery } from '@/lib/validators/queryValidator';
import type { DBType, QueryMetadata, ToolResponse, DatabaseCredentials } from '@/lib/types';

function hasExistingResultLimit(query: string): boolean {
  return /\b(limit|fetch\s+first)\b/i.test(query);
}

function injectPostgresLimit(query: string): string {
  if (/^explain\b/i.test(query)) {
    return query;
  }

  if (hasExistingResultLimit(query)) {
    return query;
  }

  return `${query} LIMIT ${CONFIG.app.maxRows}`;
}

function findTopLevelSelectIndex(sql: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inSingle) {
      if (char === "'" && next === "'") {
        index += 1;
        continue;
      }

      if (char === "'") {
        inSingle = false;
      }

      continue;
    }

    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      }

      continue;
    }

    if (inBracket) {
      if (char === ']') {
        inBracket = false;
      }

      continue;
    }

    if (char === "'") {
      inSingle = true;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      continue;
    }

    if (char === '[') {
      inBracket = true;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && /[sS]/.test(char)) {
      const slice = sql.slice(index);
      if (/^select\b/i.test(slice)) {
        return index;
      }
    }
  }

  return -1;
}

function injectMssqlTop(query: string): string {
  if (/^explain\b/i.test(query)) {
    return query;
  }

  const selectIndex = findTopLevelSelectIndex(query);
  if (selectIndex < 0) {
    return query;
  }

  const selectClause = query.slice(selectIndex).replace(/^select\s+/i, 'SELECT ');
  const distinctMatch = /^SELECT\s+DISTINCT\b/i.exec(selectClause);
  if (distinctMatch) {
    return `${query.slice(0, selectIndex)}SELECT DISTINCT TOP (${CONFIG.app.maxRows})${selectClause.slice(distinctMatch[0].length)}`;
  }

  const allMatch = /^SELECT\s+ALL\b/i.exec(selectClause);
  if (allMatch) {
    return `${query.slice(0, selectIndex)}SELECT ALL TOP (${CONFIG.app.maxRows})${selectClause.slice(allMatch[0].length)}`;
  }

  return `${query.slice(0, selectIndex)}SELECT TOP (${CONFIG.app.maxRows})${selectClause.slice('SELECT '.length)}`;
}

export async function runQuery(db: DBType, query: string, credentials?: DatabaseCredentials): Promise<ToolResponse<{ metadata: QueryMetadata; rows: unknown[] }>> {
  try {
    const validated = validateReadOnlyQuery(query);
    const executedQuery = db === 'postgres' ? injectPostgresLimit(validated) : db === 'mssql' ? injectMssqlTop(validated) : injectPostgresLimit(validated);

    if (db === 'postgres') {
      const result = await queryPostgres(executedQuery, [], credentials?.postgres);
      return {
        success: true,
        data: {
          metadata: {
            db,
            rows: result.rowCount,
            columns: result.fields,
            query: executedQuery
          },
          rows: result.rows
        },
        error: null
      };
    }

    if (db === 'mssql') {
      const result = await queryMSSQL(executedQuery, {}, credentials?.mssql);
      return {
        success: true,
        data: {
          metadata: {
            db,
            rows: result.rowCount,
            columns: result.columns,
            query: executedQuery
          },
          rows: result.rows
        },
        error: null
      };
    }

    if (db === 'mysql') {
      const rows = (await queryMySQL(executedQuery, credentials)) as unknown[];
      return {
        success: true,
        data: {
          metadata: {
            db,
            rows: rows.length,
            columns: Object.keys(rows[0] || {}),
            query: executedQuery
          },
          rows
        },
        error: null
      };
    }

    if (db === 'sqlite') {
      const rows = (await querySQLite(executedQuery, credentials)) as unknown[];
      return {
        success: true,
        data: {
          metadata: {
            db,
            rows: rows.length,
            columns: Object.keys(rows[0] || {}),
            query: executedQuery
          },
          rows
        },
        error: null
      };
    }

    return {
      success: false,
      error: 'Unsupported database type',
      data: null
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to execute query.'
    };
  }
}
