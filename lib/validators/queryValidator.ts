const BLOCKED_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|merge|create|replace|rename|call|execute|exec|grant|revoke|deny|into|openquery|openrowset|sp_executesql)\b|\bxp_/i;

export function validateReadOnlyQuery(query: string): string {
  const normalized = query.trim();

  if (!normalized) {
    throw new Error('Query is required.');
  }

  if (normalized.includes(';')) {
    throw new Error('Multiple statements are not allowed. Remove all semicolons.');
  }

  if (/--|\/\*|\*\//.test(normalized)) {
    throw new Error('SQL comments are not allowed.');
  }

  if (BLOCKED_KEYWORDS.test(normalized)) {
    throw new Error('Only read-only queries are allowed. Dangerous SQL keywords were detected.');
  }

  if (!/^(select|with|explain)\b/i.test(normalized)) {
    throw new Error('Only SELECT, WITH, and EXPLAIN queries are allowed.');
  }

  return normalized;
}

export function validateSelectOnlyQuery(query: string): string {
  const normalized = validateReadOnlyQuery(query);

  if (!/^select\b/i.test(normalized)) {
    throw new Error('Only SELECT queries are allowed.');
  }

  return normalized;
}
