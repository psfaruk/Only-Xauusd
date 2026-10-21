/**
 * /api/broker/settings — Task 33/35: UI-importable Exness MT5 credentials.
 * ----------------------------------------------------------------------------
 * GET  — masked settings view: active source (db | env | none), server,
 *        masked login, revision, updatedAt + the live bridge state
 *        (connected / authenticated / applied revision / balance).
 *        The password is NEVER returned — not even masked.
 *
 * POST — save credentials from the সেটিংস tab: validate → encrypt
 *        (AES-256-GCM) → persist (BrokerSettings singleton, revision++) →
 *        push to the bridge (POST /admin/credentials, authenticated internal
 *        channel) → return the post-reconnect bridge state. When the bridge
 *        is unreachable the credentials are still saved — the scheduler's
 *        drift sync re-pushes automatically once it returns.
 *
 * Guard: GET = read bucket, POST = trigger bucket (tight rate limit).
 */

import { NextResponse } from 'next/server';
import { guardDataApi, jsonError } from '@/lib/api-guard';
import { ErrorCode } from '@/lib/market/types';
import {
  getBrokerSettings,
  getActiveCredentials,
  saveBrokerCredentials,
  getBridgeCredentialState,
  pushCredentialsToBridge,
  maskLogin,
  validateCredentials,
} from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = guardDataApi(request, 'read');
  if (!guard.ok) return guard.response;

  try {
    const [row, active, bridge] = await Promise.all([
      getBrokerSettings(),
      getActiveCredentials(),
      getBridgeCredentialState(),
    ]);

    return NextResponse.json({
      ok: true,
      settings: row
        ? {
            source: active.source === 'db' ? 'db' : active.source, // 'db' unless decryption failed
            server: row.server,
            loginMasked: maskLogin(row.login),
            revision: row.revision,
            updatedBy: row.updatedBy,
            updatedAtUtc: row.updatedAt.toISOString(),
            passwordUnreadable: row.passwordUnreadable,
          }
        : null,
      activeSource: active.source,
      envFallback: active.source === 'env'
        ? { server: active.value.server, loginMasked: maskLogin(active.value.login) }
        : null,
      bridge: {
        reachable: bridge.ok,
        connected: bridge.connected ?? null,
        authenticated: bridge.authenticated ?? null,
        server: bridge.server ?? null,
        loginMasked: bridge.loginMasked ?? null,
        settingsRevision: bridge.settingsRevision ?? null,
      },
    });
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}

interface SaveBody {
  server?: unknown;
  login?: unknown;
  password?: unknown;
}

export async function POST(request: Request) {
  const guard = guardDataApi(request, 'trigger');
  if (!guard.ok) return guard.response;

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return jsonError(400, ErrorCode.BAD_REQUEST, 'Invalid JSON body.');
  }
  if (typeof body !== 'object' || body === null) {
    return jsonError(400, ErrorCode.BAD_REQUEST, 'Body must be a JSON object.');
  }
  if (body.password === undefined || body.password === '') {
    return jsonError(400, ErrorCode.BAD_REQUEST, 'পাসওয়ার্ড দিন (password required)');
  }

  const validated = validateCredentials({
    server: body.server,
    login: body.login,
    password: body.password,
  });
  if (!validated.ok) {
    return jsonError(400, ErrorCode.BAD_REQUEST, validated.error);
  }

  try {
    // 1) encrypt + persist (revision bump invalidates the read cache)
    const saved = await saveBrokerCredentials(validated.value, 'ui');
    if (!saved.ok || !saved.settings) {
      return jsonError(500, ErrorCode.DB_ERROR, saved.error ?? 'save failed');
    }

    // 2) push to the bridge — reconnect result reported honestly; a failed
    //    push does NOT roll the save back (drift sync retries every minute).
    const push = await pushCredentialsToBridge(validated.value);

    return NextResponse.json({
      ok: true,
      saved: {
        server: saved.settings.server,
        loginMasked: maskLogin(saved.settings.login),
        revision: saved.settings.revision,
        updatedAtUtc: saved.settings.updatedAt.toISOString(),
      },
      push: push.ok
        ? {
            ok: true,
            applied: true,
            authenticated:
              push.status?.authenticated === true || push.status?.connected === true,
            settingsRevision:
              typeof push.status?.settingsRevision === 'number'
                ? (push.status.settingsRevision as number)
                : null,
            server: typeof push.status?.server === 'string' ? (push.status.server as string) : null,
            loginMasked:
              typeof push.status?.loginMasked === 'string' ? (push.status.loginMasked as string) : null,
            accountBalance:
              typeof push.status?.accountBalance === 'number'
                ? (push.status.accountBalance as number)
                : null,
            accountEquity:
              typeof push.status?.accountEquity === 'number'
                ? (push.status.accountEquity as number)
                : null,
            symbols: typeof push.status?.symbols === 'number' ? (push.status.symbols as number) : null,
            lastError:
              typeof push.status?.lastError === 'string' ? (push.status.lastError as string) : null,
          }
        : { ok: false, applied: false, error: push.error ?? 'bridge unreachable' },
    });
  } catch (err) {
    return jsonError(500, ErrorCode.DB_ERROR, err instanceof Error ? err.message : 'database error');
  }
}
