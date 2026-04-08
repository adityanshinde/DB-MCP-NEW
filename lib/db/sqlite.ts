import sqlite3 from 'sqlite3';
import path from 'node:path';

import { CONFIG } from '@/lib/config';
import type { DatabaseCredentials } from '@/lib/types';

let defaultDb: sqlite3.Database | null = null;

function logSqliteEvent(message: string, error?: unknown): void {
  if (error) {
    console.error(`[sqlite] ${message}`, error);
    return;
  }

  console.info(`[sqlite] ${message}`);
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function resolveSQLitePath(filePath: string): string {
  const trimmed = filePath.trim();

  if (!trimmed) {
    throw new Error('SQLite file path is required.');
  }

  if (trimmed === ':memory:') {
    return trimmed;
  }

  if (trimmed.includes('\0')) {
    throw new Error('SQLite file path contains invalid characters.');
  }

  const allowedBaseDir = process.env.SQLITE_ALLOWED_DIR?.trim()
    ? path.resolve(process.env.SQLITE_ALLOWED_DIR.trim())
    : path.join(process.cwd(), 'data', 'sqlite');
  const resolvedPath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(allowedBaseDir, trimmed);
  const relativePath = path.relative(allowedBaseDir, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`SQLite file path must be inside the allowed directory: ${allowedBaseDir}`);
  }

  return resolvedPath;
}

function getDefaultDatabase(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    if (defaultDb) {
      resolve(defaultDb);
      return;
    }

    const filePath = process.env.SQLITE_PATH || ':memory:';
    const db = new sqlite3.Database(filePath, (err) => {
      if (err) reject(err);
      else {
        try {
          db.configure('busyTimeout', CONFIG.app.queryTimeoutMs);
        } catch {
          // Ignore configuration failures; the database is still usable.
        }

        defaultDb = db;
        logSqliteEvent('default database opened');
        resolve(db);
      }
    });
  });
}

function getDynamicDatabase(credentials: DatabaseCredentials): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    if (!credentials.sqlite) {
      reject(new Error('SQLite credentials not provided'));
      return;
    }

    const db = new sqlite3.Database(resolveSQLitePath(credentials.sqlite.filePath), (err) => {
      if (err) reject(err);
      else {
        try {
          db.configure('busyTimeout', CONFIG.app.queryTimeoutMs);
        } catch {
          // Ignore configuration failures; the database is still usable.
        }

        logSqliteEvent('dynamic database opened');
        resolve(db);
      }
    });
  });
}

async function withSQLiteDatabase<T>(credentials: DatabaseCredentials | undefined, work: (db: sqlite3.Database) => Promise<T>): Promise<T> {
  const db = await (credentials ? getDynamicDatabase(credentials) : getDefaultDatabase());

  try {
    return await work(db);
  } finally {
    if (credentials) {
      await new Promise<void>((resolve) => {
        db.close((error) => {
          if (error) {
            logSqliteEvent('failed to close dynamic database', error);
          } else {
            logSqliteEvent('dynamic database closed');
          }

          resolve();
        });
      });
    }
  }
}

function allRows<T>(db: sqlite3.Database, query: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        db.interrupt();
      } catch {
        // Ignore interrupt failures.
      }

      reject(new Error(`SQLite query timed out after ${CONFIG.app.queryTimeoutMs}ms.`));
    }, CONFIG.app.queryTimeoutMs);

    db.all(query, params, (err: Error | null, rows: T[]) => {
      clearTimeout(timeout);

      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
}

export async function querySQLite(
  query: string,
  credentials?: DatabaseCredentials,
  params: unknown[] = []
): Promise<unknown> {
  return withSQLiteDatabase(credentials, async (db) => allRows<unknown>(db, query, params));
}

export async function getTablesSQLite(
  credentials?: DatabaseCredentials
): Promise<string[]> {
  return withSQLiteDatabase(credentials, async (db) => {
    const rows = await allRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    return rows.map((row) => row.name);
  });
}

export async function getSchemaSQLite(
  table: string,
  credentials?: DatabaseCredentials
): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
  return withSQLiteDatabase(credentials, async (db) => {
    const rows = await allRows<{ name: string; type: string; notnull: number }>(db, `PRAGMA table_info(${quoteSqliteIdentifier(table)})`);
    return rows.map((row) => ({
      name: row.name,
      type: row.type,
      nullable: row.notnull === 0
    }));
  });
}

export async function getRelationshipsSQLite(
  table?: string,
  credentials?: DatabaseCredentials
): Promise<
  Array<{
    constraint: string;
    table: string;
    column: string;
    referenced_table: string;
    referenced_column: string;
  }>
> {
  return withSQLiteDatabase(credentials, async (db) => {
    const relationships: Array<{
      constraint: string;
      table: string;
      column: string;
      referenced_table: string;
      referenced_column: string;
    }> = [];

    const tables = table
      ? [table]
      : (await allRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
          .map((row) => row.name);

    for (const tbl of tables) {
      const fks = await allRows<{ id: number; table: string; from: string; to: string }>(db, `PRAGMA foreign_key_list(${quoteSqliteIdentifier(tbl)})`);

      for (const fk of fks) {
        relationships.push({
          constraint: `fk_${tbl}_${fk.id}`,
          table: tbl,
          column: fk.from,
          referenced_table: fk.table,
          referenced_column: fk.to
        });
      }
    }
    return relationships;
  });
}
