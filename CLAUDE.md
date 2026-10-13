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
- Position filter (`back`, `face-down`, `other`) and focus filter (including `obliques`): mode `any` or `none` ('all' dropped for v1). No selection means no filtering.
- Circuits: a group of exercises repeated for N rounds, shown on the preview screen as a bracket with a rounds badge (#20).

Rules:

- `perSide` exercises run once per side, back to back: two consecutive full-length slots (`left`, then `right`) with no rest between the sides and the normal rest after the pair.
- The last slot has no rest after it and absorbs any leftover time, so the total is exact (it can run noticeably longer than the work length).
- Unset time values are randomized in tunable ranges (total 8-12 min, work 30-50s, rest 10-30s); a circuit is 2-5 moves x 2-4 rounds, one per workout. See `src/generator.js`.
- No repeat of the same `focus` back-to-back; mix `pattern` (static / dynamic / rotational); respect difficulty setting.
- No exercise repeated within one workout, except circuit rounds.
- "Re-roll" happens on the preview screen before the workout starts. Whole workout: the Shell keeps the user's original options and calls `generateWorkout` again (unset values re-randomize). Single move: `rerollSlot` in `src/reroll.js` (see the decisions log).
- Run-time: `src/timer.js` turns a workout into a plan and, given `nowMs`, a view plus the events to sound. A 5-second "get ready" lead-in comes first and is not part of the total. No skip in v1. The Shell auto-pauses when the page is hidden (`visibilitychange`). Beeps: 3-2-1 before each phase ends; "Next up" and side-swap cues are events the Shell may speak or only show.

## Exercise schema (`exercises.json`)

```
id            string, unique, kebab-case
name          display name
focus         array: "upper-abs" | "lower-abs" | "obliques" | "deep-core" | "full"
position      "back" | "face-down" | "other" (other = side, seated, all-fours, standing)
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

Node's built-in test runner (`node --test`, no Jest/Vitest — don't add one), tests in `test/`, one file per source module. Tests target the pure Logic layer only (`generator.js`, `reroll.js`, `timer.js`) — not the Shell layer (audio, DOM, wake lock), which can't be meaningfully unit tested. One deliberate exception: `test/exercises.test.js` validates `exercises.json` (unique ids, valid enum values) to catch typos as the library grows. Use the `test-runner` subagent to write tests for new features or check suite status before a push.

## Working agreements

- Milestone order matters. **M0 (iPhone audio/wake-lock spike) comes first** because its result decides whether we stay on web or move to Capacitor.
- Keep PRs and commits small and tied to a backlog issue.
- Don't add dependencies without a reason; this app is small.
- Test audio and wake lock on a real iPhone over the deployed URL. Desktop results don't count.
- When a decision changes, update this file in the same commit.

## Decisions log

- 2026-10-12: M0 spike passed. Nick tested the deployed page on his iPhone and everything works (#1-#4). Verdict (#5): stay on the web/PWA path; Capacitor (#15) stays in `later`. M1+ is unblocked.
- 2026-10-12: Workout is user-configurable instead of fixed 10:00 / 40s / 20s: total time, work and rest sliders, warm-up, position and focus filters, circuits. Unset inputs are randomized. Position is a new tag alongside focus (obliques stays a focus value). Warm-up moves come from the library via a `warmup` flag. Saved workouts need a backend and are parked for V2 (#21). Issues #18-#21.
- 2026-10-12: Schema finalized in #6. `position` is `back` | `face-down` | `other` (every move has one; `other` covers side, seated, all-fours and standing moves). `warmup` is `eligible` | `only` | omitted. Starter library is 16 moves; the full library is authored in #18. Added `test/exercises.test.js` as a data-validation exception to the logic-only testing rule.
- 2026-10-13: Generator (#7) built test-first in `src/generator.js`. Decisions: circuits are a group of 2-5 moves x 2-4 rounds, one per workout; unset time values are random within ranges; filter modes are `any`/`none` only; the last move absorbs leftover time; two-sided moves get the full work time on each side, back to back (supersedes the earlier half-slot idea); warm-up is 2 easy moves from the `warmup` flag, ignoring position/focus filters; too few matching moves means repeats (never back-to-back) plus a warning, relaxing pattern mixing, then back-to-back focus, then no-repeats. The generator accepts `maxDifficulty`; no UI control yet.
- 2026-10-13: Product direction: eventually two paths, a "Quick Start" (user picks time and difficulty, everything else random) and an "Advanced" editor (full settings). Both call the same `generateWorkout` with different options.
- 2026-10-13: Re-roll (#8) built test-first. `rerollSlot(library, workout, slotIndex, rng)` returns `{ workout, changed, reason }`. It replaces a whole move (both sides of a two-sided move, every round of a circuit move) with one that is main-pool (or warm-up-pool) eligible and not already in the workout, rebuilding from base work times so the total stays exact; a swap is allowed only if the leftover stays non-negative and changes by at most one work interval (so circuit swaps are effectively same-cost). It prefers replacements that keep neighbors' focus/pattern rules; if none exist it loosens those (fewest violations) and adds a warning; if nothing fits it returns the same workout with `changed: false, reason: "no-alternative"`. Warm-up moves can be re-rolled in the logic; whether the UI offers it is a UI decision (#20). Slot indices are not stable across a re-roll, so the UI re-renders from the returned workout. Shared helpers (`buildTimeline`, `mainPool`, `warmupPool`) now live in `src/generator.js`. Known gap filed as #25.
- 2026-10-13: Timer engine (#9) built test-first in `src/timer.js`. `buildPlan(workout, {leadInSec=5})` precomputes segments (ready / work / rest) and a sorted event list; `start`, `pause`, `resume` and `tick(plan, state, nowMs)` are pure, with opaque integer-millisecond state (anchor + base, so elapsed is always `nowMs` minus a stored time, never a tick count). `tick` returns `{ state, view, events }`; events are reported exactly once via a cursor, so a throttled page gets every missed event on its next tick and the Shell decides which are still worth sounding. Event types: `ready`, `work-start`, `side-swap`, `rest-start`, `countdown` (3, 2, 1), `done`. The view carries phase, slot, side, ceil'd phase and total remaining, and `next` (with `nextIsSideSwap`) for "Next up". Decisions: 5s lead-in, no skip in v1, auto-pause when hidden (Shell work in #10/#13). Verified: identical event lists at tick cadences from 16 ms to 10,000 s and across pause/resume (1,800 seeded runs).
- 2026-10-13: Library grown from 16 to 35 moves (#18, first batch; the issue stays open for more). Authored in a spreadsheet (one row per move, dropdowns for the enums, an `x` per focus, Include? Y/N) and converted to `exercises.json`, so the JSON stays the source of truth and the sheet is an editing tool. Nick's edits: bicycle-crunch is difficulty 2; russian-twist is `back`; bird-dog and cat-cow are `face-down`; he dropped three of the suggested moves and added windshield-wiper, cross-body-crunch, single-leg-bicycle, sit-up and plank-walk. Main pool is 29 moves, warm-up pool 10 (6 warm-up only). Form cues for sit-up, plank-walk and the three added rotational moves were tidied by Claude. `test/reroll.test.js` no longer asserts that a no-op re-roll occurs in the real library, because that depended on the library being small (no-alternative is covered with synthetic libraries). Idea parked in #28: rate every move 1-10.
- (add further dated entries here as decisions are made)
