# Backlog

Milestones in order. Each `###` heading under a milestone is one issue (title = heading, body = the text below it). A script will later turn these into GitHub issues, so keep that structure.

Labels: `spike`, `feature`, `content`, `polish`, `native-later`.

---

## M0: iPhone spike (decides web vs native)

### Deploy a bare test page to Vercel
`spike`

Repo connected to Vercel; a minimal `index.html` served over HTTPS and openable on the iPhone.

**Acceptance:** URL opens on the iPhone; page can be added to the home screen.

### Beep test with Spotify playing
`spike`

Button that plays a short beep via Web Audio API with `navigator.audioSession.type = "ambient"` set.

**Acceptance:** With Spotify playing on the iPhone, the beep is audible and Spotify keeps playing (no pause, or at most a brief duck). Record result in CLAUDE.md decisions log, for both Safari tab and home-screen mode.

### Speech test with Spotify playing
`spike`

Button that speaks "Next up: bicycle crunches" via `speechSynthesis`.

**Acceptance:** Record whether it pauses, ducks, or mixes with Spotify. If it interrupts, mark spoken announcements as out of v1 and use on-screen text plus a distinct tone.

### Wake lock test
`spike`

Toggle that requests a Screen Wake Lock and shows its status; re-acquires on visibility change.

**Acceptance:** Screen stays on for 12+ minutes in home-screen mode with the phone untouched. Record result.

### Spike verdict
`spike`

Write the outcome into the decisions log: stay on web, or plan Capacitor (and which features drive that).

**Acceptance:** Decision recorded; M1 unblocked.

---

## M1: Exercise library and generator

### Define exercise schema and starter library
`content`

Finalize schema in `CLAUDE.md`; grow `exercises.json` from the starter set to 40-60 moves with form cues.

### Workout generator (pure functions)
`feature`

`generateWorkout(library, options)` applying the generator rules in CLAUDE.md. Unit tests for no back-to-back focus, no repeats, correct total duration, perSide handling.

### Re-roll (whole workout and single slot)
`feature`

---

## M2: Workout runner

### Timestamp-based interval engine
`feature`

Pure timer engine producing current slot, phase (work/rest/side-swap), and time remaining from timestamps. Survives page throttling.

### Runner screen
`feature`

Large current exercise name, big countdown, next-up preview, form cue, work/rest color change, pause/resume/skip.

### Audio callouts
`feature`

3-2-1 beeps, transition tones, optional "Next up" announcement per spike verdict, mute toggle.

---

## M3: PWA polish

### Home-screen install and offline
`polish`

Manifest, icons, service worker so it launches and runs with no connection.

### Wake lock and audio hardening
`polish`

Handle backgrounding, interruptions (calls), and re-acquire behavior based on spike findings.

---

## M4: Feature list (to be filled in)

_Nick's feature list goes here, triaged into v1 / later / native-dependent._

---

## Later

### Capacitor wrapper
`native-later`

Native audio session control, haptics, keep-awake. Only if M0 or real use shows the web version falls short.

### Apple Health logging and Watch haptics
`native-later`
