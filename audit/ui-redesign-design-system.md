# UI Redesign — Design System (Task 39 / UI-03 "Sky Terminal")

## 1. Visual identity

Four requested themes, all token-driven (no hex in components):

| Theme | Tokens | Values (dark / light) |
|---|---|---|
| Sky blue (primary) | `--primary`, `--brand`, `--ring` | `#38BDF8`·`#7DD3FC` / `#0284C7`·`#0369A1` |
| Sunlight (accent) | `--sun`, `--on-sun` | `#FBBF24`·`#231303` / `#B45309`·`#FFFBEB` |
| Dark (terminal) | `--terminal`, `--panel`, `--surface` | `#0B1220`·`#111C2E`·`#162338` / `#F4F8FC`·`#FFFFFF`·`#FFFFFF` |
| White (light) | `--background`, `--card`, `--popover` | dark values / `#F4F8FC`·`#FFFFFF`·`#FFFFFF` |

Status colors (always paired with label/icon, never color alone):

| Meaning | Utility | Dark / Light |
|---|---|---|
| Bullish / success | `text-up`, `bg-up/10`, `border-up/40` | `#34D399` / `#047857` |
| Bearish / error | `text-down`, `bg-down/10`, `border-down/40` | `#F87171` / `#DC2626` |
| Degraded / warn | `text-warn`, `bg-warn/10`, `border-warn/40` | `#FB923C` / `#C2410C` |
| Highlight / XAUUSD | `text-sun`, `bg-sun/10`, `border-sun/40` | `#FBBF24` / `#B45309` |

## 2. Token utility cheat-sheet (Tailwind classes)

- Surfaces: `bg-terminal` (page), `bg-panel` (sidebar/major panels), `bg-surface` (cards/chips), `bg-muted` (subtle inset fields/badges)
- Text: `text-foreground` (primary), `text-content` (secondary), `text-muted-foreground` (tertiary/labels)
- Borders: `border-border` (default), `border-border-strong` (emphasis)
- Brand: `text-brand`, `bg-brand/10`, `border-brand/40`; solid buttons use `bg-primary text-primary-foreground` (shadcn Button default)
- **NEVER** write raw `zinc-*`, `amber-*`, `emerald-*`, `red-*`, `orange-*` in terminal components — use the tokens above so light/dark both work.

## 3. Layered surface model

```
bg-terminal  (page, #0B1220)
└─ bg-panel  (sidebar, chart panel, hero, footer #111C2E)
   └─ bg-surface (cards, chips, active toggles #162338)
      └─ bg-muted (inset fields, subtle badges #17253C)
```

Light mode: terminal `#F4F8FC` → panel/surface `#FFFFFF` (separated by `border-border #DCE5F0` + `shadow-sm`) → muted `#E9F1F9`.

## 4. Typography

- Bengali UI: Hind Siliguri (300–700) — wired via `--font-sans` (Task 39 fix; previously dangling `--font-geist-sans`).
- Numerals/code: JetBrains Mono via `--font-mono`; `tabular-nums` enforced globally for `.font-mono`/`.tabular-nums`.
- Scale: page/hero price 24–30px semibold mono; section title 15–16px semibold; card title 13–14px semibold; body 13–14px; labels 11–12px; micro metadata 10–11px (never below 10px).

## 5. Spacing / radius / elevation

- 4px scale; card padding `p-4`; card grid gap `gap-4`; sections `space-y-4`; outer page `px-6 py-4` desktop / `px-3` mobile.
- Radius: `--radius: 0.75rem` → cards `rounded-xl` (12px), controls `rounded-lg` (8–10px), chips `rounded-md`/`rounded-full`.
- Shadows: `shadow-sm` on light-mode cards only; dark mode relies on border separation.
- One decorative gradient allowed: hero strip `bg-gradient-to-r from-primary/10 via-transparent to-transparent`.

## 6. App shell

- **Header** (sticky `top-0 z-40`, `--header-height: 89px` at lg+): brand + quote strip + LIVE/STALE + execution badge + Dhaka clock + search launcher + theme toggle + chat.
- **Sidebar** (desktop lg+, `w-60` ⇄ `w-[68px]`, `bg-panel`, sticky under header): groups ট্রেডিং (ড্যাশবোর্ড/সিগন্যাল ইতিহাস/বিশ্লেষণ) + সিস্টেম (সিস্টেম/সেটিংস); active = `text-brand bg-brand/10` + left bar; collapsed → tooltips; state in `localStorage`.
- **Mobile** (<lg): bottom nav (6 items) with `text-brand` active state; one view at a time; `pb-28` clears the fixed nav; safe-area aware.
- **Footer**: `mt-auto` sticky-bottom via flex column root; `bg-panel border-t border-border`.
- **Command palette**: Ctrl/⌘K Dialog + cmdk — navigation group + actions group (existing handlers only).

## 7. Component conventions

- Cards: `rounded-xl border border-border bg-panel` (or `bg-surface` inside panels); header rows `flex items-center justify-between px-3 py-2 border-b border-border`.
- Section headings: 11px uppercase tracking-wider `text-muted-foreground` (sidebar groups) or 15px semibold `text-foreground` (card titles).
- Status badges: `rounded-md border px-2 py-0.5 text-[11px] font-medium` + status token colors + icon.
- Buttons: shadcn defaults; primary CTA = default variant (sky); icon buttons `h-8 w-8 p-0`.
- Loading: `Skeleton` blocks (never permanent spinners); empty states: icon + honest Bengali message + optional hint; errors: `border-down/40 bg-down/10 text-down` + retry where available.
- Long lists: `max-h-96 overflow-y-auto custom-scrollbar`.
- Focus: `focus-visible:ring-2 focus-visible:ring-ring` on all interactive elements; min touch target 44px mobile (bottom-nav buttons `min-h-[56px]`).

## 8. Theme behavior

- Dark is the PRIMARY terminal theme (`defaultTheme="dark"` via next-themes, SSR class `dark` on `<html>`, no flash).
- Light mode fully designed via the same tokens — every component must render correctly in both.
- Chart chrome (lightweight-charts) reads CSS vars at creation and re-applies on theme flip (`chartChrome()` in ChartPanel). Candles/EMA are constant data-encoding colors.
- Toggle lives in header + command palette; persisted by next-themes (localStorage `theme`).

## 9. Z-index scale

`z-40` sticky header · `z-50` mobile bottom-nav + shadcn overlays (sheet/dialog/popover/dropdown) · `z-60` command palette (Dialog default). No ad-hoc z values.

## 10. Accessibility

- Semantic `header/main/nav/aside/footer/section`; `aria-current` on active nav; `aria-label` Bengali on icon-only controls; `aria-pressed` on toggle chips; sr-only descriptions on icon Sheets.
- `prefers-reduced-motion` disables `animate-pulse`/`animate-ping` (globals).
- Status never color-only: icon + Bengali label everywhere.
