import { NextResponse } from 'next/server';

import { CONFIG } from '@/lib/config';
import { createByocSessionToken, isByocLoginConfigured, verifyByocPassword } from '@/lib/runtime/byoc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isByocLoginConfigured()) {
    return NextResponse.json(
      {
        success: false,
        error: 'BYOC login is not configured. Set MCP_APP_PASSWORD and MCP_CREDENTIALS_ENCRYPTION_KEY first.'
      },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { password?: string };
  if (!body.password || !verifyByocPassword(body.password)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid app password.'
      },
      { status: 401 }
    );
  }

  const token = await createByocSessionToken();

  return NextResponse.json({
    success: true,
    token,
    expiresInSeconds: CONFIG.byoc.sessionTtlSeconds
  });
}