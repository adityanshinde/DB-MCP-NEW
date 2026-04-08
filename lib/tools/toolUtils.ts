export function quoteIdentifier(db: 'postgres' | 'mssql' | 'mysql' | 'sqlite', identifier: string): string {
  if (db === 'mssql') {
    return `[${identifier.replace(/]/g, ']]')}]`;
  }

  if (db === 'mysql') {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

export function normalizeSchemaFilter(db: 'postgres' | 'mssql' | 'mysql' | 'sqlite', schema?: string): string {
  return (schema || (db === 'postgres' ? 'public' : 'dbo')).trim();
}