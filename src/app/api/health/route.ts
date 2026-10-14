/**
 * GET /api/health — live system health.
 * Used by the dashboard status strip, monitoring and the get_system_health tool.
 */
import { NextResponse } from 'next/server';
import { collectHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const health = await collectHealth();
    return NextResponse.json(health, { status: health.status === 'ok' ? 200 : 503 });
  } catch (err) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 500 },
    );
  }
}
