/**
 * XAUUSD AI Trading Agent — Session & News Agent (A7, Phase 14, Task 34-a)
 * ----------------------------------------------------------------------------
 * PURE and DETERMINISTIC in the evaluation instant. Maps any UTC instant to:
 *   · the active trading session (Asia / London / New York / overlap),
 *   · ICT killzone state (London Open + New York Open windows),
 *   · an approximate high-impact NEWS BLACKOUT flag.
 *
 * HONESTY CONTRACT (same discipline as market/sessions.ts):
 *   · Session boundaries below are WIDENED envelopes derived from generic
 *     spot-gold conventions — they are NOT a verified broker schedule and no
 *     live economic-calendar feed is claimed. The blackout windows cover the
 *     recurring high-impact release slots for XAUUSD (US data cluster around
 *     12:30/13:30 UTC across both DST variants; US conference cluster around
 *     15:00/16:00 UTC). They are APPROXIMATE envelopes, configurable via env,
 *     and labelled as such everywhere they surface.
 *   · The agent never fabricates a "verified" calendar event; it only says
 *     "inside an approximate blackout envelope — scalping vetoed".
 *
 * Weekend (Sat, and Fri late / Sun early handled by the market-closure module)
 * → OFF_HOURS, no killzone. The news flag is not raised on weekends (the
 * market being closed is already a harder gate upstream).
 */

import type { KillzoneName, SessionState, SmcSessionConfig, TradingSession } from './types';

/** Session windows in UTC minutes-from-midnight (widened, both DST variants). */
const ASIA_FROM_MIN = 0;
const ASIA_TO_MIN = 7 * 60; // 00:00–07:00 UTC
const LONDON_FROM_MIN = 7 * 60;
const LONDON_TO_MIN = 12 * 60; // 07:00–12:00 UTC
const OVERLAP_FROM_MIN = 12 * 60;
const OVERLAP_TO_MIN = 16 * 60; // 12:00–16:00 UTC (London afternoon + NY morning)
const NY_FROM_MIN = 16 * 60;
const NY_TO_MIN = 21 * 60; // 16:00–21:00 UTC
// 21:00–24:00 UTC → OFF_HOURS (thin book, daily maintenance break territory)

/** Default killzones (ICT conventions, widened half-DST tolerance). */
export const DEFAULT_LONDON_KZ = { from: 7 * 60, to: 10 * 60 }; // 07:00–10:00 UTC
export const DEFAULT_NY_KZ = { from: 12 * 60, to: 15 * 60 }; // 12:00–15:00 UTC

/**
 * Default approximate news envelopes for XAUUSD (UTC minutes). Both DST
 * variants of the recurring high-impact slots are covered by one widened
 * envelope each — this is a deliberate, documented approximation.
 */
export const DEFAULT_NEWS_WINDOWS: ReadonlyArray<{ fromUtcMin: number; toUtcMin: number; label: string }> = [
  // US data cluster: 08:30 ET releases (NFP/CPI/PPI/retail) = 12:30 UTC (EST)
  // or 13:30 UTC (EDT) → one envelope covering both.
  { fromUtcMin: 12 * 60 + 25, toUtcMin: 13 * 60 + 45, label: 'US data cluster (12:30/13:30 UTC envelope)' },
  // US conference cluster: 10:00 ET = 15:00/16:00 UTC (ISM, home sales, Fed speeches).
  { fromUtcMin: 14 * 60 + 55, toUtcMin: 16 * 60 + 15, label: 'US conference cluster (15:00/16:00 UTC envelope)' },
];

export const DEFAULT_NEWS_BUFFER_MIN = 5;

/** Materialized default config (config.ts injects env overrides). */
export function defaultSmcSessionConfig(): SmcSessionConfig {
  return {
    londonKzFromMin: DEFAULT_LONDON_KZ.from,
    londonKzToMin: DEFAULT_LONDON_KZ.to,
    nyKzFromMin: DEFAULT_NY_KZ.from,
    nyKzToMin: DEFAULT_NY_KZ.to,
    newsWindows: DEFAULT_NEWS_WINDOWS,
    newsBufferMin: DEFAULT_NEWS_BUFFER_MIN,
  };
}

function minutesOfDayUtc(nowUtcSec: number): number {
  const ms = nowUtcSec * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function weekdayUtc(nowUtcSec: number): number {
  return new Date(nowUtcSec * 1000).getUTCDay();
}

function classifySession(min: number, weekday: number): { active: TradingSession; noteEn: string } {
  // Saturday is always off; Sunday before ~01:00 UTC is off (reopen envelope).
  if (weekday === 6) {
    return { active: 'OFF_HOURS', noteEn: 'Saturday — market weekend (approximate envelope).' };
  }
  if (weekday === 0 && min < 60) {
    return { active: 'OFF_HOURS', noteEn: 'Sunday early UTC — reopen may lag (approximate envelope).' };
  }
  if (min >= ASIA_FROM_MIN && min < ASIA_TO_MIN) {
    return { active: 'ASIA', noteEn: 'Asia session (00:00–07:00 UTC envelope).' };
  }
  if (min >= LONDON_FROM_MIN && min < LONDON_TO_MIN) {
    return { active: 'LONDON', noteEn: 'London session (07:00–12:00 UTC envelope).' };
  }
  if (min >= OVERLAP_FROM_MIN && min < OVERLAP_TO_MIN) {
    return { active: 'OVERLAP_LDN_NY', noteEn: 'London/New York overlap (12:00–16:00 UTC envelope).' };
  }
  if (min >= NY_FROM_MIN && min < NY_TO_MIN) {
    return { active: 'NEW_YORK', noteEn: 'New York session (16:00–21:00 UTC envelope).' };
  }
  return { active: 'OFF_HOURS', noteEn: 'Off hours (21:00–24:00 UTC envelope / thin book).' };
}

function killzoneAt(min: number, cfg: SmcSessionConfig): { inKillzone: boolean; killzone: KillzoneName | null } {
  if (min >= cfg.londonKzFromMin && min < cfg.londonKzToMin) {
    return { inKillzone: true, killzone: 'LONDON_KZ' };
  }
  if (min >= cfg.nyKzFromMin && min < cfg.nyKzToMin) {
    return { inKillzone: true, killzone: 'NY_KZ' };
  }
  return { inKillzone: false, killzone: null };
}

function newsWindowAt(
  min: number,
  cfg: SmcSessionConfig,
): { newsBlackout: boolean; activeNewsWindow: SmcSessionConfig['newsWindows'][number] | null } {
  for (const w of cfg.newsWindows) {
    const from = w.fromUtcMin - cfg.newsBufferMin;
    const to = w.toUtcMin + cfg.newsBufferMin;
    if (min >= from && min < to) {
      return { newsBlackout: true, activeNewsWindow: w };
    }
  }
  return { newsBlackout: false, activeNewsWindow: null };
}

/**
 * The A7 Session/News agent read. Deterministic: the same (nowUtcSec, cfg)
 * always yields the same state. Weekend → OFF_HOURS, no killzone; the news
 * flag is not raised on Saturday (nothing trades anyway).
 */
export function readSessionState(nowUtcSec: number, cfg: SmcSessionConfig): SessionState {
  const min = minutesOfDayUtc(nowUtcSec);
  const weekday = weekdayUtc(nowUtcSec);
  const session = classifySession(min, weekday);
  const weekend = weekday === 6 || (weekday === 0 && min < 60);

  const kz = weekend ? { inKillzone: false, killzone: null } : killzoneAt(min, cfg);
  const news = weekend ? { newsBlackout: false, activeNewsWindow: null } : newsWindowAt(min, cfg);

  const parts: string[] = [session.noteEn];
  if (kz.inKillzone && kz.killzone) {
    parts.push(kz.killzone === 'LONDON_KZ' ? 'Inside London killzone.' : 'Inside New York killzone.');
  }
  if (news.newsBlackout && news.activeNewsWindow) {
    parts.push(`News blackout: ${news.activeNewsWindow.label} (approximate envelope).`);
  }

  return {
    nowUtcSec,
    active: session.active,
    inKillzone: kz.inKillzone,
    killzone: kz.killzone,
    newsBlackout: news.newsBlackout,
    activeNewsWindow: news.activeNewsWindow,
    weekday,
    noteEn: parts.join(' '),
  };
}

/**
 * Session H/L boundaries for a given instant — used by the Key Levels agent
 * to place Asia/London/NY session high/low levels. Deterministic day-key
 * math on UTC dates.
 */
export interface SessionBoundary {
  session: 'ASIA' | 'LONDON' | 'NEW_YORK';
  fromUtcSec: number;
  toUtcSec: number;
}

/** UTC day start (sec) of the instant's date. */
export function utcDayStartSec(nowUtcSec: number): number {
  const dayStart = new Date(nowUtcSec * 1000);
  dayStart.setUTCHours(0, 0, 0, 0);
  return Math.floor(dayStart.getTime() / 1000);
}

/** Today's session boundaries (UTC sec), computed from the day key. */
export function sessionBoundariesFor(nowUtcSec: number): SessionBoundary[] {
  const dayStart = utcDayStartSec(nowUtcSec);
  return [
    { session: 'ASIA', fromUtcSec: dayStart + ASIA_FROM_MIN * 60, toUtcSec: dayStart + ASIA_TO_MIN * 60 },
    { session: 'LONDON', fromUtcSec: dayStart + LONDON_FROM_MIN * 60, toUtcSec: dayStart + LONDON_TO_MIN * 60 },
    { session: 'NEW_YORK', fromUtcSec: dayStart + OVERLAP_FROM_MIN * 60, toUtcSec: dayStart + NY_TO_MIN * 60 },
  ];
}

/** Previous UTC day start (sec) — PDH/PDL anchor for the Key Levels agent. */
export function previousUtcDayStartSec(nowUtcSec: number): number {
  return utcDayStartSec(nowUtcSec) - 86_400;
}
