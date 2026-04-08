import { CONFIG } from '@/lib/config';

import {
  recordGitHubExcessiveRepoScan,
  recordGitHubRepoResolutionAttempt
} from '@/lib/tools/github/githubClient';
import { ensureAllowedGitHubRepository, normalizeGitHubRepository } from '@/lib/validators/githubValidator';

export type GitHubRepositoryResolution = {
  org: string;
  repo: string;
  fullName: string;
};

function normalizeOrgName(org?: string): string {
  const resolved = org?.trim() || CONFIG.github.orgName.trim();
  if (!resolved) {
    throw new Error('GitHub organization is required. Set GITHUB_ORG_NAME or provide org explicitly.');
  }

  return resolved;
}

function getAllowedReposForOrg(org: string): string[] {
  const normalizedOrg = org.toLowerCase();
  return CONFIG.github.allowedRepos.filter((repo) => repo.toLowerCase().startsWith(`${normalizedOrg}/`));
}

export function getAllowedOrgList(): string[] {
  const derivedOrgs = new Set<string>(CONFIG.github.allowedRepos.map((repo) => repo.split('/')[0]?.trim().toLowerCase()).filter(Boolean) as string[]);

  if (CONFIG.github.orgName.trim()) {
    derivedOrgs.add(CONFIG.github.orgName.trim().toLowerCase());
  }

  for (const org of CONFIG.github.allowedOrgs) {
    if (org.trim()) {
      derivedOrgs.add(org.trim().toLowerCase());
    }
  }

  return Array.from(derivedOrgs);
}

export function isAllowedOrg(org: string): boolean {
  return getAllowedOrgList().includes(org.trim().toLowerCase());
}

export function getAllowedReposForOrgName(org?: string): string[] {
  return getAllowedReposForOrg(normalizeOrgName(org));
}

export function resolveGitHubRepositoryContext(input: { org?: string; repo?: string }): GitHubRepositoryResolution {
  if (input.repo) {
    const normalized = input.repo.includes('/')
      ? normalizeGitHubRepository(input.repo)
      : normalizeGitHubRepository(`${normalizeOrgName(input.org)}/${input.repo}`);
    const [repoOrg] = normalized.split('/');

    const org = input.org?.trim() || repoOrg;

    if (repoOrg.toLowerCase() !== org.toLowerCase()) {
      throw new Error(`Repository ${normalized} is not in organization ${org}.`);
    }

    const allowedRepository = ensureAllowedGitHubRepository(normalized);

    recordGitHubRepoResolutionAttempt('success');
    return {
      org,
      repo: allowedRepository,
      fullName: allowedRepository
    };
  }

  const org = normalizeOrgName(input.org);

  const allowedRepos = getAllowedReposForOrg(org);
  if (allowedRepos.length === 1) {
    recordGitHubRepoResolutionAttempt('success');
    return {
      org,
      repo: allowedRepos[0],
      fullName: allowedRepos[0]
    };
  }

  if (allowedRepos.length === 0) {
    recordGitHubRepoResolutionAttempt('not_found');
    throw new Error(`No allowlisted repositories configured for organization ${org}.`);
  }

  recordGitHubRepoResolutionAttempt('ambiguous');
  recordGitHubExcessiveRepoScan();
  throw new Error(`Multiple repositories are allowlisted for ${org}. Specify repo explicitly as owner/repo.`);
}

export function validateOrgAccess(org?: string): string {
  const normalizedOrg = normalizeOrgName(org);

  if (!isAllowedOrg(normalizedOrg)) {
    throw new Error(`Organization ${normalizedOrg} is not allowed.`);
  }

  return normalizedOrg;
}

export function resolveGitHubOrgForListing(org?: string): string {
  return validateOrgAccess(org);
}
