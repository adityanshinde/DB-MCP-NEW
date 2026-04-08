import { CONFIG } from '@/lib/config';
import { GITHUB_CACHE_TTLS, readThroughGitHubCacheDetailed } from '@/lib/cache/githubCache';
import {
  decodeGitHubFileContent,
  getGitHubContent,
  getGitHubRepositoryContext,
  recordGitHubSummaryCacheHit,
  recordGitHubSummaryCacheMiss,
  type GitHubRepoContext
} from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { normalizeGitHubBranch, normalizeGitHubPath } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type GitHubFileSummaryInput = {
  org?: string;
  repo?: string;
  path: string;
  branch?: string;
  context_lines?: number;
  focus_pattern?: string;
};

type GitHubFileSummaryOutput = {
  repo: string;
  branch: string;
  path: string;
  file_size_bytes: number;
  summary: {
    type: 'code' | 'markup' | 'config' | 'unknown';
    language: string | null;
    line_count: number;
    first_lines: string[];
    key_sections: Array<{
      pattern_matched?: string;
      context: string[];
      line_range: [number, number];
    }>;
    truncated: boolean;
  };
  preview_bytes_used: number;
};

function resolveLanguage(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    css: 'css',
    html: 'html',
    sql: 'sql'
  };

  return map[extension] || null;
}

function classifyFileType(path: string, language: string | null): 'code' | 'markup' | 'config' | 'unknown' {
  const lower = path.toLowerCase();

  if (lower.endsWith('.md') || lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'markup';
  }

  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml') || lower.endsWith('.env')) {
    return 'config';
  }

  if (language && language !== 'unknown') {
    return 'code';
  }

  return 'unknown';
}

function buildContext(lines: string[], lineIndex: number, contextLines: number): Array<{ context: string[]; line_range: [number, number] }> {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length, lineIndex + contextLines + 1);

  return [{
    context: lines.slice(start, end),
    line_range: [start + 1, end]
  }];
}

function findKeySections(lines: string[], contextLines: number, focusPattern?: string): Array<{ pattern_matched?: string; context: string[]; line_range: [number, number] }> {
  const sections: Array<{ pattern_matched?: string; context: string[]; line_range: [number, number] }> = [];

  if (focusPattern) {
    try {
      const pattern = new RegExp(focusPattern, 'i');
      lines.forEach((line, index) => {
        if (sections.length >= 3) {
          return;
        }

        if (pattern.test(line)) {
          const [section] = buildContext(lines, index, contextLines);
          sections.push({
            pattern_matched: focusPattern,
            ...section
          });
        }
      });
    } catch (error) {
      logMcpError('tool.execution_warning', error, { tool: 'github.file_summary', focusPattern });
      // Invalid regex falls back to generic section detection.
    }
  }

  if (sections.length === 0) {
    const genericPatterns = [/^\s*import\b/i, /^\s*export\b/i, /^\s*function\b/i, /^\s*class\b/i, /^\s*const\s+\w+\s*=\s*/i];

    lines.forEach((line, index) => {
      if (sections.length >= 3) {
        return;
      }

      if (genericPatterns.some((pattern) => pattern.test(line))) {
        const [section] = buildContext(lines, index, contextLines);
        sections.push(section);
      }
    });
  }

  return sections;
}

async function loadFileSummary(repoContext: GitHubRepoContext, path: string, branch: string | undefined, contextLines: number, focusPattern?: string): Promise<GitHubFileSummaryOutput> {
  const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;
  const normalizedPath = normalizeGitHubPath(path);
  const fileEntry = await getGitHubContent(repoContext, normalizedPath, resolvedBranch);

  if (Array.isArray(fileEntry)) {
    throw new Error(`Path ${normalizedPath} points to a directory. Use github.module_summary for folders.`);
  }

  const language = resolveLanguage(normalizedPath);
  const summaryType = classifyFileType(normalizedPath, language);

  if (fileEntry.size > CONFIG.github.maxFileSizeBytes) {
    return {
      repo: repoContext.repo,
      branch: resolvedBranch,
      path: normalizedPath,
      file_size_bytes: fileEntry.size,
      summary: {
        type: summaryType,
        language,
        line_count: 0,
        first_lines: [],
        key_sections: [],
        truncated: true
      },
      preview_bytes_used: 0
    };
  }

  const decoded = decodeGitHubFileContent(fileEntry);
  if (decoded === null) {
    return {
      repo: repoContext.repo,
      branch: resolvedBranch,
      path: normalizedPath,
      file_size_bytes: fileEntry.size,
      summary: {
        type: summaryType,
        language,
        line_count: 0,
        first_lines: [],
        key_sections: [],
        truncated: true
      },
      preview_bytes_used: 0
    };
  }

  const lines = decoded.split(/\r?\n/);
  const previewBytesUsed = Math.min(Buffer.byteLength(decoded), CONFIG.github.summaryPreviewBytes);
  const firstLines = lines.slice(0, 5);
  const keySections = findKeySections(lines, contextLines, focusPattern);

  return {
    repo: repoContext.repo,
    branch: resolvedBranch,
    path: normalizedPath,
    file_size_bytes: fileEntry.size,
    summary: {
      type: summaryType,
      language,
      line_count: lines.length,
      first_lines: firstLines,
      key_sections: keySections,
      truncated: Buffer.byteLength(decoded) > previewBytesUsed
    },
    preview_bytes_used: previewBytesUsed
  };
}

export async function fileSummary(input: GitHubFileSummaryInput): Promise<ToolResponse<GitHubFileSummaryOutput>> {
  logMcpEvent('tool.execute.start', { tool: 'github.file_summary', repo: input.repo, org: input.org });

  try {
    const resolvedRepo = resolveGitHubRepositoryContext({ org: input.org, repo: input.repo });
    const repoContext = await getGitHubRepositoryContext(resolvedRepo.fullName, input.branch);
    const contextLines = Math.max(1, Math.min(10, input.context_lines ?? CONFIG.github.summaryContextLines));
    const normalizedPath = normalizeGitHubPath(input.path);
    const result = await readThroughGitHubCacheDetailed({
      org: resolvedRepo.org,
      repo: repoContext.repo,
      branch: input.branch?.trim() || repoContext.resolvedBranch,
      path: normalizedPath,
      tool: 'file_summary',
      params: {
        context_lines: contextLines,
        focus_pattern: input.focus_pattern?.trim() || ''
      },
      ttlSeconds: GITHUB_CACHE_TTLS.summary,
      fetcher: async () => loadFileSummary(repoContext, normalizedPath, input.branch, contextLines, input.focus_pattern?.trim() || undefined)
    });

    if (result.cacheStatus === 'miss') {
      recordGitHubSummaryCacheMiss();
    } else {
      recordGitHubSummaryCacheHit();
    }

    return {
      success: true,
      data: result.value,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.file_summary', repo: input.repo, org: input.org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to summarize file.'
    };
  }
}