/**
 * XAUUSD AI Trading Agent — Broker Settings Store (Task 33/35)
 * ----------------------------------------------------------------------------
 * DB-backed, UI-importable Exness MT5 credentials with:
 *
 *   · AES-256-GCM encryption at rest — the password NEVER lives in the
 *     database (or any API response) in plaintext. Key file: db/settings.key
 *     (auto-generated 32 bytes, hex, chmod 600, git-ignored).
 *   · Revision counter — bumped on every save; the bridge reports the
 *     revision it has applied, so drift (bridge restart with stale .env
 *     credentials) is detectable and self-healing.
 *   · Push-to-bridge — saving via the UI immediately re-credentials the
 *     bridge over the authenticated internal channel (POST /admin/credentials
 *     with x-trader-key); no service restart needed.
 *   · Env fallback — when no DB row exists yet, the .env credentials remain
 *     the active source (and the UI says so honestly).
 *   · Fail-closed + never throws for reads: an unreadable/missing key file
 *     degrades to `password: null` with an honest error marker — the user
 *     simply re-enters credentials in the সেটিংস tab.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';

// ── types ───────────────────────────────────────────────────────────────────

export interface BrokerCredentials {
  server: string;
  login: string;
  password: string;
}

export interface StoredBrokerSettings {
  server: string;
  login: string;
  /** Plaintext password — ONLY ever produced server-side for the bridge
   *  push; never serialized into any API response. */
  password: string | null;
  /** Honest marker when decryption failed (key file lost / row corrupt). */
  passwordUnreadable: boolean;
  revision: number;
  updatedBy: string;
  updatedAt: Date;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  settings?: StoredBrokerSettings;
}

export interface BridgeCredentialPushResult {
  ok: boolean;
  /** Bridge /api/status snapshot after the reconnect attempt. */
  status?: Record<string, unknown>;
  error?: string;
}

// ── validation ──────────────────────────────────────────────────────────────

const SERVER_RE = /^[A-Za-z0-9._-]{3,64}$/;
const LOGIN_RE = /^[0-9]{4,20}$/;

export function validateCredentials(input: {
  server: unknown;
  login: unknown;
  password: unknown;
}): { ok: true; value: BrokerCredentials } | { ok: false; error: string } {
  const server = typeof input.server === 'string' ? input.server.trim() : '';
  const login = typeof input.login === 'string' ? input.login.trim() : String(input.login ?? '').trim();
  const password = typeof input.password === 'string' ? input.password : '';

  if (!SERVER_RE.test(server)) {
    return { ok: false, error: 'সার্ভার নাম সঠিক নয় (যেমন: Exness-MT5Trial6)' };
  }
  if (!LOGIN_RE.test(login)) {
    return { ok: false, error: 'লগইন নম্বর সঠিক নয় (৪-২০ সংখ্যা)' };
  }
  if (password.length < 4 || password.length > 64) {
    return { ok: false, error: 'পাসওয়ার্ড ৪-৬৪ অক্ষরের মধ্যে হতে হবে' };
  }
  return { ok: true, value: { server, login, password } };
}

// ── AES-256-GCM key management ──────────────────────────────────────────────

const KEY_DIR = join(process.cwd(), 'db');
const KEY_PATH = join(KEY_DIR, 'settings.key');

function loadOrCreateKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    const hex = readFileSync(KEY_PATH, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    // Corrupt key file — regenerate (stored passwords become unreadable;
    // the UI reports this honestly and the user re-enters credentials).
  }
  if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  try { chmodSync(KEY_PATH, 0o600); } catch { /* best-effort on odd mounts */ }
  return key;
}

function encryptPassword(plaintext: string): string {
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptPassword(payload: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const key = loadOrCreateKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null; // wrong key / tampered row — honest unreadable marker
  }
}

// ── DB access (cached 5 s for reads; writes always hit the DB) ─────────────

export function maskLogin(login: string): string {
  if (login.length <= 4) return `${login.slice(0, 1)}•••`;
  return `${login.slice(0, 3)}•••${login.slice(-2)}`;
}

let cache: { at: number; row: StoredBrokerSettings | null } = { at: 0, row: null };
const CACHE_TTL_MS = 5_000;

function rowToSettings(row: { server: string; login: string; passwordEnc: string; revision: number; updatedBy: string; updatedAt: Date }): StoredBrokerSettings {
  const password = decryptPassword(row.passwordEnc);
  return {
    server: row.server,
    login: row.login,
    password,
    passwordUnreadable: password === null,
    revision: row.revision,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export async function getBrokerSettings(): Promise<StoredBrokerSettings | null> {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.row;
  const row = await db.brokerSettings.findUnique({ where: { id: 1 } });
  cache = { at: Date.now(), row: row ? rowToSettings(row) : null };
  return cache.row;
}

export async function saveBrokerCredentials(
  value: BrokerCredentials,
  updatedBy = 'ui',
): Promise<SaveResult> {
  const existing = await db.brokerSettings.findUnique({ where: { id: 1 } });
  const data = {
    server: value.server,
    login: value.login,
    passwordEnc: encryptPassword(value.password),
    revision: (existing?.revision ?? 0) + 1,
    updatedBy,
    updatedAt: new Date(),
  };
  const row = existing
    ? await db.brokerSettings.update({ where: { id: 1 }, data })
    : await db.brokerSettings.create({ data: { id: 1, ...data } });
  cache = { at: 0, row: null }; // invalidate
  return { ok: true, settings: rowToSettings(row) };
}

/** The credentials the system should actively use: DB row first, .env as the
 *  bootstrapping fallback (honest source label included). */
export async function getActiveCredentials(): Promise<
  { source: 'db'; value: BrokerCredentials; revision: number } | { source: 'env'; value: BrokerCredentials } | { source: 'none' }
> {
  const row = await getBrokerSettings();
  if (row && row.password) {
    return { source: 'db', value: { server: row.server, login: row.login, password: row.password }, revision: row.revision };
  }
  const envLogin = (process.env.MT5_LOGIN ?? '').trim();
  const envPassword = process.env.MT5_PASSWORD ?? '';
  const envServer = (process.env.MT5_SERVER ?? '').trim();
  if (envLogin && envPassword && envServer) {
    return { source: 'env', value: { server: envServer, login: envLogin, password: envPassword } };
  }
  return { source: 'none' };
}

// ── bridge push + drift sync ────────────────────────────────────────────────

const BRIDGE_URL = () => (process.env.MT5_BRIDGE_URL ?? '').replace(/\/+$/, '');
const BRIDGE_TOKEN = () => process.env.MT5_BRIDGE_TOKEN ?? '';

/** Push credentials to the bridge (authenticated internal POST). The bridge
 *  tears down its MT5 session and reconnects with the new credentials, then
 *  reports its state. Never throws — always a discriminated result. */
export async function pushCredentialsToBridge(
  value: BrokerCredentials,
  timeoutMs = 25_000,
): Promise<BridgeCredentialPushResult> {
  const url = BRIDGE_URL();
  const token = BRIDGE_TOKEN();
  if (!url || !token) {
    return { ok: false, error: 'BRIDGE_NOT_CONFIGURED — MT5_BRIDGE_URL / MT5_BRIDGE_TOKEN নেই' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/admin/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trader-key': token },
      body: JSON.stringify({ server: value.server, login: value.login, password: value.password }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && body && typeof body === 'object' && 'authenticated' in body) {
      return { ok: true, status: body as Record<string, unknown> };
    }
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? String((body as Record<string, unknown>).detail)
        : `HTTP ${res.status}`;
    return { ok: false, error: detail };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'bridge unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the bridge's applied-credential revision (cheap GET /api/status). */
export async function getBridgeCredentialState(
  timeoutMs = 4_000,
): Promise<{ ok: boolean; settingsRevision?: number; connected?: boolean; authenticated?: boolean; loginMasked?: string | null; server?: string | null }> {
  const url = BRIDGE_URL();
  const token = BRIDGE_TOKEN();
  if (!url || !token) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/status`, {
      headers: { 'x-trader-key': token },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return { ok: false };
    return {
      ok: true,
      settingsRevision: typeof body.settingsRevision === 'number' ? body.settingsRevision : undefined,
      connected: body.connected === true,
      authenticated: body.authenticated === true,
      loginMasked: typeof body.loginMasked === 'string' ? body.loginMasked : null,
      server: typeof body.server === 'string' ? body.server : null,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Drift sync — called from the scheduler tick: when DB credentials exist and
 *  the bridge has not applied that revision yet (restart with stale .env,
 *  bridge crash-loop, etc.), re-push. Fire-and-forget safe. */
export async function syncBridgeCredentials(): Promise<{ pushed: boolean; reason: string }> {
  const active = await getActiveCredentials();
  if (active.source !== 'db') return { pushed: false, reason: 'no db credentials' };
  const bridge = await getBridgeCredentialState();
  if (!bridge.ok) return { pushed: false, reason: 'bridge status unreachable' };
  if (bridge.settingsRevision === active.revision && bridge.authenticated) {
    return { pushed: false, reason: 'in sync' };
  }
  const result = await pushCredentialsToBridge(active.value);
  return { pushed: true, reason: result.ok ? 'pushed' : `push failed: ${result.error ?? 'unknown'}` };
}
