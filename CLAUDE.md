# Core Roulette: project brief

Read this first. It is the source of truth for what we're building and why.

## What this is

A personal PWA that builds and runs randomized 10-minute core workouts. One user (Nick), one device that matters (iPhone, phone propped on the floor, screen on, Spotify playing in the background).

## What the user liked about Peloton (and what we keep)

1. Variety designed by someone else: the app picks the workout, the user just shows up.
2. Callouts that keep him on track: reduced here to simple countdown beeps and an optional "Next up" announcement. No instructor voice, no motivational copy, no per-exercise cue library.

## Hard constraints

- **iPhone Safari / home-screen PWA is the primary target.** Must work on iOS 16.4+.
- **Must coexist with Spotify.** Use `navigator.audioSession.type = "ambient"` where supported so beeps layer over Spotify instead of pausing it. Use Web Audio API for beeps. Speech synthesis is the riskiest piece on iOS audio mixing; treat spoken announcements as optional and always provide an on-screen fallback.
- **Screen must stay on.** Use the Screen Wake Lock API, re-acquire on `visibilitychange`, and handle failure gracefully (iOS has had bugs here).
- **Timer must be timestamp-based**, not tick-counting. Store a start time and compute remaining time from `performance.now()` / `Date.now()` so it stays accurate if iOS throttles the page.
- **No reliance on audio alone.** Big on-screen countdown, color change at work/rest transitions. No vibration (iOS Safari doesn't support it).
- **No backend for v1.** Settings and history, if any, live in `localStorage`, wrapped in try/catch.

## Architecture rule (so a native wrapper later is cheap)

Keep three layers cleanly separated:

1. **Data:** `exercises.json`. No logic.
2. **Logic:** pure functions (`generator`, `timer` engine). No DOM, no audio. Unit-testable.
3. **Shell:** UI, audio, wake lock. Thin. This is the only layer that changes if we later wrap with Capacitor for native audio session, haptics, and keep-awake.

## Stack decisions

- Static PWA, plain JS modules (or a very light framework if the feature list demands it; decide at start of M1).
- Hosting: Vercel (free). HTTPS preview URLs are used for iPhone testing.
- No database. No API keys.

## Generator settings and defaults (tentative, tune after real use)

User-set inputs (settings screen, #19). Any input the user leaves unset is randomized ("true roulette"):

- Total workout time (default 10:00).
- Work length per exercise and rest length, each a slider (defaults 40s work / 20s rest).
- Warm-up on/off, and whether it counts inside the total time. Warm-up moves come from exercises flagged `warmup`.
- Position filter (`back`, `face-down`) and focus filter (including `obliques`): any, all, or none.
- Circuits: a group of exercises repeated for N rounds, shown on the preview screen as a bracket with a rounds badge (#20).

Rules:

- `perSide` exercises count as two half-slots (swap sides mid-slot with a clear on-screen/beep cue).
- No repeat of the same `focus` back-to-back; mix `pattern` (static / dynamic / rotational); respect difficulty setting.
- No exercise repeated within one workout, except circuit rounds.
- "Re-roll" replaces the whole workout or a single slot, on the preview screen before the workout starts.

## Exercise schema (`exercises.json`)

```
id            string, unique, kebab-case
name          display name
focus         array: "upper-abs" | "lower-abs" | "obliques" | "deep-core" | "full"
position      "back" | "face-down" (exercises fitting neither: tagging rule TBD in #18)
warmup        "eligible" | "only" | omitted. "only" moves are excluded from the main pool
pattern       "static" | "dynamic" | "rotational"
difficulty    1 | 2 | 3
perSide       boolean
workSeconds   optional override of default work interval
formCue       one short on-screen line (not spoken), e.g. "Ribs down, low back flat"
```

## Backlog

Open ideas and planned work live in this repo's **GitHub Issues**, not a local file. Labels:

- Milestone (exactly one per issue): `m0`, `m1`, `m2`, `m3`, `m4`. Milestone order matters — `m0` (the iPhone spike) gates everything else per the working agreement below.
- `later`: worth keeping, not scheduled into a milestone yet.
- Type (combine with milestone): `spike`, `feature`, `content`, `polish`, `native-later`.

Use the `backlog-manager` subagent to triage, add ideas, or check what's next — or just run `gh issue list`.

## Starting work on a feature

Before implementing an issue, use the `feature-scoper` subagent to have a short scoping conversation first — part UX lead, part technical architect. It reads the issue and relevant code, surfaces real decision points against this project's hard constraints (iPhone Safari, Spotify coexistence, wake lock, timestamp-based timer), asks a few targeted questions, and records the agreed scope as a comment on the issue. It doesn't write code — that's a separate step once scope is confirmed. Skip it only for genuinely trivial, unambiguous changes.

## Testing

Node's built-in test runner (`node --test`, no Jest/Vitest — don't add one), tests in `test/`, one file per source module. Tests target the pure Logic layer only (`generator.js`, `timer.js`) — not the Shell layer (audio, DOM, wake lock), which can't be meaningfully unit tested. Use the `test-runner` subagent to write tests for new features or check suite status before a push.

## Working agreements

- Milestone order matters. **M0 (iPhone audio/wake-lock spike) comes first** because its result decides whether we stay on web or move to Capacitor.
- Keep PRs and commits small and tied to a backlog issue.
- Don't add dependencies without a reason; this app is small.
- Test audio and wake lock on a real iPhone over the deployed URL. Desktop results don't count.
- When a decision changes, update this file in the same commit.

## Decisions log

- 2026-10-12: M0 spike passed. Nick tested the deployed page on his iPhone and everything works (#1-#4). Verdict (#5): stay on the web/PWA path; Capacitor (#15) stays in `later`. M1+ is unblocked.
- 2026-10-12: Workout is user-configurable instead of fixed 10:00 / 40s / 20s: total time, work and rest sliders, warm-up, position and focus filters, circuits. Unset inputs are randomized. Position is a new tag alongside focus (obliques stays a focus value). Warm-up moves come from the library via a `warmup` flag. Saved workouts need a backend and are parked for V2 (#21). Issues #18-#21.
- (add further dated entries here as decisions are made)
