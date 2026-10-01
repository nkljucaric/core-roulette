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

Pre-build. See `BACKLOG.md` for milestones and `CLAUDE.md` for project context and decisions.

## Running locally

Not set up yet. Milestone 0 (the iPhone audio spike) will establish the dev and deploy flow. The app must be reachable over HTTPS (Vercel preview URLs work) to test audio session, wake lock, and home-screen install on an iPhone.

## Repo layout (planned)

```
/
  README.md
  CLAUDE.md          project brief and decisions for Claude Code
  BACKLOG.md         milestones and issues (source for GitHub issues)
  exercises.json     exercise library (data, no logic)
  src/
    generator.js     pure functions: build a workout from the library
    timer.js         timestamp-based interval engine
    audio.js         beeps and optional speech, audio session handling
    ui/              thin presentation layer
```
