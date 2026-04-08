import { NextResponse } from 'next/server';

import { clearByocSession, loadByocSessionCredentials, readByocToken, saveByocSessionCredentials } from '@/lib/runtime/byoc';
import type { UserCredentials } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readTokenFromRequest(request: Request, bodyToken?: string): string | null {
  return readByocToken(request) || bodyToken || null;
}

function summarizeCredentials(credentials: UserCredentials | null): Record<string, unknown> {
  return {
    hasDatabaseCredentials: Boolean(credentials?.db),
    hasGitHubCredentials: Boolean(credentials?.github),
    databaseType: credentials?.db?.type ?? null,
    githubOrgName: credentials?.github?.orgName ?? null,
    allowedRepositories: credentials?.github?.allowedRepos?.length ?? 0,
    allowedOrganizations: credentials?.github?.allowedOrgs?.length ?? 0
  };
}

export async function GET(request: Request) {
  const token = readTokenFromRequest(request);
  if (!token) {
    return NextResponse.json({ success: false, error: 'Token is required.' }, { status: 401 });
  }

  const credentials = await loadByocSessionCredentials(token);
  if (!credentials) {
    return NextResponse.json({ success: false, error: 'Unknown BYOC session.' }, { status: 401 });
  }

  return NextResponse.json({ success: true, ...summarizeCredentials(credentials) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string; credentials?: UserCredentials };
  const token = readTokenFromRequest(request, body.token);

  if (!token) {
    return NextResponse.json({ success: false, error: 'Token is required.' }, { status: 401 });
  }

  const credentials = body.credentials;
  if (!credentials) {
    return NextResponse.json({ success: false, error: 'Credentials are required.' }, { status: 400 });
  }

  let saved: UserCredentials;
  try {
    saved = await saveByocSessionCredentials(token, credentials);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials.'
      },
      { status: error instanceof Error && error.message === 'Unknown BYOC session token.' ? 401 : 500 }
    );
  }

  return NextResponse.json({ success: true, ...summarizeCredentials(saved) });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const token = readTokenFromRequest(request, body.token);

  if (!token) {
    return NextResponse.json({ success: false, error: 'Token is required.' }, { status: 401 });
  }

  await clearByocSession(token);

  return NextResponse.json({ success: true });
}