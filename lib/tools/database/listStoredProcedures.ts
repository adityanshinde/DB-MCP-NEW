import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryPostgres } from '@/lib/db/postgres';
import { queryMySQL } from '@/lib/db/mysql';
import type { DBType, ToolResponse, DatabaseCredentials } from '@/lib/types';

type StoredProcedureRow = {
  schema?: string;
  name?: string;
  routine_schema?: string;
  routine_name?: string;
  SPECIFIC_SCHEMA?: string;
  SPECIFIC_NAME?: string;
};

export async function listStoredProcedures(
  db: DBType,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ procedures: { schema: string; name: string }[] }>> {
  try {
    const data = await readThroughMetadataCache({
      db,
      tool: 'listStoredProcedures',
      schema: 'all',
      params: { scope: 'all' },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.procedures,
      fetcher: async () => {
        if (db === 'postgres') {
          const result = await queryPostgres<StoredProcedureRow>(
            `
              SELECT routine_schema AS schema,
                     routine_name  AS name
              FROM information_schema.routines
              WHERE routine_type = 'PROCEDURE'
              ORDER BY routine_schema, routine_name
            `,
            [],
            credentials?.postgres
          );

          return {
            procedures: result.rows.map((row) => ({
              schema: row.schema ?? row.routine_schema ?? 'public',
              name: row.name ?? row.routine_name ?? ''
            }))
          };
        }

        if (db === 'mssql') {
          const result = await queryMSSQL(
            `
              SELECT SPECIFIC_SCHEMA,
                     SPECIFIC_NAME
              FROM INFORMATION_SCHEMA.ROUTINES
              WHERE ROUTINE_TYPE = 'PROCEDURE'
              ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME
            `,
            {},
            credentials?.mssql
          );

          const rows = result.rows as StoredProcedureRow[];
          return {
            procedures: rows.map((row) => ({
              schema: String(row.SPECIFIC_SCHEMA ?? row.schema ?? ''),
              name: String(row.SPECIFIC_NAME ?? row.name ?? '')
            }))
          };
        }

        if (db === 'mysql') {
          const query = `
            SELECT ROUTINE_SCHEMA,
                   ROUTINE_NAME
            FROM INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_TYPE = 'PROCEDURE'
            ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
          `;

          const result = (await queryMySQL(query, credentials)) as Array<{ ROUTINE_SCHEMA: string; ROUTINE_NAME: string }>;

          return {
            procedures: result.map((row) => ({
              schema: String(row.ROUTINE_SCHEMA ?? ''),
              name: String(row.ROUTINE_NAME ?? '')
            }))
          };
        }

        if (db === 'sqlite') {
          return { procedures: [] };
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
      error: error instanceof Error ? error.message : 'Failed to list stored procedures.'
    };
  }
}

