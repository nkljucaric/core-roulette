import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STALE_AFTER_SEC,
  DEFAULT_AUDIO_PREFS,
  sanitizeAudioPrefs,
  cuesFor,
  toneFor,
} from "../src/cues.js";
import { buildPlan, start, pause, resume, tick } from "../src/timer.js";
import { generateWorkout } from "../src/generator.js";

// Logic-layer tests for src/cues.js: which single sound (if any) the Shell
// should play for a batch of timer events, how stale events are dropped, the
// audio prefs sanitizer, and the tone recipes. No Web Audio here: toneFor
// returns plain data and the Shell turns it into oscillators.

const library = JSON.parse(readFileSync(new URL("../exercises.json", import.meta.url), "utf8"));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const UNMUTED = { muted: false };
const MUTED = { muted: true };

// Event builders in the timer's event shapes.
const ev = {
  ready: (at = -5) => ({ type: "ready", at, slotIndex: null, nextSlotIndex: 0 }),
  work: (at, slotIndex = 0) => ({ type: "work-start", at, slotIndex, side: null }),
  swap: (at, slotIndex = 1) => ({ type: "side-swap", at, slotIndex, side: "right" }),
  rest: (at, slotIndex = 0) => ({ type: "rest-start", at, slotIndex, nextSlotIndex: slotIndex + 1 }),
  cd: (at, n, phase = "work", slotIndex = 0) => ({ type: "countdown", at, n, phase, slotIndex }),
  warn: (at, slotIndex = 0) => ({ type: "warning", at, n: 10, phase: "work", slotIndex }),
  done: (at, slotIndex = 0) => ({ type: "done", at, slotIndex }),
};

// Shorthand: cuesFor for events judged at `positionSec`, unmuted.
const cues = (events, positionSec) => cuesFor(events, { positionSec, prefs: UNMUTED });

// ===========================================================================
// Constants and prefs
// ===========================================================================

test("STALE_AFTER_SEC is 1.5 seconds", () => {
  assert.equal(STALE_AFTER_SEC, 1.5);
});

test("DEFAULT_AUDIO_PREFS starts unmuted", () => {
  assert.deepEqual(DEFAULT_AUDIO_PREFS, { muted: false });
});

test("sanitizeAudioPrefs: keeps a valid muted true", () => {
  assert.deepEqual(sanitizeAudioPrefs({ muted: true }), { muted: true });
});

test("sanitizeAudioPrefs: keeps a valid muted false", () => {
  assert.deepEqual(sanitizeAudioPrefs({ muted: false }), { muted: false });
});

test("sanitizeAudioPrefs: null, undefined and non-objects fall back to the defaults", () => {
  for (const bad of [null, undefined, "", "muted", '{"muted":true}', 0, 1, NaN, true, false, () => ({ muted: true })]) {
    assert.deepEqual(sanitizeAudioPrefs(bad), { muted: false }, String(bad));
  }
});

test("sanitizeAudioPrefs: arrays fall back to the defaults", () => {
  assert.deepEqual(sanitizeAudioPrefs([]), { muted: false });
  assert.deepEqual(sanitizeAudioPrefs([true]), { muted: false });
  assert.deepEqual(sanitizeAudioPrefs([{ muted: true }]), { muted: false });
});

test("sanitizeAudioPrefs: a missing or non-boolean muted falls back to the default", () => {
  for (const muted of ["true", "yes", 1, 0, null, undefined, {}, [], [true]]) {
    assert.deepEqual(sanitizeAudioPrefs({ muted }), { muted: false }, JSON.stringify(muted));
  }
  assert.deepEqual(sanitizeAudioPrefs({}), { muted: false });
});

test("sanitizeAudioPrefs: extra keys are dropped", () => {
  assert.deepEqual(sanitizeAudioPrefs({ muted: true, volume: 11, theme: "dark" }), { muted: true });
  assert.deepEqual(Object.keys(sanitizeAudioPrefs({ muted: false, x: 1 })), ["muted"]);
});

test("sanitizeAudioPrefs: returns a fresh object each time and never exposes DEFAULT_AUDIO_PREFS", () => {
  const a = sanitizeAudioPrefs(null);
  const b = sanitizeAudioPrefs(null);
  assert.notEqual(a, DEFAULT_AUDIO_PREFS);
  assert.notEqual(a, b);
  a.muted = true;
  assert.deepEqual(DEFAULT_AUDIO_PREFS, { muted: false });
  assert.deepEqual(sanitizeAudioPrefs(null), { muted: false });
});

test("sanitizeAudioPrefs: does not mutate a frozen input", () => {
  const input = deepFreeze({ muted: true, extra: 1 });
  assert.doesNotThrow(() => sanitizeAudioPrefs(input));
  assert.deepEqual(input, { muted: true, extra: 1 });
});

// ===========================================================================
// cuesFor: event to sound mapping
// ===========================================================================

test("cuesFor: a warning event plays the double beep", () => {
  assert.deepEqual(cues([ev.warn(20)], 20), { sound: "double", dropped: 0 });
});

test("cuesFor: countdown 3 and 2 during work play the short beep", () => {
  assert.deepEqual(cues([ev.cd(37, 3, "work")], 37), { sound: "short", dropped: 0 });
  assert.deepEqual(cues([ev.cd(38, 2, "work")], 38), { sound: "short", dropped: 0 });
});

test("cuesFor: countdown 3 and 2 during rest or get-ready are silent", () => {
  for (const phase of ["rest", "ready"]) {
    for (const n of [3, 2]) {
      assert.deepEqual(cues([ev.cd(10, n, phase)], 10), { sound: null, dropped: 0 }, `${phase} ${n}`);
    }
  }
});

test("cuesFor: countdown 1 plays the long beep in work, rest and get-ready", () => {
  for (const phase of ["work", "rest", "ready"]) {
    assert.deepEqual(cues([ev.cd(10, 1, phase)], 10), { sound: "long", dropped: 0 }, phase);
  }
});

test("cuesFor: ready, work-start, side-swap, rest-start and done make no sound", () => {
  const silent = [ev.ready(10), ev.work(10), ev.swap(10), ev.rest(10), ev.done(10)];
  for (const e of silent) {
    assert.deepEqual(cues([e], 10), { sound: null, dropped: 0 }, e.type);
  }
});

test("cuesFor: chirp is never chosen from events", () => {
  const all = [ev.ready(0), ev.work(0), ev.swap(0), ev.rest(0), ev.warn(0), ev.cd(0, 3), ev.cd(0, 2), ev.cd(0, 1), ev.done(0)];
  for (const e of all) assert.notEqual(cues([e], 0).sound, "chirp", e.type);
});

test("cuesFor: no events, an empty list or undefined gives no sound and nothing dropped", () => {
  assert.deepEqual(cues([], 10), { sound: null, dropped: 0 });
  assert.deepEqual(cues(undefined, 10), { sound: null, dropped: 0 });
});

// ===========================================================================
// cuesFor: staleness
// ===========================================================================

test("cuesFor: an event exactly 1.5 s old is still played", () => {
  assert.deepEqual(cues([ev.cd(10, 1)], 11.5), { sound: "long", dropped: 0 });
});

test("cuesFor: an event 1.51 s old is dropped and counted", () => {
  assert.deepEqual(cues([ev.cd(10, 1)], 11.51), { sound: null, dropped: 1 });
});

test("cuesFor: a sound-less stale event is ignored, not counted as dropped", () => {
  assert.deepEqual(cues([ev.rest(10), ev.work(10), ev.done(10)], 60), { sound: null, dropped: 0 });
  assert.deepEqual(cues([ev.cd(10, 3, "rest")], 60), { sound: null, dropped: 0 });
});

test("cuesFor: several stale sound events are all counted", () => {
  const events = [ev.warn(10), ev.cd(17, 3), ev.cd(18, 2), ev.cd(19, 1)];
  assert.deepEqual(cues(events, 40), { sound: null, dropped: 4 });
});

test("cuesFor: a stale event does not block a fresh lower-priority one", () => {
  // The stale long is dropped; the fresh short is what is left to play.
  assert.deepEqual(cues([ev.cd(10, 1), ev.cd(19.5, 3)], 20), { sound: "short", dropped: 1 });
});

test("cuesFor: the lead-in countdown 1 is judged by the same staleness rule", () => {
  assert.deepEqual(cues([ev.cd(-1, 1, "ready", null)], 0.4), { sound: "long", dropped: 0 });
  assert.deepEqual(cues([ev.cd(-1, 1, "ready", null)], 0.6), { sound: null, dropped: 1 });
});

// ===========================================================================
// cuesFor: one sound per call, priority and dropped counting
// ===========================================================================

test("cuesFor: long beats double and short even when it is not the latest event", () => {
  assert.deepEqual(cues([ev.cd(10, 1), ev.cd(10.5, 3)], 11), { sound: "long", dropped: 1 });
  assert.deepEqual(cues([ev.warn(10), ev.cd(10.4, 1)], 11), { sound: "long", dropped: 1 });
});

test("cuesFor: double beats short even when the short is later", () => {
  assert.deepEqual(cues([ev.warn(10), ev.cd(10.5, 2)], 11), { sound: "double", dropped: 1 });
});

test("cuesFor: with equal priority only one sound plays and the other fresh one is counted as dropped", () => {
  assert.deepEqual(cues([ev.cd(10, 3), ev.cd(11, 2)], 11.2), { sound: "short", dropped: 1 });
  assert.deepEqual(cues([ev.cd(10, 1, "rest"), ev.cd(10.5, 1, "work")], 11), { sound: "long", dropped: 1 });
});

test("cuesFor: every superseded fresh sound event and every stale one is counted", () => {
  const events = [ev.warn(1), ev.cd(18.8, 3), ev.cd(19.2, 2), ev.cd(19.6, 1)];
  // The warning is stale at 20; the two shorts are superseded by the long.
  assert.deepEqual(cues(events, 20), { sound: "long", dropped: 3 });
});

test("cuesFor: sound-less events mixed in with sound events are not counted", () => {
  const events = [ev.rest(19.5), ev.cd(19.6, 1), ev.work(19.7), ev.done(19.8)];
  assert.deepEqual(cues(events, 20), { sound: "long", dropped: 0 });
});

test("cuesFor: the result does not depend on the order of the events", () => {
  const events = [ev.warn(10), ev.cd(10.5, 2), ev.cd(10.8, 1)];
  const forward = cues(events, 11);
  const backward = cues([...events].reverse(), 11);
  assert.deepEqual(forward, { sound: "long", dropped: 2 });
  assert.deepEqual(backward, forward);
});

// ===========================================================================
// cuesFor: muted and purity
// ===========================================================================

test("cuesFor: muted plays nothing and reports nothing dropped", () => {
  const events = [ev.warn(10), ev.cd(10.5, 2), ev.cd(10.8, 1)];
  assert.deepEqual(cuesFor(events, { positionSec: 11, prefs: MUTED }), { sound: null, dropped: 0 });
});

test("cuesFor: muted also reports nothing dropped for stale events", () => {
  assert.deepEqual(cuesFor([ev.cd(1, 1), ev.warn(2)], { positionSec: 60, prefs: MUTED }), { sound: null, dropped: 0 });
});

test("cuesFor: unmuting makes the very same batch audible again", () => {
  const events = [ev.cd(10, 1)];
  assert.equal(cuesFor(events, { positionSec: 10, prefs: MUTED }).sound, null);
  assert.equal(cuesFor(events, { positionSec: 10, prefs: UNMUTED }).sound, "long");
});

test("cuesFor: does not mutate deep-frozen events or prefs", () => {
  const events = deepFreeze([ev.warn(10), ev.cd(10.5, 2), ev.cd(1, 1), ev.rest(10)]);
  const prefs = deepFreeze({ muted: false });
  const before = structuredClone(events);
  assert.doesNotThrow(() => cuesFor(events, { positionSec: 11, prefs }));
  assert.deepEqual(events, before);
  assert.deepEqual(prefs, { muted: false });
});

test("cuesFor: the same inputs always give the same answer", () => {
  const events = [ev.warn(10), ev.cd(10.5, 3)];
  assert.deepEqual(cues(events, 11), cues(events, 11));
});

// ===========================================================================
// toneFor
// ===========================================================================

const SOUND_IDS = ["double", "short", "long", "chirp"];

test("toneFor: an unknown id gives null", () => {
  for (const bad of [undefined, null, "", "boop", "SHORT", "toString", "constructor", "__proto__", 3, {}]) {
    assert.equal(toneFor(bad), null, String(bad));
  }
});

test("toneFor: every sound id has a tone with notes and a total", () => {
  for (const id of SOUND_IDS) {
    const tone = toneFor(id);
    assert.ok(tone, id);
    assert.ok(Array.isArray(tone.notes) && tone.notes.length > 0, id);
    assert.ok(Number.isFinite(tone.totalSec), id);
  }
});

test("toneFor: every note is audible and sane (freq 200-2000 Hz, positive length, gain up to 0.6)", () => {
  for (const id of SOUND_IDS) {
    for (const n of toneFor(id).notes) {
      assert.ok(Number.isFinite(n.freq) && n.freq >= 200 && n.freq <= 2000, `${id} freq ${n.freq}`);
      assert.ok(Number.isFinite(n.durSec) && n.durSec > 0, `${id} durSec ${n.durSec}`);
      assert.ok(Number.isFinite(n.startSec) && n.startSec >= 0, `${id} startSec ${n.startSec}`);
      assert.ok(Number.isFinite(n.gain) && n.gain > 0 && n.gain <= 0.6, `${id} gain ${n.gain}`);
    }
  }
});

test("toneFor: totalSec equals the end of the last note", () => {
  for (const id of SOUND_IDS) {
    const tone = toneFor(id);
    const end = Math.max(...tone.notes.map((n) => n.startSec + n.durSec));
    assert.ok(Math.abs(tone.totalSec - end) < 1e-9, `${id}: ${tone.totalSec} vs ${end}`);
  }
});

test("toneFor: every tone ends before the next one-second tick", () => {
  for (const id of SOUND_IDS) assert.ok(toneFor(id).totalSec < 0.6, id);
});

test("toneFor: short is a single note under 0.25 s", () => {
  const t = toneFor("short");
  assert.equal(t.notes.length, 1);
  assert.ok(t.notes[0].durSec < 0.25);
});

test("toneFor: long is a single note between 0.35 s and 0.6 s", () => {
  const t = toneFor("long");
  assert.equal(t.notes.length, 1);
  assert.ok(t.notes[0].durSec >= 0.35 && t.notes[0].durSec <= 0.6);
});

test("toneFor: double is two quick beeps under 0.5 s in total", () => {
  const t = toneFor("double");
  assert.equal(t.notes.length, 2);
  assert.ok(t.totalSec < 0.5);
});

test("toneFor: chirp is two notes under 0.5 s in total", () => {
  const t = toneFor("chirp");
  assert.equal(t.notes.length, 2);
  assert.ok(t.totalSec < 0.5);
});

test("toneFor: short and long share a pitch and double uses a different one", () => {
  const short = toneFor("short").notes[0].freq;
  const long = toneFor("long").notes[0].freq;
  assert.equal(short, long);
  for (const n of toneFor("double").notes) assert.notEqual(n.freq, short);
});

test("toneFor: returns data that is safe to modify without affecting later calls", () => {
  const a = toneFor("short");
  a.notes[0].freq = 1;
  a.totalSec = 99;
  assert.notEqual(toneFor("short").notes[0].freq, 1);
  assert.notEqual(toneFor("short").totalSec, 99);
});

// ===========================================================================
// Integration: real workouts through the timer at 100 ms ticks
// ===========================================================================

const T0 = 1_000_000;
const msAt = (plan, sec) => T0 + Math.round((sec + plan.leadInSec) * 1000);
const endMs = (plan) => msAt(plan, plan.durationSec);
const farMs = (plan) => endMs(plan) + 3_600_000;

const optionSets = [
  ["defaults", {}],
  ["warm-up counted, circuit", { warmup: { enabled: true, countsInTotal: true }, circuit: { size: 3, rounds: 2 } }],
  ["warm-up outside the total, circuit", { warmup: { enabled: true, countsInTotal: false }, circuit: { size: 3, rounds: 2 } }],
  ["no warm-up, no circuit", { warmup: { enabled: false }, circuit: null }],
  ["short 12 s work", { totalSeconds: 300, workSeconds: 12, restSeconds: 5, warmup: { enabled: false }, circuit: null }],
  ["10 s work", { totalSeconds: 240, workSeconds: 10, restSeconds: 5, warmup: { enabled: false }, circuit: null }],
];

function runs(seedCount = 10) {
  const out = [];
  for (const [label, opts] of optionSets) {
    for (let seed = 1; seed <= seedCount; seed++) {
      const workout = generateWorkout(library, opts, mulberry32(seed));
      out.push({ label: `${label} (seed ${seed})`, workout, plan: buildPlan(workout) });
    }
  }
  return out;
}

// The oracle for "which events should make a sound", written independently of
// cues.js so the integration tests do not just restate the implementation.
const soundOfEvent = (e) => {
  if (e.type === "warning") return "double";
  if (e.type !== "countdown") return null;
  if (e.n === 1) return "long";
  return e.phase === "work" ? "short" : null;
};
const RANK = { long: 3, double: 2, short: 1 };

// Expected sounds for a whole run from the workout's slot lengths alone.
function expectedSounds(workout, leadInSec = 5) {
  const out = [];
  if (leadInSec > 1) out.push({ pos: -1, sound: "long" });
  const slots = workout.slots;
  slots.forEach((s, i) => {
    const len = s.endSec - s.startSec;
    if (len > 10) out.push({ pos: s.endSec - 10, sound: "double" });
    if (len > 3) out.push({ pos: s.endSec - 3, sound: "short" });
    if (len > 2) out.push({ pos: s.endSec - 2, sound: "short" });
    if (len > 1) out.push({ pos: s.endSec - 1, sound: "long" });
    const next = slots[i + 1];
    if (next && next.startSec - s.endSec > 1) out.push({ pos: next.startSec - 1, sound: "long" });
  });
  return out.sort((a, b) => a.pos - b.pos);
}

// Tick at 100 ms steps through the whole run, asking cuesFor each tick.
const timelineCache = new WeakMap();
function run100(plan) {
  if (timelineCache.has(plan)) return timelineCache.get(plan);
  const result = [];
  let state = start(plan, T0);
  for (let now = T0; now <= endMs(plan) + 500; now += 100) {
    const r = tick(plan, state, now);
    state = r.state;
    const c = cuesFor(r.events, { positionSec: r.view.positionSec, prefs: UNMUTED });
    result.push({ pos: r.view.positionSec, sound: c.sound, dropped: c.dropped, events: r.events });
  }
  timelineCache.set(plan, result);
  return result;
}
const soundsOf = (plan) => run100(plan).filter((t) => t.sound);

test("integration: each work slot longer than 10 s gets double, short, short, long in order in its last 10 s", () => {
  let checked = 0; // the 10 s-work runs may have no slot over 10 s, so count across all runs
  for (const { label, workout, plan } of runs()) {
    const sounds = soundsOf(plan);
    for (const s of workout.slots) {
      if (s.endSec - s.startSec <= 10) continue;
      const inWindow = sounds.filter((t) => t.pos >= s.endSec - 10 && t.pos < s.endSec);
      assert.deepEqual(
        inWindow.map((t) => [t.pos - s.endSec, t.sound]),
        [[-10, "double"], [-3, "short"], [-2, "short"], [-1, "long"]],
        `${label} slot ${s.index}`
      );
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} long work slots checked`);
});

test("integration: every rest has exactly one long beep and no short or double", () => {
  for (const { label, workout, plan } of runs()) {
    const sounds = soundsOf(plan);
    let checked = 0;
    workout.slots.forEach((s, i) => {
      const next = workout.slots[i + 1];
      if (!next || next.startSec <= s.endSec) return; // no rest segment
      const inRest = sounds.filter((t) => t.pos >= s.endSec && t.pos < next.startSec);
      assert.deepEqual(
        inRest.map((t) => [t.pos - next.startSec, t.sound]),
        [[-1, "long"]],
        `${label} rest after slot ${s.index}`
      );
      checked++;
    });
    assert.ok(checked > 0, `${label}: no rests checked`);
  }
});

test("integration: the lead-in has exactly one long beep and no shorts", () => {
  for (const { label, plan } of runs()) {
    const lead = soundsOf(plan).filter((t) => t.pos < 0);
    assert.deepEqual(lead.map((t) => [t.pos, t.sound]), [[-1, "long"]], label);
  }
});

test("integration: no tick that should sound is silent, and the full sequence matches the expected one", () => {
  for (const { label, workout, plan } of runs()) {
    const actual = soundsOf(plan).map((t) => ({ pos: t.pos, sound: t.sound }));
    assert.deepEqual(actual, expectedSounds(workout, plan.leadInSec), label);
  }
});

test("integration: at a 100 ms cadence nothing is ever dropped and no tick returns more than one sound", () => {
  for (const { label, plan } of runs(4)) {
    for (const t of run100(plan)) {
      assert.equal(t.dropped, 0, `${label} at ${t.pos}`);
      assert.ok(t.sound === null || typeof t.sound === "string", label);
    }
  }
});

// A reference answer for a batch of events judged at positionSec, built from
// the oracle above.
function oracle(events, positionSec) {
  const sounding = events.filter((e) => soundOfEvent(e));
  const fresh = sounding.filter((e) => positionSec - e.at <= STALE_AFTER_SEC);
  let best = null;
  for (const e of fresh) {
    const s = soundOfEvent(e);
    if (!best || RANK[s] > RANK[best]) best = s;
  }
  return { sound: best, dropped: sounding.length - (best ? 1 : 0) };
}

test("integration: one giant tick over the whole workout yields at most one fresh sound, never a burst", () => {
  for (const { label, workout, plan } of runs(5)) {
    const r = tick(plan, start(plan, T0), farMs(plan));
    const c = cuesFor(r.events, { positionSec: r.view.positionSec, prefs: UNMUTED });
    assert.equal(r.view.positionSec, plan.durationSec, label);
    // Only the final long beep (1 s before the end) is still fresh.
    assert.equal(c.sound, "long", label);
    assert.equal(c.dropped, expectedSounds(workout, plan.leadInSec).length - 1, label);
    assert.deepEqual(c, oracle(r.events, r.view.positionSec), label);
  }
});

test("integration: a giant tick that lands mid-workout plays only what is fresh at that point", () => {
  for (const { label, workout, plan } of runs(3)) {
    const all = expectedSounds(workout, plan.leadInSec);
    for (const p of [all[3].pos + 0.25, all[3].pos + 2, all.at(-5).pos + 0.5, 0]) {
      const r = tick(plan, start(plan, T0), msAt(plan, p));
      const c = cuesFor(r.events, { positionSec: r.view.positionSec, prefs: UNMUTED });
      assert.deepEqual(c, oracle(r.events, r.view.positionSec), `${label} jump to ${p}`);
      if (c.sound) {
        assert.ok(
          r.events.some((e) => soundOfEvent(e) === c.sound && r.view.positionSec - e.at <= STALE_AFTER_SEC),
          `${label} jump to ${p}: ${c.sound} is not backed by a fresh event`
        );
      }
    }
  }
});

test("integration: a throttled page ticking every few seconds never plays more than one sound per tick, and only fresh ones", () => {
  for (const { label, plan } of runs(2)) {
    for (const stepMs of [1500, 3000, 7000]) {
      let state = start(plan, T0);
      for (let now = T0; now <= farMs(plan); now += stepMs) {
        const r = tick(plan, state, now);
        state = r.state;
        const c = cuesFor(r.events, { positionSec: r.view.positionSec, prefs: UNMUTED });
        assert.deepEqual(c, oracle(r.events, r.view.positionSec), `${label} step ${stepMs} at ${r.view.positionSec}`);
        if (now > endMs(plan) + 20_000) break;
      }
    }
  }
});

test("integration: a 60 s pause mid-workout then resume produces no stale burst", () => {
  for (const { label, workout, plan } of runs(4)) {
    const mid = workout.slots[Math.floor(workout.slots.length / 2)];
    const before = mid.startSec + 2; // last ticked here (100 ms cadence up to this point)
    let state = start(plan, T0);
    for (let now = T0; now <= msAt(plan, before); now += 100) state = tick(plan, state, now).state;

    // The page then stalls for a while before the user pauses 11 s further on,
    // so the pause tick sees a gap that contains countdown beeps.
    const pausedAtSec = mid.endSec + 0.3;
    const pausedState = pause(state, msAt(plan, pausedAtSec));
    const during = tick(plan, pausedState, msAt(plan, pausedAtSec) + 60_000);
    const c = cuesFor(during.events, { positionSec: during.view.positionSec, prefs: UNMUTED });
    assert.equal(during.view.positionSec, pausedAtSec, label);
    assert.deepEqual(c, oracle(during.events, during.view.positionSec), label);
    assert.ok(c.dropped >= 1, `${label}: the gap should have contained dropped beeps`);

    // Resume and carry on at 100 ms steps: exactly the remaining expected sounds.
    const resumedAt = msAt(plan, pausedAtSec) + 60_000 + 5_000;
    let s = resume(during.state, resumedAt);
    const got = [];
    for (let now = resumedAt; now <= resumedAt + (plan.durationSec - pausedAtSec) * 1000 + 500; now += 100) {
      const r = tick(plan, s, now);
      s = r.state;
      const cc = cuesFor(r.events, { positionSec: r.view.positionSec, prefs: UNMUTED });
      assert.equal(cc.dropped, 0, `${label} stale beep after resume at ${r.view.positionSec}`);
      if (cc.sound) got.push({ pos: r.view.positionSec, sound: cc.sound });
    }
    const expected = expectedSounds(workout, plan.leadInSec).filter((x) => x.pos > pausedAtSec);
    assert.deepEqual(got, expected, label);
  }
});

test("integration: pausing for 60 s during the lead-in and resuming plays the lead-in long beep once", () => {
  for (const { label, plan } of runs(2)) {
    let state = start(plan, T0);
    const at = tick(plan, state, msAt(plan, -2.5));
    state = pause(at.state, msAt(plan, -2.5));
    const during = tick(plan, state, msAt(plan, -2.5) + 60_000);
    assert.equal(during.view.positionSec, -2.5, label);
    const resumedAt = msAt(plan, -2.5) + 61_000;
    const got = [];
    let s = resume(during.state, resumedAt);
    for (let now = resumedAt; now <= resumedAt + 3000; now += 100) {
      const r = tick(plan, s, now);
      s = r.state;
      const c = cuesFor(r.events, { positionSec: r.view.positionSec, prefs: UNMUTED });
      if (c.sound) got.push(c.sound);
    }
    assert.deepEqual(got, ["long"], label);
  }
});
