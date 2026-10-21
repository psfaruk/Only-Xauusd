'use client';

/**
 * XAUUSD AI Trading Agent — সেটিংস tab (Task 33/35).
 * ----------------------------------------------------------------------------
 * UI-import for Exness MT5 credentials — the user never touches .env again:
 *
 *   · Live bridge connection state (server, masked login, applied revision)
 *   · Credential form: server / login / password → POST /api/broker/settings
 *     (server-side: AES-256-GCM encrypt → DB → push to the bridge → live
 *     reconnect; the post-reconnect state is reported honestly)
 *   · Env-fallback honesty: before the first save the app says the active
 *     credentials come from the server .env
 *   · Security notes: password encrypted at rest, never displayed again,
 *     never returned by any API — not even masked.
 *
 * Self-fetching component (own loading/error/refresh lifecycle) so page.tsx
 * needs zero new state plumbing.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Eye,
  EyeOff,
  Hourglass,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Unplug,
  User,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';

interface BridgeState {
  reachable: boolean;
  connected: boolean | null;
  authenticated: boolean | null;
  server: string | null;
  loginMasked: string | null;
  settingsRevision: number | null;
}

interface SettingsRow {
  source: string;
  server: string;
  loginMasked: string;
  revision: number;
  updatedBy: string;
  updatedAtUtc: string;
  passwordUnreadable: boolean;
}

interface SettingsGetResponse {
  ok: boolean;
  settings: SettingsRow | null;
  activeSource: 'db' | 'env' | 'none';
  envFallback: { server: string; loginMasked: string } | null;
  bridge: BridgeState;
  error?: { message?: string };
}

interface SettingsPostResponse {
  ok: boolean;
  saved: { server: string; loginMasked: string; revision: number; updatedAtUtc: string };
  push:
    | {
        ok: true;
        applied: boolean;
        authenticated: boolean;
        settingsRevision: number | null;
        server: string | null;
        loginMasked: string | null;
        accountBalance: number | null;
        accountEquity: number | null;
        symbols: number | null;
        lastError: string | null;
      }
    | { ok: false; applied: boolean; error: string };
  error?: { message?: string };
}

export function BrokerSettingsView() {
  const { toast } = useToast();

  const [data, setData] = useState<SettingsGetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [server, setServer] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<
    | { kind: 'ok'; text: string }
    | { kind: 'warn'; text: string }
    | { kind: 'error'; text: string }
    | null
  >(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/broker/settings', { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as SettingsGetResponse | null;
      if (!res.ok || !body || body.ok !== true) {
        setLoadError(body?.error?.message ?? `লোড ব্যর্থ (HTTP ${res.status})`);
        return;
      }
      setData(body);
      setLoadError(null);
      // Pre-fill the form with the active server (never the password).
      setServer((prev) =>
        prev ? prev : (body.settings?.server ?? body.envFallback?.server ?? 'Exness-MT5Trial6'),
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'নেটওয়ার্ক ত্রুটি');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = useCallback(async () => {
    if (saving) return;
    if (!server.trim() || !login.trim() || !password) {
      setSaveResult({ kind: 'error', text: 'সার্ভার, লগইন ও পাসওয়ার্ড — তিনটিই দিন।' });
      return;
    }
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch('/api/broker/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server: server.trim(), login: login.trim(), password }),
      });
      const body = (await res.json().catch(() => null)) as SettingsPostResponse | null;
      if (!res.ok || !body || body.ok !== true) {
        const msg = body?.error?.message ?? `সংরক্ষণ ব্যর্থ (HTTP ${res.status})`;
        setSaveResult({ kind: 'error', text: msg });
        toast({ title: 'সেটিংস সংরক্ষণ ব্যর্থ', description: msg, variant: 'destructive' });
        return;
      }
      if (body.push.ok && body.push.authenticated) {
        const bal = body.push.accountBalance;
        setSaveResult({
          kind: 'ok',
          text: `সংরক্ষিত ও সংযুক্ত — ${body.push.server ?? ''} · ${body.push.loginMasked ?? ''}${
            bal !== null ? ` · ব্যালেন্স $${bal.toFixed(2)}` : ''
          } (রিভিশন ${body.saved.revision})`,
        });
        toast({
          title: 'ব্রোকার ক্রেডেনশিয়াল সংরক্ষিত',
          description: `ব্রিজ নতুন ক্রেডেনশিয়াল দিয়ে সংযুক্ত — ${body.push.loginMasked ?? ''}`,
        });
      } else if (body.push.ok) {
        setSaveResult({
          kind: 'warn',
          text: `সংরক্ষিত (রিভিশন ${body.saved.revision}) কিন্তু ব্রোকার সংযোগ এখনো প্রমাণীকৃত নয়${
            body.push.lastError ? ` — ${body.push.lastError}` : ''
          }। ব্রিজ ব্যাকগ্রাউন্ডে পুনঃসংযোগ চেষ্টা করছে।`,
        });
        toast({
          title: 'সংরক্ষিত — সংযোগ অপেক্ষমাণ',
          description: 'ব্রিজ পুনঃসংযোগ চেষ্টা করছে; কিছুক্ষণ পরে রিফ্রেশ করুন।',
        });
      } else {
        setSaveResult({
          kind: 'warn',
          text: `ডেটাবেজে সংরক্ষিত (রিভিশন ${body.saved.revision}) কিন্তু ব্রিজ-এ পাঠানো যায়নি — ${body.push.error}। ব্রিজ ফিরে এলে শিডিউলার স্বয়ংক্রিয়ভাবে আবার পাঠাবে।`,
        });
        toast({
          title: 'সংরক্ষিত — ব্রিজ অনুপলব্ধ',
          description: 'ব্রিজ ফিরে এলে শিডিউলার স্বয়ংক্রিয়ভাবে ক্রেডেনশিয়াল পাঠাবে।',
        });
      }
      setPassword(''); // never keep the password in component state after save
      void load(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'নেটওয়ার্ক ত্রুটি';
      setSaveResult({ kind: 'error', text: msg });
      toast({ title: 'সেটিংস সংরক্ষণ ব্যর্থ', description: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [saving, server, login, password, toast, load]);

  const bridge = data?.bridge;
  const connected = bridge?.connected === true;
  const authenticated = bridge?.authenticated === true;

  return (
    <div className="space-y-4" data-testid="broker-settings-root">
      {/* ── bridge connection state ─────────────────────────────────────── */}
      <Card className="border-border bg-panel dark:shadow-none" data-testid="settings-bridge-card">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Server className="h-4 w-4 text-sun" aria-hidden />
            ব্রোকার সংযোগ
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="h-10 gap-1.5 px-3 text-xs font-medium text-content hover:bg-accent hover:text-foreground"
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label="সংযোগ অবস্থা রিফ্রেশ করুন"
            data-testid="settings-refresh"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            রিফ্রেশ
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="space-y-3" data-testid="settings-loading">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {['সংযোগ', 'সার্ভার', 'লগইন', 'প্রয়োগকৃত রিভিশন'].map((label) => (
                  <div key={label} className="min-w-0 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
                    <Skeleton className="h-6 w-full max-w-[120px]" />
                  </div>
                ))}
              </div>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> লোড হচ্ছে…
              </p>
            </div>
          ) : loadError ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm text-down"
              role="alert"
              data-testid="settings-load-error"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p className="min-w-0 leading-relaxed">{loadError}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="settings-bridge-grid">
              <div className="min-w-0 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">সংযোগ</p>
                {authenticated ? (
                  <Badge className="border-up/40 bg-up/10 text-[11px] text-up">
                    <BadgeCheck className="mr-1 h-3 w-3" aria-hidden /> সংযুক্ত ও প্রমাণীকৃত
                  </Badge>
                ) : connected ? (
                  <Badge className="border-sun/40 bg-sun/10 text-[11px] text-sun">
                    <Hourglass className="mr-1 h-3 w-3" aria-hidden /> সংযুক্ত (অপেক্ষমাণ)
                  </Badge>
                ) : (
                  <Badge className="border-down/40 bg-down/10 text-[11px] text-down">
                    <Unplug className="mr-1 h-3 w-3" aria-hidden /> বিচ্ছিন্ন
                  </Badge>
                )}
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">সার্ভার</p>
                <p className="break-all font-mono text-sm text-foreground" data-testid="settings-bridge-server">
                  {bridge?.server ?? data?.envFallback?.server ?? '—'}
                </p>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">লগইন</p>
                <p className="break-all font-mono text-sm text-foreground" data-testid="settings-bridge-login">
                  {bridge?.loginMasked ?? '—'}
                </p>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">প্রয়োগকৃত রিভিশন</p>
                <p className="break-all font-mono text-sm text-foreground" data-testid="settings-bridge-revision">
                  {bridge?.settingsRevision ?? '—'}
                </p>
              </div>
            </div>
          )}

          {/* Active source honesty line */}
          {!loading && !loadError && data && (
            <p
              className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
              data-testid="settings-source-note"
            >
              {data.activeSource === 'db' && data.settings && (
                <>
                  সক্রিয় ক্রেডেনশিয়ালের উৎস:{' '}
                  <span className="text-content">সেটিংস ট্যাব (ডেটাবেজ, রিভিশন {data.settings.revision})</span>
                  {data.settings.passwordUnreadable && (
                    <span className="text-sun"> — সংরক্ষিত পাসওয়ার্ড পড়া যাচ্ছে না, আবার সংরক্ষণ করুন</span>
                  )}
                </>
              )}
              {data.activeSource === 'env' && data.envFallback && (
                <>
                  সক্রিয় ক্রেডেনশিয়ালের উৎস:{' '}
                  <span className="text-content">সার্ভার .env ({data.envFallback.server} · {data.envFallback.loginMasked})</span>{' '}
                  — নিচের ফর্মে সংরক্ষণ করলে ভবিষ্যতে শুধু UI থেকে বদলাতে পারবেন
                </>
              )}
              {data.activeSource === 'none' && (
                <span className="text-sun">
                  কোনো ক্রেডেনশিয়াল কনফিগার করা নেই — নিচের ফর্মে Exness লগইন দিন
                </span>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── credentials form ────────────────────────────────────────────── */}
      <Card className="border-border bg-panel dark:shadow-none" data-testid="settings-form-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <KeyRound className="h-4 w-4 text-sun" aria-hidden />
            Exness MT5 ক্রেডেনশিয়াল
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label
                htmlFor="broker-server"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                সার্ভার <span className="font-normal normal-case tracking-normal text-muted-foreground/70">(যেমন Exness-MT5Trial6)</span>
              </Label>
              <Input
                id="broker-server"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="Exness-MT5Trial6"
                className="h-10 max-w-full rounded-lg border-border bg-muted font-mono text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted"
                autoComplete="off"
                spellCheck={false}
                data-testid="settings-input-server"
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label
                htmlFor="broker-login"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                লগইন <span className="font-normal normal-case tracking-normal text-muted-foreground/70">(নম্বর)</span>
              </Label>
              <Input
                id="broker-login"
                value={login}
                onChange={(e) => setLogin(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="৪১৪…"
                inputMode="numeric"
                className="h-10 max-w-full rounded-lg border-border bg-muted font-mono text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted"
                autoComplete="off"
                data-testid="settings-input-login"
              />
            </div>
          </div>
          <div className="min-w-0 space-y-2">
            <Label
              htmlFor="broker-password"
              className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              পাসওয়ার্ড
            </Label>
            <div className="relative">
              <Input
                id="broker-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Exness অ্যাকাউন্ট পাসওয়ার্ড"
                className="h-10 max-w-full rounded-lg border-border bg-muted pr-12 font-mono text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted"
                autoComplete="new-password"
                data-testid="settings-input-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={showPassword ? 'পাসওয়ার্ড লুকান' : 'পাসওয়ার্ড দেখান'}
                data-testid="settings-password-toggle"
              >
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void onSave()}
              disabled={saving || loading}
              className="h-10 gap-2 px-5 font-medium"
              data-testid="settings-save-button"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> সংযোগ হচ্ছে…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" aria-hidden /> সংরক্ষণ ও সংযোগ
                </>
              )}
            </Button>
            <p className="min-w-[180px] flex-1 text-xs leading-relaxed text-muted-foreground">
              সংরক্ষণ করলে ব্রিজ সাথে সাথে নতুন ক্রেডেনশিয়াল দিয়ে পুনঃসংযুক্ত হয় — কোনো রিস্টার্ট লাগে না।
            </p>
          </div>

          {saveResult && (
            <div
              role="status"
              aria-live="polite"
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                saveResult.kind === 'ok'
                  ? 'border-up/40 bg-up/10 text-up'
                  : saveResult.kind === 'warn'
                    ? 'border-sun/40 bg-sun/10 text-sun'
                    : 'border-down/40 bg-down/10 text-down'
              }`}
              data-testid="settings-save-result"
            >
              {saveResult.kind === 'ok' ? (
                <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : saveResult.kind === 'warn' ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <p className="min-w-0 leading-relaxed">{saveResult.text}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── security notes ──────────────────────────────────────────────── */}
      <Card className="border-border bg-panel dark:shadow-none" data-testid="settings-security-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4 text-up" aria-hidden />
            নিরাপত্তা
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 text-[13px] leading-relaxed text-content">
            <li className="flex items-start gap-2">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              পাসওয়ার্ড AES-256-GCM দিয়ে এনক্রিপ্ট হয়ে ডেটাবেজে থাকে — কোনো API কখনো এটি ফেরত দেয় না (মাস্কডও না)।
            </li>
            <li className="flex items-start gap-2">
              <User className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              লগইন নম্বর শুধু মাস্কড আকারে দেখানো হয় (যেমন ৪১৪•••৭০) — UI, API ও লগে।
            </li>
            <li className="flex items-start gap-2">
              <Server className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              প্রথমবারের আগে .env-এর ক্রেডেনশিয়াল কাজ করে; একবার এখানে সংরক্ষণ করলে UI-ই একমাত্র উৎস।
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
