export type DBType = 'postgres' | 'mssql' | 'mysql' | 'sqlite';

export type ToolName =
  | 'list_schemas'
  | 'get_database_info'
  | 'run_query'
  | 'db.execute_read_query'
  | 'github.list_org_repos'
  | 'github.get_repo_tree'
  | 'github.get_file_content'
  | 'github.search_code'
  | 'github.file_summary'
  | 'github.module_summary'
  | 'github.get_commit_history'
  | 'github.get_file_history'
  | 'github.compare_refs'
  | 'github.get_pull_request_comments'
  | 'list_tables'
  | 'search_tables'
  | 'search_columns'
  | 'get_table_schema'
  | 'get_table_summary'
  | 'get_view_definition'
  | 'get_view_summary'
  | 'get_procedure_summary'
  | 'get_function_summary'
  | 'get_sample_rows'
  | 'explain_query'
  | 'compare_schema'
  | 'get_column_stats'
  | 'search_views'
  | 'get_row_count'
  | 'get_foreign_key_summary'
  | 'search_functions'
  | 'search_procedures'
  | 'get_table_sample_by_columns'
  | 'get_dependency_graph'
  | 'compare_object_versions'
  | 'get_relation_path'
  | 'get_relationships'
  | 'get_indexes'
  | 'get_constraints'
  | 'list_stored_procedures';

export type RunQueryInput = {
  db: DBType;
  query: string;
};

export type ExecuteReadQueryInput = RunQueryInput;

export type GitHubListOrgReposInput = {
  org?: string;
  page?: number;
  per_page?: number;
  filter?: 'all' | 'public' | 'private' | 'forks' | 'sources' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
};

export type GitHubRepoTreeInput = {
  org?: string;
  repo: string;
  path?: string;
  branch?: string;
  depth?: number;
};

export type GitHubFileContentInput = {
  org?: string;
  repo: string;
  path: string;
  branch?: string;
};

export type GitHubSearchCodeInput = {
  org?: string;
  repo: string;
  query: string;
  limit?: number;
  language?: string;
};

export type GitHubFileSummaryInput = {
  org?: string;
  repo: string;
  path: string;
  branch?: string;
  context_lines?: number;
  focus_pattern?: string;
};

export type GitHubModuleSummaryInput = {
  org?: string;
  repo: string;
  path: string;
  branch?: string;
  max_files?: number;
  extensions?: string[];
};

export type GitHubCommitHistoryInput = {
  org?: string;
  repo: string;
  branch?: string;
  path?: string;
  author?: string;
  page?: number;
  per_page?: number;
};

export type GitHubFileHistoryInput = {
  org?: string;
  repo: string;
  path: string;
  branch?: string;
  page?: number;
  per_page?: number;
};

export type GitHubCompareRefsInput = {
  org?: string;
  repo: string;
  base: string;
  head: string;
  max_files?: number;
};

export type GitHubPullRequestCommentsInput = {
  org?: string;
  repo: string;
  pull_number: number;
};

export type ListTablesInput = {
  db: DBType;
};

export type ListSchemasInput = {
  db: DBType;
};

export type GetDatabaseInfoInput = {
  db: DBType;
};

export type SearchTablesInput = {
  db: DBType;
  query: string;
  schema?: string;
};

export type SearchColumnsInput = {
  db: DBType;
  query: string;
  schema?: string;
  limit?: number;
};

export type GetTableSummaryInput = {
  db: DBType;
  table: string;
  schema?: string;
};

export type GetViewSummaryInput = {
  db: DBType;
  view: string;
  schema?: string;
};

export type GetViewDefinitionInput = {
  db: DBType;
  view: string;
  schema?: string;
};

export type GetProcedureSummaryInput = {
  db: DBType;
  procedure: string;
  schema?: string;
};

export type GetFunctionSummaryInput = {
  db: DBType;
  func: string;
  schema?: string;
};

export type GetSampleRowsInput = {
  db: DBType;
  table: string;
  schema?: string;
  limit?: number;
};

export type ExplainQueryInput = {
  db: DBType;
  query: string;
};

export type CompareSchemaInput = {
  db: DBType;
  left_table: string;
  right_table: string;
  left_schema?: string;
  right_schema?: string;
};

export type GetColumnStatsInput = {
  db: DBType;
  table: string;
  schema?: string;
  limit?: number;
};

export type SearchViewsInput = {
  db: DBType;
  query: string;
  schema?: string;
  limit?: number;
};

export type GetRowCountInput = {
  db: DBType;
  table: string;
  schema?: string;
};

export type GetForeignKeySummaryInput = {
  db: DBType;
  table?: string;
  schema?: string;
  limit?: number;
};

export type SearchFunctionsInput = {
  db: DBType;
  query: string;
  schema?: string;
  limit?: number;
};

export type SearchProceduresInput = {
  db: DBType;
  query: string;
  schema?: string;
  limit?: number;
};

export type GetTableSampleByColumnsInput = {
  db: DBType;
  table: string;
  schema?: string;
  columns?: string[];
  limit?: number;
};

export type GetDependencyGraphInput = {
  db: DBType;
  table?: string;
  schema?: string;
  limit?: number;
};

export type CompareObjectVersionsInput = {
  db: DBType;
  object_type: 'table' | 'view' | 'procedure' | 'function';
  left_name: string;
  right_name: string;
  schema?: string;
  left_schema?: string;
  right_schema?: string;
};

export type GetRelationPathInput = {
  db: DBType;
  source_table: string;
  target_table: string;
  schema?: string;
  limit?: number;
};

export type GetIndexesInput = {
  db: DBType;
  table?: string;
  schema?: string;
};

export type GetConstraintsInput = {
  db: DBType;
  table?: string;
  schema?: string;
};

export type ListStoredProceduresInput = {
  db: DBType;
};

export type GetTableSchemaInput = {
  db: DBType;
  table: string;
  schema?: string;
};

export type GetRelationshipsInput = {
  db: DBType;
  table?: string;
  schema?: string;
};

export type DatabaseCredentials = {
  type: DBType;
  postgres?: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  mssql?: {
    server: string;
    username: string;
    password: string;
    database: string;
    port?: number;
  };
  mysql?: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  sqlite?: {
    filePath: string;
  };
};

export type ToolInputMap = {
  list_schemas: ListSchemasInput;
  get_database_info: GetDatabaseInfoInput;
  run_query: RunQueryInput;
  'db.execute_read_query': ExecuteReadQueryInput;
  'github.list_org_repos': GitHubListOrgReposInput;
  'github.get_repo_tree': GitHubRepoTreeInput;
  'github.get_file_content': GitHubFileContentInput;
  'github.search_code': GitHubSearchCodeInput;
  'github.file_summary': GitHubFileSummaryInput;
  'github.module_summary': GitHubModuleSummaryInput;
  'github.get_commit_history': GitHubCommitHistoryInput;
  'github.get_file_history': GitHubFileHistoryInput;
  'github.compare_refs': GitHubCompareRefsInput;
  'github.get_pull_request_comments': GitHubPullRequestCommentsInput;
  list_tables: ListTablesInput;
  search_tables: SearchTablesInput;
  search_columns: SearchColumnsInput;
  get_table_schema: GetTableSchemaInput;
  get_table_summary: GetTableSummaryInput;
  get_view_definition: GetViewDefinitionInput;
  get_view_summary: GetViewSummaryInput;
  get_procedure_summary: GetProcedureSummaryInput;
  get_function_summary: GetFunctionSummaryInput;
  get_sample_rows: GetSampleRowsInput;
  explain_query: ExplainQueryInput;
  compare_schema: CompareSchemaInput;
  get_column_stats: GetColumnStatsInput;
  search_views: SearchViewsInput;
  get_row_count: GetRowCountInput;
  get_foreign_key_summary: GetForeignKeySummaryInput;
  search_functions: SearchFunctionsInput;
  search_procedures: SearchProceduresInput;
  get_table_sample_by_columns: GetTableSampleByColumnsInput;
  get_dependency_graph: GetDependencyGraphInput;
  compare_object_versions: CompareObjectVersionsInput;
  get_relation_path: GetRelationPathInput;
  get_relationships: GetRelationshipsInput;
  get_indexes: GetIndexesInput;
  get_constraints: GetConstraintsInput;
  list_stored_procedures: ListStoredProceduresInput;
};

export type ToolRequestWithCredentials<TTool extends ToolName = ToolName> = {
  tool: TTool;
  input: ToolInputMap[TTool];
  credentials?: DatabaseCredentials;
};

export type ToolRequest<TTool extends ToolName = ToolName> = {
  tool: TTool;
  input: ToolInputMap[TTool];
};

export type ToolResponse<TData = unknown> = {
  success: boolean;
  data: TData | null;
  error: string | null;
};

export type QueryMetadata = {
  db: DBType;
  rows: number;
  columns: string[];
  query: string;
};
