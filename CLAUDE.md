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
2. **Logic:** pure functions (`generator`, `reroll`, `timer` engine, `settings`, `preview`, `runner`, `cues`). No DOM, no audio. Unit-testable.
3. **Shell:** UI, audio, wake lock. Thin. This is the only layer that changes if we later wrap with Capacitor for native audio session, haptics, and keep-awake.

## Stack decisions

- Static PWA, plain JS modules, no build step (decided 2026-10-13). `index.html` is the app, `src/ui/` is the Shell, and the M0 spike page lives on at `/spike.html`. `exercises.json` is loaded with `fetch` (iOS 16.4 has no JSON import attributes). System fonts only, so nothing downloads and the app works offline.
- Hosting: Vercel (free). HTTPS preview URLs are used for iPhone testing.
- No database. No API keys.

## Generator settings and defaults (tentative, tune after real use)

The settings screen (#19) has two modes. **Quick Start** (the default): total time, Easy / Medium / Hard (max difficulty 1 / 2 / 3, so Hard is "up to hard"), warm-up on/off (counted in the total); work, rest and circuit are left unset so they re-randomize on every generate and re-roll. **Advanced** has a Randomize button at the top that fills every control with random visible values (filters cleared), plus the inputs below. Any input left unset is randomized ("true roulette"):

- Total workout time (default 10:00).
- Work length per exercise and rest length, each a slider (defaults 40s work / 10s rest; rest is capped at 10s, see the decisions log).
- Warm-up on/off, and whether it counts inside the total time. Warm-up moves come from exercises flagged `warmup`.
- Position filter (`back`, `face-down`, `side`, `standing`) and focus filter (including `obliques`): mode `any` or `none` ('all' dropped for v1). No selection means no filtering.
- Circuits: a group of exercises repeated for N rounds, shown on the preview screen as a bracket with a rounds badge (#20).

Rules:

- `perSide` exercises in the main set and circuits run once per side, back to back: two consecutive full-length slots (`left`, then `right`) with no rest between the sides and the normal rest after the pair. In the warm-up a `perSide` exercise is a single slot, one work interval long, with `side: "alternate"`: the user alternates sides inside the window, with no per-side cues.
- The last slot has no rest after it and absorbs any leftover time, so the total is exact (it can run noticeably longer than the work length).
- Unset time values are randomized in tunable ranges (total 8-12 min, work 30-50s, rest 5-10s); a circuit is 2-5 moves x 2-4 rounds, one per workout. See `src/generator.js`.
- No repeat of the same `focus` back-to-back; mix `pattern` (static / dynamic / rotational); respect difficulty setting.
- No exercise repeated within one workout, except circuit rounds.
- "Re-roll" happens on the preview screen before the workout starts. Whole workout: the Shell keeps the user's original options and calls `generateWorkout` again (unset values re-randomize). Single move: `rerollSlot` in `src/reroll.js` exists in the logic layer, but the preview offers no per-move re-roll (parked, see the decisions log).
- Run-time: `src/timer.js` turns a workout into a plan and, given `nowMs`, a view plus the events to sound. A 5-second "get ready" lead-in comes first and is not part of the total. No skip in v1. The Shell auto-pauses when the page is hidden (`visibilitychange`). Beeps (#11, see the decisions log): two quick beeps 10 s before a work interval ends, short beeps at 3 and 2, a long beep at 1; rest and get-ready get only the long beep at 1; a four-note rising finish jingle plays when the workout ends. Nothing is spoken in v1; "Next up" and side-swap cues are shown on screen.

## Exercise schema (`exercises.json`)

```
id            string, unique, kebab-case
name          display name
focus         array: "upper-abs" | "lower-abs" | "obliques" | "deep-core" | "full"
position      "back" | "face-down" | "side" | "standing" (face-down includes all-fours; side = lying on your side)
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

Node's built-in test runner (`node --test`, no Jest/Vitest — don't add one), tests in `test/`, one file per source module. Tests target the pure Logic layer only (`generator.js`, `reroll.js`, `timer.js`, `settings.js`, `preview.js`, `runner.js`, `cues.js`) — not the Shell layer (audio, DOM, wake lock), which can't be meaningfully unit tested. One deliberate exception: `test/exercises.test.js` validates `exercises.json` (unique ids, valid enum values) to catch typos as the library grows. Use the `test-runner` subagent to write tests for new features or check suite status before a push.

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
- 2026-10-13: Library grown from 16 to 35 moves (#18, first batch; the issue stays open for more). Authored in a spreadsheet (one row per move, dropdowns for the enums, an `x` per focus, Include? Y/N) and converted to `exercises.json`, so the JSON stays the source of truth and the sheet is an editing tool. Nick's edits: bicycle-crunch is difficulty 2; russian-twist is `back`; bird-dog, cat-cow and bear-plank are `face-down`; he dropped three of the suggested moves and added windshield-wiper, cross-body-crunch, single-leg-bicycle, sit-up and plank-walk. Main pool is 29 moves, warm-up pool 10 (6 warm-up only). Form cues for sit-up, plank-walk and the three added rotational moves were tidied by Claude. `test/reroll.test.js` no longer asserts that a no-op re-roll occurs in the real library, because that depended on the library being small (no-alternative is covered with synthetic libraries). Idea parked in #28: rate every move 1-10.
- 2026-10-13: Position `other` removed. `position` is now `back` | `face-down` | `side` | `standing` (#18). All-fours moves are `face-down` (bird-dog, cat-cow, bear-plank, reach-through); side-plank and side-plank-hip-dips are `side`; wood-chop, standing-torso-twist, standing-knee-to-elbow and inchworm are `standing`. This supersedes the 2026-10-12 schema entry's definition of `other`. Main pool by position: back 15, face-down 11, side 2, standing 1, so the side and standing filters need more moves before they are useful (they hit the repeat-with-warning path today).
- 2026-10-13: Six side and standing moves added (#18): side-lying-leg-raise, side-crunch, side-plank-reach-through, side-plank-leg-lift, standing-oblique-crunch, standing-side-bend (warm-up eligible). Nick cut the suggested standing-crunch and standing-windmill. Library is 41 moves: main pool 35 (back 15, face-down 11, side 6, standing 3), warm-up pool 11 (6 warm-up only). Standing is still thin; flipping standing-torso-twist and standing-knee-to-elbow from `only` to `eligible` would add two more. The generator's "too few moves" tests now use a synthetic library, since the real one no longer forces that path for a side-only filter.
- 2026-10-13: Settings screen (#19) built. Two modes, Quick Start and Advanced (see Generator settings). Stack decided: plain JS modules, no build step. New pure `src/settings.js` turns screen state into `generateWorkout` options (Quick Start omits work, rest and circuit; Advanced sends concrete values), implements Randomize, and sanitizes stored settings; 242 tests. Settings persist in `localStorage` (try/catch) under `core-roulette.settings.v1`. Generate opens a bare preview (plain list, whole-workout re-roll that rebuilds options from the settings, never from the resolved options); #20 replaces it. In Advanced the circuit switch sends an explicit circuit whose size and rounds the Shell picks so that size x rounds x (work + rest) is at most 60% of the total (the generator's own limit for circuits it picks); picking blindly got a "circuit was reduced" warning on 59% of workouts. If nothing fits it sends 2 x 2 and the generator may drop it with a warning. Warm-up stays fixed at 2 easy moves. The M0 spike page moved to `/spike.html`. Slider ranges (tentative): total 5:00-20:00 by 1:00, work 20-60 s and rest 5-45 s by 5 s.
- 2026-10-13: Warm-up two-sided moves alternate sides inside one window (Nick's request, after a preview showed a warm-up eating 3:30 of a 10:00 workout because both moves were two-sided). A `perSide` move in the warm-up is now one slot, one work interval, `side: "alternate"`; main-set and circuit moves keep left then right. `costOf(ex, work, rest, section = "main")` takes the section so warm-up cost is one window; `buildTimeline` and `rerollSlot` follow. The timer needed no change: an `alternate` slot starts with a normal `work-start` (no `side-swap`). The preview labels it "alternate sides". Warm-up is still 2 moves, so it is now always 2 slots.
- 2026-10-13: Preview screen (#20) built. New pure `src/preview.js` (`buildPreview`) turns a workout into sections of move rows and rest rows; `preview-view.js` only draws it (605 tests). Decisions: circuits are collapsed (bracket drawn once, round 1's moves, an `x3` badge, footer "Repeats 3 times, ends 6:40"); one row per move with a quiet "Rest 20 s" line after it (kept as rows so the layout survives rest ever becoming optional); a two-sided main move is one row "each side" with one window; a warm-up alternate move reads "alternate sides". When the last move absorbed 10 s or more of leftover time it gets a tag ("runs 1:20", "right side runs 1:20"); if that move is inside a collapsed circuit the circuit footer says so (`finalLong`). **Per-move re-roll is parked** (Nick does not want it; `rerollSlot` stays in the logic layer unused by the UI). Nick would rather have a future "build custom workout" feature (#37). Start is a full-width disabled button with a "Runner comes next" hint until #10; the bottom bar is Start, hint, then Settings and Re-roll.
- 2026-10-13: Rest is capped at 10 s across the app (Nick). Random rest is 5 or 10 s (`RANGES.restSeconds` in the generator), the Advanced rest slider is 5-10 s (`LIMITS.restSeconds` in settings; stored larger values clamp to 10), and the Advanced default is 10 s. This supersedes the 5-45 s slider range and the 10-30 s random range above, and covers #36. `generateWorkout` still accepts any explicit `restSeconds`; the cap lives in the ranges and the settings limits. 610 tests.
- 2026-10-13: Runner (#10) built. New pure `src/runner.js` (`describeRunner`) maps a timer view to the labels on screen (phase label, title, side, section, form cue, up next, progress); `src/ui/runner-view.js` returns `{ el, destroy }` and drives `timer.js` with `setInterval` ~100 ms reading `Date.now()`; `done-view.js` is the end screen (673 tests). Decisions (Nick): the phase countdown takes most of the screen, with a total-workout progress bar and "x:xx left" under it, then the current move and form cue, then a quieter "Up next" row ("Switch to right side" before a side swap, "Last move" at the end). Rest uses the same layout in a new color (work green, rest blue, get-ready slate; the phase is always spelled out). Default taken, veto-able: during get-ready and rest the name area shows the upcoming move and its cue so he can get into position, and the Up next row is hidden. Pause is a big button; the paused screen has Resume and End workout (inline confirm), so ending is only reachable while paused; the runner owns the `visibilitychange` auto-pause. Done screen: total time and move count, "New workout" (regenerates from saved settings, opens the preview) and "Back to settings". Hooks for later (`onEvents`, `onPause`, `onResume`, `onFinish`) are in `runner-view.js`; `main.js` has an empty `runnerHooks` for #11 (audio, needs the Start tap) and #13 (wake lock). Note for #11: add a signed `positionSec` to the timer view so a stale `ready` event can be judged.
- 2026-10-13: Runner layout tweaks (Nick, after first look). The current move name and form cue moved above the countdown; "Up next" and the next move's name share one row; the phase label and section line ("WORK", "REST", "Warm-up", "Circuit, round 2 of 3") are gone from the screen, so work and rest are told apart by color alone (green / blue; screen readers still get the phase from a live region). `describeRunner` still returns `phaseLabel` and `sectionLabel`, now unused by the UI. The Up next row keeps its space (hidden, not removed) during rest so the clock does not jump between phases.
- 2026-10-14: Audio (#11) built. Nick's sound spec: in each work interval, two quick beeps at 10 s to go, a short beep at 3 and at 2, a longer beep at 1; rest to work (and get-ready to the first move) is one long beep at 1 s to go, no 3-2 beeps; nothing sounds on the transition itself. Assumption to confirm on the iPhone: the 10 s heads-up is per work interval, not for the whole workout. There is no rest between the two sides of a move, so the long beep marks the side swap. A short chirp plays on the Start tap (confirms audio is live and exposes a silent ringer switch). No speech in v1, no finish chime, no volume slider. Mute is one persisted `muted` pref (`core-roulette.audio.v1`), with a Sound row in settings and a Sound toggle on the paused screen. Logic: new pure `src/cues.js` (`cuesFor`, `toneFor`, `sanitizeAudioPrefs`; events older than 1.5 s are dropped, at most one sound per tick, long beats double beats short); `src/timer.js` gained a `warning` event (10 s left, work intervals over 10 s only) and a signed `positionSec` on the view. Shell: `src/ui/audio.js` keeps one `AudioContext`, sets `navigator.audioSession.type = "ambient"` (feature-detected), unlocks inside the Start tap, resumes on the Resume tap, and swallows every error. 755 tests. Desktop checks used a fake AudioContext; real audio, Spotify coexistence and the silent switch still need an iPhone test. Speech coexistence with Spotify was never recorded in M0, so it is unproven.
- 2026-10-14: Finish jingle added (Nick's request; supersedes "no finish chime" in the audio entry). The timer's `done` event now maps to a new `finish` sound in `src/cues.js`: a rising C major arpeggio (C5 E5 G5 C6, about 1.2 s, last note rings out via a `decay` flag on the note, played by `audio.js`). `finish` has the highest priority, is subject to the same 1.5 s staleness rule and mute, and never overlaps the last long beep (that one is a full second earlier). 770 tests. Pitches and timing are easy to tune in `TONES`.
- 2026-10-14: Audio confirmed on a real iPhone (Nick, deployed URL). Beeps and the finish jingle sound as specified, they layer over Spotify without pausing it, and the silent switch behaves as expected. The 10 s heads-up per work interval is confirmed as intended. This closes the open iPhone checks in the audio entry above; speech coexistence stays unproven (no speech in v1).
- (add further dated entries here as decisions are made)
