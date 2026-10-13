# Core Roulette

A personal web app (PWA) that generates a randomized 10-minute core workout and runs it: countdown timer, work/rest intervals, big on-screen current move, next-up preview, and simple beep callouts. Built to replace a Peloton subscription that was used almost exclusively for 10-minute core classes.

## Goals

- Variety: every session is a different mix of moves, so nobody has to plan it.
- Stay on track: clear countdowns and transitions without needing an instructor voice.
- Plays nicely with Spotify running in the background on iPhone.
- No backend, no accounts, no subscription. Free hosting.

## Non-goals (v1)

- Instructor-style voice coaching or motivational callouts
- Spotify integration (the user just runs Spotify alongside the app)
- Video or animation for each exercise (text name and short form cue only)
- Cross-device sync or user accounts

## Status

M0 (iPhone spike) is complete, so we're staying on the web/PWA path. The logic layer is done and tested: library (41 moves), generator, re-roll, timer engine and settings. The settings screen (Quick Start and Advanced) and a bare workout preview are built; the runner, audio, install and offline support come next. See this repo's GitHub Issues for milestones and `CLAUDE.md` for project context and decisions.

## Running locally

No build step and no dependencies. Serve the folder over HTTP (the app loads `exercises.json` with `fetch`, so opening the file directly won't work):

```
python3 -m http.server 8000     # then open http://localhost:8000
node --test                     # run the tests
```

Audio, wake lock and home-screen install must be tested on a real iPhone over HTTPS (Vercel preview URLs work). The original M0 spike page is kept at `/spike.html`.

## Repo layout

```
/
  index.html         the app
  spike.html         M0 audio / wake-lock spike (kept for reference)
  README.md
  CLAUDE.md          project brief and decisions for Claude Code
  exercises.json     exercise library (data, no logic)
  src/
    generator.js     pure functions: build a workout from the library
    reroll.js        pure function: replace one move in a workout
    timer.js         timestamp-based interval engine
    settings.js      pure functions: settings screen state -> generator options
    ui/              thin presentation layer (screens, storage, styles)
  test/              node --test, Logic layer only (plus exercises.json validation)
```
