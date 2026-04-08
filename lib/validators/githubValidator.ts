import { CONFIG } from '@/lib/config';

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeGitHubRepository(repository: string): string {
  const normalized = repository.trim();

  if (!normalized) {
    throw new Error('GitHub repository is required.');
  }

  if (!GITHUB_REPO_PATTERN.test(normalized)) {
    throw new Error('GitHub repository must use owner/repo format.');
  }

  return normalized;
}

export function ensureAllowedGitHubRepository(repository: string): string {
  const normalized = normalizeGitHubRepository(repository).toLowerCase();
  const allowedRepos = CONFIG.github.allowedRepos;

  if (allowedRepos.length === 0) {
    throw new Error('GitHub repositories are not configured. Set GITHUB_ALLOWED_REPOS first.');
  }

  const allowedSet = new Set(allowedRepos.map((repo) => repo.toLowerCase()));
  if (!allowedSet.has(normalized)) {
    throw new Error(`Repository ${normalized} is not allowlisted.`);
  }

  return normalized;
}

export function splitGitHubRepository(repository: string): { owner: string; name: string; fullName: string } {
  const normalized = normalizeGitHubRepository(repository);
  const [owner, name] = normalized.split('/');

  return {
    owner,
    name,
    fullName: `${owner}/${name}`
  };
}

export function normalizeGitHubPath(path?: string): string {
  if (!path) {
    return '';
  }

  const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized) {
    return '';
  }

  if (normalized.includes('..')) {
    throw new Error('Relative path segments are not allowed.');
  }

  return normalized;
}

export function normalizeGitHubBranch(branch?: string): string | undefined {
  const normalized = branch?.trim();
  return normalized ? normalized : undefined;
}

export function sanitizeGitHubSearchQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/g, ' ');

  if (!normalized) {
    throw new Error('Search query is required.');
  }

  if (normalized.length > 256) {
    throw new Error('Search query must be 256 characters or fewer.');
  }

  return normalized;
}

export function clampGitHubLimit(value: number | undefined, min: number, max: number, fallback: number): number {
  const resolved = value ?? fallback;
  return Math.max(min, Math.min(max, resolved));
}