import { METADATA_CACHE_TTLS, readThroughMetadataCache } from '@/lib/cache/metadataCache';
import { queryMSSQL } from '@/lib/db/mssql';
import { queryMySQL } from '@/lib/db/mysql';
import { queryPostgres } from '@/lib/db/postgres';
import type { DBType, DatabaseCredentials, ToolResponse } from '@/lib/types';
import { normalizeSchemaFilter, truncateText } from '@/lib/tools/toolUtils';

type RoutineKind = 'PROCEDURE' | 'FUNCTION';

type RoutineParameter = {
  name: string;
  mode: string;
  data_type: string;
  ordinal_position: number;
};

function isSupportedDatabase(db: DBType): boolean {
  return db === 'postgres' || db === 'mssql' || db === 'mysql';
}

async function getRoutineRow(db: DBType, kind: RoutineKind, name: string, schema?: string, credentials?: DatabaseCredentials) {
  if (db === 'postgres') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryPostgres<{ routine_schema: string; routine_name: string; routine_type: string; data_type: string | null; routine_definition: string | null }>(
      `SELECT routine_schema,
              routine_name,
              routine_type,
              data_type,
              routine_definition
       FROM information_schema.routines
       WHERE routine_type = $1 AND routine_schema = $2 AND routine_name = $3`,
      [kind, resolvedSchema, name],
      credentials?.postgres
    );
    return result.rows[0] ?? null;
  }

  if (db === 'mssql') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryMSSQL(
      `SELECT routine_schema,
              routine_name,
              routine_type,
              data_type
       FROM information_schema.routines
       WHERE routine_type = @routineType AND routine_schema = @schemaName AND routine_name = @routineName`,
      { routineType: kind, schemaName: resolvedSchema, routineName: name },
      credentials?.mssql
    );
    return (result.rows as Array<Record<string, unknown>>)[0] ?? null;
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT routine_schema,
              routine_name,
              routine_type,
              data_type,
              routine_definition
       FROM information_schema.routines
       WHERE routine_type = ? AND routine_schema = DATABASE() AND routine_name = ?`,
      credentials,
      [kind, name]
    )) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  }

  return null;
}

async function getParameters(db: DBType, name: string, schema?: string, credentials?: DatabaseCredentials): Promise<RoutineParameter[]> {
  if (db === 'postgres') {
    return [];
  }

  if (db === 'mssql') {
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const result = await queryMSSQL(
      `SELECT parameter_name AS name,
              parameter_mode AS mode,
              data_type,
              ordinal_position
       FROM information_schema.parameters
       WHERE specific_schema = @schemaName AND specific_name = @routineName
       ORDER BY ordinal_position`,
      { schemaName: resolvedSchema, routineName: name },
      credentials?.mssql
    );
    return result.rows as RoutineParameter[];
  }

  if (db === 'mysql') {
    const rows = (await queryMySQL(
      `SELECT parameter_name AS name,
              parameter_mode AS mode,
              data_type,
              ordinal_position
       FROM information_schema.parameters
       WHERE specific_schema = DATABASE() AND specific_name = ?
       ORDER BY ordinal_position`,
      credentials,
      [name]
    )) as RoutineParameter[];
    return rows;
  }

  return [];
}

export async function getRoutineSummary(
  db: DBType,
  kind: RoutineKind,
  name: string,
  schema?: string,
  credentials?: DatabaseCredentials
): Promise<ToolResponse<{ supported: boolean; routine: Record<string, unknown> | null; parameters: RoutineParameter[] }>> {
  try {
    if (!isSupportedDatabase(db)) {
      return {
        success: true,
        data: { supported: false, routine: null, parameters: [] },
        error: null
      };
    }
    const resolvedSchema = normalizeSchemaFilter(db, schema);
    const data = await readThroughMetadataCache({
      db,
      tool: 'getRoutineSummary',
      schema: resolvedSchema,
      params: { kind, name },
      credentials,
      ttlSeconds: METADATA_CACHE_TTLS.summary,
      fetcher: async () => {
        const routine = await getRoutineRow(db, kind, name, schema, credentials);
        const parameters = await getParameters(db, name, schema, credentials);

        if (!routine) {
          return { supported: true, routine: null, parameters: [] };
        }

        const routineRecord = routine as Record<string, unknown>;
        const definitionPreview = 'routine_definition' in routine ? truncateText(String(routine.routine_definition ?? ''), 200) : undefined;

        return {
          supported: true,
          routine: {
            schema: String(routineRecord.routine_schema ?? routineRecord.schema ?? resolvedSchema),
            name: String(routineRecord.routine_name ?? routineRecord.name ?? ''),
            routine_type: String(routineRecord.routine_type ?? kind),
            return_type: String(routineRecord.data_type ?? ''),
            definition_preview: definitionPreview
          },
          parameters
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
      error: error instanceof Error ? error.message : 'Failed to summarize routine.'
    };
  }
}