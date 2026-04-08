import { NextResponse } from 'next/server';

import { getMetadataCacheMetrics } from '@/lib/cache/metadataCache';
import { getGitHubMetrics } from '@/lib/tools/github/githubClient';
import { getMcpMetricsSnapshot } from '@/lib/runtime/mcpMetrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      metrics: {
        ...getMcpMetricsSnapshot(),
        cache: getMetadataCacheMetrics(),
        github: getGitHubMetrics()
      }
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0'
      }
    }
  );
}