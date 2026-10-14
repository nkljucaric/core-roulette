import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPlan, start, pause, resume, tick, eventsBetween } from "../src/timer.js";
import { generateWorkout } from "../src/generator.js";

// Logic-layer tests for the timer engine (issue #9). The contract is the scope
// comment on #9. All plan/view/event times are seconds of workout time, where 0
// is the instant the first move starts and the lead-in is negative time. `nowMs`
// is an integer millisecond clock from any epoch. The `state` returned by
// start/pause/resume/tick is opaque except for `state.status`; these tests only
// ever hand states back to the engine.

const library = JSON.parse(
  readFileSync(new URL("../exercises.json", import.meta.url), "utf8")
);

// Small seeded PRNG so every test is deterministic.
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

// JSON round trip: drops -0 vs 0 distinctions so exact comparisons do not
// depend on how an implementation happens to compute a zero.
const norm = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Fixtures in generator slot shape
// ---------------------------------------------------------------------------

// rows: [exerciseId, side, workSeconds, restAfter]
function makeWorkout(rows) {
  const slots = [];
  let t = 0;
  rows.forEach(([id, side, work, rest], i) => {
    slots.push({
      index: i,
      exerciseId: id,
      name: `Move ${id}`,
      section: "main",
      blockId: "straight-1",
      round: 1,
      side,
      workSeconds: work,
      restAfter: rest,
      startSec: t,
      endSec: t + work,
    });
    t += work + rest;
  });
  const last = slots[slots.length - 1];
  return { durationSeconds: last.endSec, slots, blocks: [], warnings: [], options: {} };
}

// Work 10s / rest 5s. With the default 5s lead-in the timeline is:
//   ready [-5,0)  work0 [0,10)  rest [10,15)  work1(left) [15,25)
//   work2(right) [25,35)  rest [35,40)  work3 [40,50)      duration 50
// Slots 1 and 2 are one two-sided move, so there is no rest between them.
const fixture = () =>
  makeWorkout([
    ["crunch", null, 10, 5],
    ["side-plank", "left", 10, 0],
    ["side-plank", "right", 10, 5],
    ["dead-bug", null, 10, 0],
  ]);

// Very short phases, to exercise which countdown numbers are emitted. Use with
// leadInSec 1. Timeline:
//   ready [-1,0)  work0 [0,3)  rest [3,5)  work1(left) [5,6)
//   work2(right) [6,8)  rest [8,9)  work3 [9,13)                duration 13
const shortFixture = () =>
  makeWorkout([
    ["a", null, 3, 2],
    ["b", "left", 1, 0],
    ["b", "right", 2, 1],
    ["c", null, 4, 0],
  ]);

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

const T0 = 1_000_000;
// nowMs at which the workout clock reads `sec` when the run started at T0.
const msAt = (plan, sec) => T0 + Math.round((sec + plan.leadInSec) * 1000);
const endMs = (plan) => msAt(plan, plan.durationSec);
const farMs = (plan) => endMs(plan) + 3_600_000;

const viewAt = (plan, sec) => tick(plan, start(plan, T0), msAt(plan, sec)).view;

// Ticks through `nows` in order, threading the state; returns everything.
function runTicks(plan, nows, state = start(plan, T0)) {
  const events = [];
  for (const now of nows) {
    const r = tick(plan, state, now);
    state = r.state;
    events.push(...r.events);
    // Fail fast (instead of exhausting memory) if an implementation re-reports events.
    assert.ok(events.length < 10_000, "events are being re-delivered on every tick");
  }
  return { events, state };
}

function everyMs(plan, stepMs) {
  const out = [];
  for (let t = T0; t < endMs(plan) + stepMs; t += stepMs) out.push(t);
  out.push(farMs(plan));
  return out;
}

// Random jumps of 1ms..15s; does not start at T0 so the first tick may skip
// the start of the run.
function randomJumps(plan, seed) {
  const rng = mulberry32(seed);
  const out = [];
  let t = T0;
  while (t < endMs(plan)) {
    t += 1 + Math.floor(rng() * 15000);
    out.push(t);
  }
  out.push(farMs(plan));
  return out;
}

const fullEvents = (plan) => eventsBetween(plan, -Infinity, plan.durationSec);
const eventKey = (e) => JSON.stringify([e.type, e.at, e.slotIndex, e.n ?? null]);

// ---------------------------------------------------------------------------
// Expected-event builders (independent of the implementation)
// ---------------------------------------------------------------------------

const E = {
  ready: (at, nextSlotIndex) => ({ type: "ready", at, slotIndex: null, nextSlotIndex }),
  work: (at, slotIndex, side = null) => ({ type: "work-start", at, slotIndex, side }),
  swap: (at, slotIndex) => ({ type: "side-swap", at, slotIndex, side: "right" }),
  rest: (at, slotIndex) => ({ type: "rest-start", at, slotIndex, nextSlotIndex: slotIndex + 1 }),
  cd: (at, n, phase, slotIndex) => ({ type: "countdown", at, n, phase, slotIndex }),
  warn: (at, slotIndex) => ({ type: "warning", at, n: 10, phase: "work", slotIndex }),
  done: (at, slotIndex) => ({ type: "done", at, slotIndex }),
};

// Expected events for the main fixture with the default 5s lead-in.
const expectedFixtureEvents = () => [
  E.ready(-5, 0),
  E.cd(-3, 3, "ready", null),
  E.cd(-2, 2, "ready", null),
  E.cd(-1, 1, "ready", null),
  E.work(0, 0),
  E.cd(7, 3, "work", 0),
  E.cd(8, 2, "work", 0),
  E.cd(9, 1, "work", 0),
  E.rest(10, 0),
  E.cd(12, 3, "rest", 0),
  E.cd(13, 2, "rest", 0),
  E.cd(14, 1, "rest", 0),
  E.work(15, 1, "left"),
  E.cd(22, 3, "work", 1),
  E.cd(23, 2, "work", 1),
  E.cd(24, 1, "work", 1),
  E.swap(25, 2), // no rest-start before it: there is no gap between the sides
  E.cd(32, 3, "work", 2),
  E.cd(33, 2, "work", 2),
  E.cd(34, 1, "work", 2),
  E.rest(35, 2),
  E.cd(37, 3, "rest", 2),
  E.cd(38, 2, "rest", 2),
  E.cd(39, 1, "rest", 2),
  E.work(40, 3),
  E.cd(47, 3, "work", 3),
  E.cd(48, 2, "work", 3),
  E.cd(49, 1, "work", 3),
  E.done(50, 3),
];

// ===========================================================================
// buildPlan
// ===========================================================================

test("buildPlan: durationSec is the last slot's endSec and leadInSec defaults to 5", () => {
  const plan = buildPlan(fixture());
  assert.equal(plan.durationSec, 50);
  assert.equal(plan.leadInSec, 5);
});

test("buildPlan: a custom leadInSec is kept and does not change durationSec", () => {
  const plan = buildPlan(fixture(), { leadInSec: 3 });
  assert.equal(plan.leadInSec, 3);
  assert.equal(plan.durationSec, 50);
});

test("buildPlan: lead-in is negative time, so the ready phase runs from -leadInSec to 0", () => {
  const plan = buildPlan(fixture());
  assert.equal(viewAt(plan, -5).phase, "ready");
  assert.equal(viewAt(plan, -0.5).phase, "ready");
  assert.equal(viewAt(plan, 0).phase, "work");
});

test("buildPlan: one work phase per slot and one rest phase per non-zero gap", () => {
  const plan = buildPlan(fixture());
  // Walk the timeline and record each distinct (phase, slotIndex) in order.
  const seen = [];
  for (let sec = -5; sec < 50; sec += 0.5) {
    const v = viewAt(plan, sec);
    const key = `${v.phase}:${v.slotIndex}`;
    if (seen.at(-1) !== key) seen.push(key);
  }
  assert.deepEqual(seen, [
    "ready:null",
    "work:0",
    "rest:0",
    "work:1",
    "work:2",
    "rest:2",
    "work:3",
  ]);
});

test("buildPlan: no rest phase between the left and right sides of a two-sided move", () => {
  const plan = buildPlan(fixture());
  for (let ms = 0; ms <= 55_000; ms += 25) {
    const v = tick(plan, start(plan, T0), T0 + ms).view;
    assert.ok(!(v.phase === "rest" && v.slotIndex === 1), `rest after the left side at +${ms}ms`);
  }
  assert.ok(!fullEvents(plan).some((e) => e.type === "rest-start" && e.slotIndex === 1));
});

test("buildPlan: no rest phase after the last slot", () => {
  const plan = buildPlan(fixture());
  assert.equal(viewAt(plan, 49.5).phase, "work");
  assert.equal(viewAt(plan, 50).phase, "done");
  assert.ok(!fullEvents(plan).some((e) => e.type === "rest-start" && e.slotIndex === 3));
});

test("buildPlan: leadInSec 0 has no ready phase and no ready event", () => {
  const plan = buildPlan(fixture(), { leadInSec: 0 });
  assert.equal(plan.leadInSec, 0);
  assert.equal(plan.durationSec, 50);
  assert.equal(viewAt(plan, 0).phase, "work");
  assert.ok(!fullEvents(plan).some((e) => e.type === "ready"));
  assert.ok(!fullEvents(plan).some((e) => e.type === "countdown" && e.phase === "ready"));
});

test("buildPlan: leadInSec 0 reports the first work-start on the very first tick", () => {
  const plan = buildPlan(fixture(), { leadInSec: 0 });
  const r = tick(plan, start(plan, T0), T0);
  assert.deepEqual(norm(r.events), [E.work(0, 0)]);
  assert.equal(r.view.phase, "work");
  assert.equal(r.view.phaseRemainingSec, 10);
});

test("buildPlan: throws RangeError for a workout with no slots", () => {
  assert.throws(() => buildPlan({ durationSeconds: 0, slots: [] }), RangeError);
});

test("buildPlan: throws RangeError for a negative leadInSec", () => {
  assert.throws(() => buildPlan(fixture(), { leadInSec: -1 }), RangeError);
});

test("buildPlan: throws RangeError for a non-finite leadInSec", () => {
  assert.throws(() => buildPlan(fixture(), { leadInSec: NaN }), RangeError);
  assert.throws(() => buildPlan(fixture(), { leadInSec: Infinity }), RangeError);
});

test("buildPlan: accepts a deep-frozen workout and does not mutate it", () => {
  const workout = deepFreeze(fixture());
  const before = structuredClone(workout);
  assert.doesNotThrow(() => buildPlan(workout));
  assert.deepEqual(workout, before);
});

test("buildPlan: a single-slot workout with no lead-in works end to end", () => {
  const plan = buildPlan(makeWorkout([["solo", null, 10, 0]]), { leadInSec: 0 });
  assert.equal(plan.durationSec, 10);
  assert.deepEqual(norm(fullEvents(plan)), [
    E.work(0, 0),
    E.cd(7, 3, "work", 0),
    E.cd(8, 2, "work", 0),
    E.cd(9, 1, "work", 0),
    E.done(10, 0),
  ]);
  const end = viewAt(plan, 10);
  assert.equal(end.phase, "done");
  assert.equal(end.slotIndex, 0);
  assert.equal(end.next, null);
});

// ===========================================================================
// View: exact values at chosen instants of the fixture
// ===========================================================================

test("view: at the very start of the lead-in shows ready with the full lead-in and the full total", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, -5)), {
    status: "running",
    phase: "ready",
    slotIndex: null,
    slot: null,
    side: null,
    phaseRemainingSec: 5,
    phaseDurationSec: 5,
    totalRemainingSec: 50,
    elapsedSec: 0,
    positionSec: -5,
    next: f.slots[0],
    nextIsSideSwap: false,
  });
});

test("view: mid lead-in rounds the ready countdown up and keeps the total at the full duration", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, -3.5);
  assert.equal(v.phase, "ready");
  assert.equal(v.phaseRemainingSec, 4); // ceil(3.5)
  assert.equal(v.phaseDurationSec, 5);
  assert.equal(v.totalRemainingSec, 50);
  assert.equal(v.elapsedSec, 0);
});

test("view: just before the end of the lead-in still shows 1 second of ready", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, -0.5);
  assert.equal(v.phase, "ready");
  assert.equal(v.phaseRemainingSec, 1);
  assert.equal(v.slotIndex, null);
});

test("view: at exactly workout time 0 the first move starts (half-open boundary)", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 0)), {
    status: "running",
    phase: "work",
    slotIndex: 0,
    slot: f.slots[0],
    side: null,
    phaseRemainingSec: 10,
    phaseDurationSec: 10,
    totalRemainingSec: 50,
    elapsedSec: 0,
    positionSec: 0,
    next: f.slots[1],
    nextIsSideSwap: false,
  });
});

test("view: mid-work uses ceil for both countdowns and reports unrounded elapsedSec", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, 3.5);
  assert.equal(v.phase, "work");
  assert.equal(v.slotIndex, 0);
  assert.equal(v.phaseRemainingSec, 7); // ceil(6.5)
  assert.equal(v.phaseDurationSec, 10);
  assert.equal(v.totalRemainingSec, 47); // ceil(46.5)
  assert.equal(v.elapsedSec, 3.5);
});

test("view: the instant a work phase ends the rest phase applies, for the move just finished", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 10)), {
    status: "running",
    phase: "rest",
    slotIndex: 0,
    slot: f.slots[0],
    side: null,
    phaseRemainingSec: 5,
    phaseDurationSec: 5,
    totalRemainingSec: 40,
    elapsedSec: 10,
    positionSec: 10,
    next: f.slots[1],
    nextIsSideSwap: false,
  });
});

test("view: late in rest shows 1 second remaining, not 0", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, 14.5);
  assert.equal(v.phase, "rest");
  assert.equal(v.phaseRemainingSec, 1);
  assert.equal(v.totalRemainingSec, 36); // ceil(35.5)
});

test("view: at the end of rest the next move starts, as the left side, and flags the upcoming swap", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 15)), {
    status: "running",
    phase: "work",
    slotIndex: 1,
    slot: f.slots[1],
    side: "left",
    phaseRemainingSec: 10,
    phaseDurationSec: 10,
    totalRemainingSec: 35,
    elapsedSec: 15,
    positionSec: 15,
    next: f.slots[2],
    nextIsSideSwap: true,
  });
});

test("view: one millisecond before the side swap is still the left side with 1 second remaining", () => {
  const plan = buildPlan(fixture());
  const v = tick(plan, start(plan, T0), msAt(plan, 25) - 1).view;
  assert.equal(v.phase, "work");
  assert.equal(v.slotIndex, 1);
  assert.equal(v.side, "left");
  assert.equal(v.phaseRemainingSec, 1);
  assert.equal(v.nextIsSideSwap, true);
});

test("view: at the side swap the right side starts straight away with no rest, and nextIsSideSwap clears", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 25)), {
    status: "running",
    phase: "work",
    slotIndex: 2,
    slot: f.slots[2],
    side: "right",
    phaseRemainingSec: 10,
    phaseDurationSec: 10,
    totalRemainingSec: 25,
    elapsedSec: 25,
    positionSec: 25,
    next: f.slots[3],
    nextIsSideSwap: false,
  });
});

test("view: resting after the right side reports that side and a next move that is not a swap", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 35)), {
    status: "running",
    phase: "rest",
    slotIndex: 2,
    slot: f.slots[2],
    side: "right",
    phaseRemainingSec: 5,
    phaseDurationSec: 5,
    totalRemainingSec: 15,
    elapsedSec: 35,
    positionSec: 35,
    next: f.slots[3],
    nextIsSideSwap: false,
  });
});

test("view: the last slot has next null and nextIsSideSwap false", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 40)), {
    status: "running",
    phase: "work",
    slotIndex: 3,
    slot: f.slots[3],
    side: null,
    phaseRemainingSec: 10,
    phaseDurationSec: 10,
    totalRemainingSec: 10,
    elapsedSec: 40,
    positionSec: 40,
    next: null,
    nextIsSideSwap: false,
  });
});

test("view: last half second shows 1 second left in both countdowns", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, 49.5);
  assert.equal(v.phase, "work");
  assert.equal(v.phaseRemainingSec, 1);
  assert.equal(v.totalRemainingSec, 1);
});

test("view: at exactly the duration the workout is done with everything zeroed", () => {
  const plan = buildPlan(fixture());
  const f = fixture();
  assert.deepEqual(norm(viewAt(plan, 50)), {
    status: "done",
    phase: "done",
    slotIndex: 3,
    slot: f.slots[3],
    side: null,
    phaseRemainingSec: 0,
    phaseDurationSec: 0,
    totalRemainingSec: 0,
    elapsedSec: 50,
    positionSec: 50,
    next: null,
    nextIsSideSwap: false,
  });
});

test("view: well past the end is still done and elapsedSec is clamped to the duration", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, 500);
  assert.equal(v.status, "done");
  assert.equal(v.phase, "done");
  assert.equal(v.totalRemainingSec, 0);
  assert.equal(v.elapsedSec, 50);
  assert.equal(v.slotIndex, 3);
});

test("view: a workout that ends on the right side of a two-sided move reports side right when done", () => {
  const plan = buildPlan(
    makeWorkout([
      ["a", null, 10, 5],
      ["b", "left", 10, 0],
      ["b", "right", 10, 0],
    ]),
    { leadInSec: 0 }
  );
  const v = viewAt(plan, 35);
  assert.equal(v.phase, "done");
  assert.equal(v.slotIndex, 2);
  assert.equal(v.side, "right");
});

// ===========================================================================
// Events: exact lists
// ===========================================================================

test("events: ticking once far past the end returns the exact ordered event list for the fixture", () => {
  const plan = buildPlan(fixture());
  const r = tick(plan, start(plan, T0), farMs(plan));
  assert.deepEqual(norm(r.events), expectedFixtureEvents());
});

test("events: eventsBetween over the whole run returns the same exact list", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(norm(fullEvents(plan)), expectedFixtureEvents());
});

test("events: the left-to-right boundary emits side-swap and neither a rest-start nor a work-start", () => {
  const plan = buildPlan(fixture());
  const atBoundary = fullEvents(plan).filter((e) => e.at === 25);
  assert.deepEqual(norm(atBoundary), [E.swap(25, 2)]);
});

test("events: short phases only get countdown numbers that fall strictly inside the phase", () => {
  const plan = buildPlan(shortFixture(), { leadInSec: 1 });
  assert.deepEqual(norm(fullEvents(plan)), [
    E.ready(-1, 0), // 1s lead-in: no countdown
    E.work(0, 0),
    E.cd(1, 2, "work", 0), // 3s work: only 2 and 1
    E.cd(2, 1, "work", 0),
    E.rest(3, 0),
    E.cd(4, 1, "rest", 0), // 2s rest: only 1
    E.work(5, 1, "left"), // 1s work: no countdown
    E.swap(6, 2),
    E.cd(7, 1, "work", 2), // 2s work: only 1
    E.rest(8, 2), // 1s rest: no countdown
    E.work(9, 3),
    E.cd(10, 3, "work", 3),
    E.cd(11, 2, "work", 3),
    E.cd(12, 1, "work", 3),
    E.done(13, 3),
  ]);
});

test("events: the lead-in countdown reports phase ready with a null slotIndex", () => {
  const plan = buildPlan(fixture());
  const ready = fullEvents(plan).filter((e) => e.type === "countdown" && e.phase === "ready");
  assert.deepEqual(
    norm(ready).map((e) => [e.at, e.n, e.slotIndex]),
    [[-3, 3, null], [-2, 2, null], [-1, 1, null]]
  );
});

test("events: the first tick reports an event at exactly -leadInSec", () => {
  const plan = buildPlan(fixture());
  const r = tick(plan, start(plan, T0), T0);
  assert.deepEqual(norm(r.events), [E.ready(-5, 0)]);
});

test("events: a tick reports events up to and including the current instant", () => {
  const plan = buildPlan(fixture());
  const r = tick(plan, start(plan, T0), msAt(plan, 10));
  const last = r.events.at(-1);
  assert.deepEqual(norm(last), E.rest(10, 0));
  assert.ok(r.events.every((e) => e.at <= 10));
});

test("events: a tick one millisecond before an event does not report it", () => {
  const plan = buildPlan(fixture());
  const r = tick(plan, start(plan, T0), msAt(plan, 10) - 1);
  assert.ok(!r.events.some((e) => e.type === "rest-start"));
  assert.deepEqual(norm(r.events.at(-1)), E.cd(9, 1, "work", 0));
});

test("events: successive ticks report only what is new", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 7));
  const b = tick(plan, a.state, msAt(plan, 10));
  assert.deepEqual(norm(b.events), [E.cd(8, 2, "work", 0), E.cd(9, 1, "work", 0), E.rest(10, 0)]);
});

test("events: ticking again at the same instant reports nothing", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 12));
  const b = tick(plan, a.state, msAt(plan, 12));
  assert.deepEqual(b.events, []);
});

// ===========================================================================
// Throttling invariance
// ===========================================================================

function assertSameAsReference(plan, eventsFromTicks, label) {
  const ref = norm(fullEvents(plan));
  assert.deepEqual(norm(eventsFromTicks), ref, label);
  const keys = eventsFromTicks.map(eventKey);
  assert.equal(new Set(keys).size, keys.length, `${label}: an event was delivered twice`);
}

test("throttling: ticking every 100ms yields the exact event list", () => {
  const plan = buildPlan(fixture());
  const { events } = runTicks(plan, everyMs(plan, 100));
  assert.deepEqual(norm(events), expectedFixtureEvents());
});

test("throttling: ticking every 1s yields the exact event list", () => {
  const plan = buildPlan(fixture());
  const { events } = runTicks(plan, everyMs(plan, 1000));
  assert.deepEqual(norm(events), expectedFixtureEvents());
});

test("throttling: ticking every 7s (iOS-style throttling) yields the exact event list", () => {
  const plan = buildPlan(fixture());
  const { events } = runTicks(plan, everyMs(plan, 7000));
  assert.deepEqual(norm(events), expectedFixtureEvents());
});

test("throttling: a single tick after the whole run yields the exact event list", () => {
  const plan = buildPlan(fixture());
  const { events } = runTicks(plan, [farMs(plan)]);
  assert.deepEqual(norm(events), expectedFixtureEvents());
});

test("throttling: seeded random jump sizes all yield the same list with no duplicates", () => {
  const plan = buildPlan(fixture());
  for (let seed = 1; seed <= 25; seed++) {
    const { events } = runTicks(plan, randomJumps(plan, seed));
    assertSameAsReference(plan, events, `seed ${seed}`);
  }
});

test("throttling: the short-phase fixture is also cadence independent", () => {
  const plan = buildPlan(shortFixture(), { leadInSec: 1 });
  for (const step of [50, 250, 1000, 3000]) {
    assertSameAsReference(plan, runTicks(plan, everyMs(plan, step)).events, `step ${step}`);
  }
  for (let seed = 1; seed <= 15; seed++) {
    assertSameAsReference(plan, runTicks(plan, randomJumps(plan, seed)).events, `seed ${seed}`);
  }
});

test("throttling: a view read after a delayed tick still shows the correct remaining time", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 2)); // then the page is throttled
  const b = tick(plan, a.state, msAt(plan, 32.5)); // next tick arrives 30.5s later
  assert.equal(b.view.phase, "work");
  assert.equal(b.view.slotIndex, 2);
  assert.equal(b.view.side, "right");
  assert.equal(b.view.phaseRemainingSec, 3); // ceil(2.5)
  assert.equal(b.view.totalRemainingSec, 18); // ceil(17.5)
});

test("throttling: a huge jump to the end reports every missed event exactly once, then nothing", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 1));
  const b = tick(plan, a.state, farMs(plan));
  assert.deepEqual(norm([...a.events, ...b.events]), expectedFixtureEvents());
  const c = tick(plan, b.state, farMs(plan) + 60_000);
  assert.deepEqual(c.events, []);
});

// ===========================================================================
// Pause / resume
// ===========================================================================

test("pause: start returns a running state and pause/resume flip the status", () => {
  const plan = buildPlan(fixture());
  const s = start(plan, T0);
  assert.equal(s.status, "running");
  const p = pause(s, T0 + 8000);
  assert.equal(p.status, "paused");
  assert.equal(resume(p, T0 + 9000).status, "running");
});

test("pause: tick keeps the status of the state it is given", () => {
  const plan = buildPlan(fixture());
  const s = start(plan, T0);
  assert.equal(tick(plan, s, T0 + 1000).state.status, "running");
  assert.equal(tick(plan, pause(s, T0 + 1000), T0 + 9000).state.status, "paused");
});

test("pause: elapsed time is frozen while paused, whatever the later nowMs", () => {
  const plan = buildPlan(fixture());
  const running = tick(plan, start(plan, T0), msAt(plan, 3));
  const paused = pause(running.state, msAt(plan, 3));
  const early = tick(plan, paused, msAt(plan, 3)).view;
  const later = tick(plan, paused, msAt(plan, 3) + 60_000).view;
  const muchLater = tick(plan, paused, msAt(plan, 3) + 3_600_000).view;
  assert.equal(early.status, "paused");
  assert.equal(early.elapsedSec, 3);
  assert.deepEqual(later, early);
  assert.deepEqual(muchLater, early);
});

test("pause: a paused view keeps the phase, countdowns and totals from the frozen instant", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 12.5));
  const v = tick(plan, paused, msAt(plan, 40)).view;
  assert.equal(v.status, "paused");
  assert.equal(v.phase, "rest");
  assert.equal(v.slotIndex, 0);
  assert.equal(v.phaseRemainingSec, 3); // ceil(2.5)
  assert.equal(v.totalRemainingSec, 38); // ceil(37.5)
  assert.equal(v.elapsedSec, 12.5);
});

test("pause: resume continues exactly from the frozen point", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 3));
  const resumedAt = msAt(plan, 3) + 45_000;
  const running = resume(paused, resumedAt);
  const v = tick(plan, running, resumedAt + 2500).view; // 2.5s of running time
  assert.equal(v.status, "running");
  assert.equal(v.elapsedSec, 5.5);
  assert.equal(v.phase, "work");
  assert.equal(v.phaseRemainingSec, 5); // ceil(4.5)
  assert.equal(v.totalRemainingSec, 45); // ceil(44.5)
});

test("pause: ticking at the resume instant shows the frozen point, not a jump", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 3));
  const resumedAt = msAt(plan, 3) + 45_000;
  const v = tick(plan, resume(paused, resumedAt), resumedAt).view;
  assert.equal(v.elapsedSec, 3);
});

test("pause: events are not duplicated or lost across a pause and resume", () => {
  const plan = buildPlan(fixture());
  const out = [];
  let r = tick(plan, start(plan, T0), msAt(plan, 8)); // reports up to 8
  out.push(...r.events);
  let s = pause(r.state, msAt(plan, 8.5)); // pause half a second later
  r = tick(plan, s, msAt(plan, 8.5) + 100_000); // tick while paused
  out.push(...r.events);
  r = tick(plan, r.state, msAt(plan, 8.5) + 200_000); // still paused
  out.push(...r.events);
  const resumedAt = msAt(plan, 8.5) + 300_000;
  s = resume(r.state, resumedAt);
  r = tick(plan, s, resumedAt + 20_000); // 20s of running time -> workout 28.5
  out.push(...r.events);
  r = tick(plan, r.state, resumedAt + 3_600_000);
  out.push(...r.events);
  assertSameAsReference(plan, out, "across a pause");
});

test("pause: a paused tick reports not-yet-reported events up to the frozen point and nothing after", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 12)); // never ticked before the pause
  const r = tick(plan, paused, msAt(plan, 12) + 600_000);
  assert.deepEqual(norm(r.events), norm(eventsBetween(plan, -Infinity, 12)));
  assert.ok(r.events.every((e) => e.at <= 12));
  const again = tick(plan, r.state, msAt(plan, 12) + 900_000);
  assert.deepEqual(again.events, []);
});

test("pause: pausing during the lead-in freezes the ready countdown", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, -3));
  const r = tick(plan, paused, msAt(plan, -3) + 99_000);
  assert.equal(r.view.status, "paused");
  assert.equal(r.view.phase, "ready");
  assert.equal(r.view.phaseRemainingSec, 3);
  assert.equal(r.view.totalRemainingSec, 50);
  assert.equal(r.view.elapsedSec, 0);
  assert.deepEqual(norm(r.events), [E.ready(-5, 0), E.cd(-3, 3, "ready", null)]);
});

test("pause: resuming during the lead-in carries on the ready countdown", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, -3));
  const r1 = tick(plan, paused, msAt(plan, -3) + 99_000);
  const resumedAt = msAt(plan, -3) + 100_000;
  const r2 = tick(plan, resume(r1.state, resumedAt), resumedAt + 1000);
  assert.equal(r2.view.status, "running");
  assert.equal(r2.view.phase, "ready");
  assert.equal(r2.view.phaseRemainingSec, 2);
  assert.deepEqual(norm(r2.events), [E.cd(-2, 2, "ready", null)]);
});

test("pause: pausing twice is stable", () => {
  const plan = buildPlan(fixture());
  const once = pause(start(plan, T0), msAt(plan, 6));
  const twice = pause(once, msAt(plan, 6) + 30_000);
  const a = tick(plan, once, msAt(plan, 6) + 90_000);
  const b = tick(plan, twice, msAt(plan, 6) + 90_000);
  assert.equal(twice.status, "paused");
  assert.deepEqual(b.view, a.view);
  assert.deepEqual(b.events, a.events);
  assert.equal(b.view.elapsedSec, 6);
});

test("pause: resuming a running state is a no-op", () => {
  const plan = buildPlan(fixture());
  const running = tick(plan, start(plan, T0), msAt(plan, 4)).state;
  const same = resume(running, msAt(plan, 5));
  assert.equal(same.status, "running");
  const a = tick(plan, running, msAt(plan, 9));
  const b = tick(plan, same, msAt(plan, 9));
  assert.deepEqual(b.view, a.view);
  assert.deepEqual(b.events, a.events);
});

test("pause: pausing at or after the end gives a done view", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), farMs(plan));
  const v = tick(plan, paused, farMs(plan) + 1000).view;
  assert.equal(v.status, "done");
  assert.equal(v.phase, "done");
  assert.equal(v.totalRemainingSec, 0);
});

test("pause: elapsed equals the total running time across repeated pause/resume cycles", () => {
  const plan = buildPlan(fixture());
  const rng = mulberry32(99);
  let now = T0;
  let runningMs = 0;
  let r = { state: start(plan, T0), events: [] };
  const all = [];
  for (let i = 0; i < 6; i++) {
    const run = 500 + Math.floor(rng() * 4000);
    now += run;
    runningMs += run;
    r = tick(plan, r.state, now);
    all.push(...r.events);
    const pausedState = pause(r.state, now);
    now += 1000 + Math.floor(rng() * 50_000); // paused gap, with a tick inside it
    r = tick(plan, pausedState, now);
    all.push(...r.events);
    assert.equal(r.view.status, "paused");
    now += Math.floor(rng() * 5000);
    r = { state: resume(r.state, now), events: [] };
  }
  const v = tick(plan, r.state, now).view;
  const expectedElapsed = Math.min(Math.max(runningMs / 1000 - plan.leadInSec, 0), plan.durationSec);
  assert.ok(Math.abs(v.elapsedSec - expectedElapsed) < 1e-9, `${v.elapsedSec} vs ${expectedElapsed}`);
  // Finish the run and check the whole event stream is intact.
  r = tick(plan, r.state, now + 3_600_000);
  all.push(...r.events);
  assertSameAsReference(plan, all, "pause/resume cycles");
});

test("pause: a nowMs earlier than the start counts as no time passed", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), T0 - 5000);
  const v = tick(plan, paused, T0 + 60_000).view;
  assert.equal(v.status, "paused");
  assert.equal(v.phase, "ready");
  assert.equal(v.phaseRemainingSec, 5);
  assert.equal(v.elapsedSec, 0);
});

test("pause: a tick earlier than the resume anchor counts as no time passed since the resume", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 3));
  const resumedAt = msAt(plan, 3) + 45_000;
  const v = tick(plan, resume(paused, resumedAt), resumedAt - 20_000).view;
  assert.equal(v.status, "running");
  assert.equal(v.elapsedSec, 3);
});

test("pause: resuming with a nowMs earlier than the pause does not rewind elapsed time", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 5));
  const earlier = msAt(plan, 5) - 4000;
  const v = tick(plan, resume(paused, earlier), earlier).view;
  assert.equal(v.elapsedSec, 5);
});

// ===========================================================================
// Clamping and time never running backwards
// ===========================================================================

test("clamp: a nowMs before the start gives the start of the lead-in", () => {
  const plan = buildPlan(fixture());
  const v = tick(plan, start(plan, T0), T0 - 20_000).view;
  assert.equal(v.phase, "ready");
  assert.equal(v.phaseRemainingSec, 5);
  assert.equal(v.totalRemainingSec, 50);
  assert.equal(v.elapsedSec, 0);
});

test("clamp: before the start no events are reported past the lead-in start", () => {
  const plan = buildPlan(fixture());
  const r = tick(plan, start(plan, T0), T0 - 20_000);
  assert.deepEqual(norm(r.events), [E.ready(-5, 0)]);
});

test("clamp: past the end is done with 0 remaining", () => {
  const plan = buildPlan(fixture());
  const r = tick(plan, start(plan, T0), farMs(plan));
  assert.equal(r.view.status, "done");
  assert.equal(r.view.phase, "done");
  assert.equal(r.view.phaseRemainingSec, 0);
  assert.equal(r.view.totalRemainingSec, 0);
  assert.equal(r.view.elapsedSec, 50);
});

test("clamp: no further events once the workout is done, however late the later ticks", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), farMs(plan));
  const b = tick(plan, a.state, farMs(plan) + 1);
  const c = tick(plan, b.state, farMs(plan) + 86_400_000);
  assert.deepEqual(b.events, []);
  assert.deepEqual(c.events, []);
  assert.equal(c.view.status, "done");
});

test("clamp: a tick that goes backwards in time reports nothing", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 20));
  const b = tick(plan, a.state, msAt(plan, 10));
  assert.deepEqual(b.events, []);
});

test("clamp: a backwards tick does not lower the cursor, so nothing is re-reported", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 20));
  const b = tick(plan, a.state, msAt(plan, 10));
  const c = tick(plan, b.state, msAt(plan, 20));
  assert.deepEqual(c.events, []);
  const d = tick(plan, c.state, msAt(plan, 26));
  assert.deepEqual(norm(d.events), norm(eventsBetween(plan, 20, 26)));
});

test("clamp: a backwards tick still reports the correct view for the given instant", () => {
  const plan = buildPlan(fixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 20));
  const b = tick(plan, a.state, msAt(plan, 10));
  assert.equal(b.view.phase, "rest");
  assert.equal(b.view.slotIndex, 0);
  assert.equal(b.view.elapsedSec, 10);
});

// ===========================================================================
// Display guarantees
// ===========================================================================

// Every 50ms plus the milliseconds either side of each whole second.
function sweepPoints(plan) {
  const set = new Set();
  const total = (plan.durationSec + plan.leadInSec + 2) * 1000;
  for (let ms = 0; ms <= total; ms += 50) set.add(ms);
  for (let s = 0; s <= total / 1000; s++) {
    for (const d of [-1, 0, 1]) if (s * 1000 + d >= 0) set.add(s * 1000 + d);
  }
  return [...set].sort((x, y) => x - y);
}

test("display: phaseRemainingSec is a positive integer for as long as the phase is not done", () => {
  for (const [plan, label] of [
    [buildPlan(fixture()), "fixture"],
    [buildPlan(shortFixture(), { leadInSec: 1 }), "short fixture"],
    [buildPlan(fixture(), { leadInSec: 0 }), "no lead-in"],
  ]) {
    for (const ms of sweepPoints(plan)) {
      const v = tick(plan, start(plan, T0), T0 + ms).view;
      if (v.phase === "done") {
        assert.equal(v.phaseRemainingSec, 0, `${label} +${ms}ms`);
      } else {
        assert.ok(Number.isInteger(v.phaseRemainingSec), `${label} +${ms}ms not an integer`);
        assert.ok(v.phaseRemainingSec >= 1, `${label} +${ms}ms shows ${v.phaseRemainingSec}`);
        assert.ok(v.phaseRemainingSec <= v.phaseDurationSec, `${label} +${ms}ms exceeds duration`);
      }
    }
  }
});

test("display: totalRemainingSec never increases as time advances and is 0 only when done", () => {
  for (const [plan, label] of [
    [buildPlan(fixture()), "fixture"],
    [buildPlan(shortFixture(), { leadInSec: 1 }), "short fixture"],
  ]) {
    let prev = Infinity;
    for (const ms of sweepPoints(plan)) {
      const v = tick(plan, start(plan, T0), T0 + ms).view;
      assert.ok(Number.isInteger(v.totalRemainingSec));
      assert.ok(v.totalRemainingSec <= prev, `${label} +${ms}ms: ${v.totalRemainingSec} > ${prev}`);
      assert.equal(v.totalRemainingSec === 0, v.status === "done", `${label} +${ms}ms`);
      prev = v.totalRemainingSec;
    }
  }
});

test("display: elapsedSec never decreases and stays inside [0, durationSec]", () => {
  const plan = buildPlan(fixture());
  let prev = 0;
  for (const ms of sweepPoints(plan)) {
    const v = tick(plan, start(plan, T0), T0 + ms).view;
    assert.ok(v.elapsedSec >= prev && v.elapsedSec <= plan.durationSec);
    prev = v.elapsedSec;
  }
});

test("display: each countdown event fires at the instant the shown number flips to n", () => {
  for (const plan of [buildPlan(fixture()), buildPlan(shortFixture(), { leadInSec: 1 })]) {
    const countdowns = fullEvents(plan).filter((e) => e.type === "countdown");
    assert.ok(countdowns.length > 0);
    for (const e of countdowns) {
      const at = tick(plan, start(plan, T0), msAt(plan, e.at)).view;
      assert.equal(at.phase, e.phase, `phase at ${e.at}`);
      assert.equal(at.slotIndex, e.slotIndex, `slot at ${e.at}`);
      assert.equal(at.phaseRemainingSec, e.n, `shown number at ${e.at}`);
      const before = tick(plan, start(plan, T0), msAt(plan, e.at) - 1).view;
      assert.equal(before.phase, e.phase, `phase just before ${e.at}`);
      assert.equal(before.phaseRemainingSec, e.n + 1, `shown number just before ${e.at}`);
    }
  }
});

test("display: the numbers 3, 2, 1 each appear in a long phase and 0 never does", () => {
  const plan = buildPlan(fixture());
  const shown = new Set();
  for (let sec = 40; sec < 50; sec += 0.25) shown.add(viewAt(plan, sec).phaseRemainingSec);
  assert.deepEqual([...shown].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

// ===========================================================================
// Purity
// ===========================================================================

test("purity: deep-frozen workout, plan and state are accepted by every function", () => {
  const workout = deepFreeze(fixture());
  const plan = deepFreeze(buildPlan(workout));
  assert.doesNotThrow(() => {
    const s = deepFreeze(start(plan, T0));
    const r = tick(plan, s, msAt(plan, 12));
    deepFreeze(r);
    const p = deepFreeze(pause(r.state, msAt(plan, 12)));
    const t = tick(plan, p, msAt(plan, 30));
    const res = deepFreeze(resume(t.state, msAt(plan, 31)));
    tick(plan, res, msAt(plan, 35));
    eventsBetween(plan, -Infinity, 20);
  });
});

test("purity: tick does not mutate the state it is given", () => {
  const plan = buildPlan(fixture());
  const s = start(plan, T0);
  const before = structuredClone(s);
  tick(plan, s, msAt(plan, 20));
  assert.deepEqual(s, before);
  // And the state still behaves as the original afterwards.
  const again = tick(plan, s, msAt(plan, 3));
  assert.deepEqual(norm(again.events.at(-1)), E.work(0, 0));
  assert.equal(again.view.elapsedSec, 3);
});

test("purity: re-ticking an old state replays the same events, since its cursor was not advanced", () => {
  const plan = buildPlan(fixture());
  const s = start(plan, T0);
  const a = tick(plan, s, msAt(plan, 12));
  const b = tick(plan, s, msAt(plan, 12));
  assert.deepEqual(b, a);
  assert.ok(a.events.length > 0);
});

test("purity: pause and resume do not mutate their input state", () => {
  const plan = buildPlan(fixture());
  const s = tick(plan, start(plan, T0), msAt(plan, 5)).state;
  const before = structuredClone(s);
  const p = pause(s, msAt(plan, 6));
  resume(p, msAt(plan, 20));
  assert.deepEqual(s, before);
  assert.equal(s.status, "running");
});

test("purity: tick does not mutate the plan", () => {
  const plan = buildPlan(fixture());
  const before = structuredClone(plan);
  tick(plan, start(plan, T0), farMs(plan));
  eventsBetween(plan, -Infinity, 50);
  assert.deepEqual(plan, before);
});

test("purity: the same inputs always give deep-equal outputs", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(buildPlan(fixture()), plan);
  assert.deepEqual(start(plan, T0), start(plan, T0));
  const s = start(plan, T0);
  assert.deepEqual(tick(plan, s, msAt(plan, 17)), tick(plan, s, msAt(plan, 17)));
  assert.deepEqual(pause(s, msAt(plan, 4)), pause(s, msAt(plan, 4)));
  const p = pause(s, msAt(plan, 4));
  assert.deepEqual(resume(p, msAt(plan, 9)), resume(p, msAt(plan, 9)));
  assert.deepEqual(eventsBetween(plan, 3, 30), eventsBetween(plan, 3, 30));
});

// ===========================================================================
// eventsBetween
// ===========================================================================

test("eventsBetween: excludes `from` and includes `to`", () => {
  const plan = buildPlan(fixture());
  // (10, 15]: rest-start at 10 is excluded, work-start at 15 is included.
  assert.deepEqual(norm(eventsBetween(plan, 10, 15)), [
    E.cd(12, 3, "rest", 0),
    E.cd(13, 2, "rest", 0),
    E.cd(14, 1, "rest", 0),
    E.work(15, 1, "left"),
  ]);
});

test("eventsBetween: a fractional window picks up only the event inside it", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(norm(eventsBetween(plan, 14.5, 15.5)), [E.work(15, 1, "left")]);
  assert.deepEqual(norm(eventsBetween(plan, 9.5, 10.5)), [E.rest(10, 0)]);
});

test("eventsBetween: -Infinity as the start includes events at exactly -leadInSec", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(norm(eventsBetween(plan, -Infinity, -5)), [E.ready(-5, 0)]);
  assert.deepEqual(norm(eventsBetween(plan, -Infinity, -4)), [E.ready(-5, 0)]);
});

test("eventsBetween: a finite start at -leadInSec excludes the ready event", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(norm(eventsBetween(plan, -5, -3)), [E.cd(-3, 3, "ready", null)]);
});

test("eventsBetween: returns an empty list when to <= from", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(eventsBetween(plan, 10, 10), []);
  assert.deepEqual(eventsBetween(plan, 30, 10), []);
  assert.deepEqual(eventsBetween(plan, -Infinity, -Infinity), []);
});

test("eventsBetween: a window after the end is empty, and the last second holds only done", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(eventsBetween(plan, 50, 500), []);
  assert.deepEqual(norm(eventsBetween(plan, 49, 50)), [E.done(50, 3)]);
});

test("eventsBetween: an Infinity end returns everything after the start", () => {
  const plan = buildPlan(fixture());
  assert.deepEqual(norm(eventsBetween(plan, 40, Infinity)), expectedFixtureEvents().filter((e) => e.at > 40));
});

test("eventsBetween: adjacent windows concatenate to the full list", () => {
  const plan = buildPlan(fixture());
  const cuts = [-Infinity, -4.5, -2, 0, 9.999, 10, 10, 25, 37.5, 49, 50, 100];
  const joined = [];
  for (let i = 1; i < cuts.length; i++) joined.push(...eventsBetween(plan, cuts[i - 1], cuts[i]));
  assert.deepEqual(norm(joined), norm(fullEvents(plan)));
});

test("eventsBetween: events come out ordered by time", () => {
  const plan = buildPlan(fixture());
  const ats = fullEvents(plan).map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
});

test("eventsBetween: does not mutate a frozen plan", () => {
  const plan = deepFreeze(buildPlan(fixture()));
  assert.doesNotThrow(() => eventsBetween(plan, -Infinity, 50));
});

// ===========================================================================
// Real generateWorkout output
// ===========================================================================

const optionSets = [
  ["defaults", {}],
  ["warm-up counted in total, with circuit", { warmup: { enabled: true, countsInTotal: true }, circuit: { size: 3, rounds: 2 } }],
  ["warm-up outside the total, with circuit", { warmup: { enabled: true, countsInTotal: false }, circuit: { size: 3, rounds: 2 } }],
  ["no warm-up, no circuit", { warmup: { enabled: false }, circuit: null }],
];

function realWorkouts(seedCount = 8) {
  const out = [];
  for (const [label, opts] of optionSets) {
    for (let seed = 1; seed <= seedCount; seed++) {
      out.push({ label: `${label} (seed ${seed})`, workout: generateWorkout(library, opts, mulberry32(seed)) });
    }
  }
  return out;
}

test("real workouts: plan.durationSec equals workout.durationSeconds", () => {
  for (const { label, workout } of realWorkouts()) {
    assert.equal(buildPlan(workout).durationSec, workout.durationSeconds, label);
  }
});

test("real workouts: the total countdown starts at the full session length, even when the warm-up is outside the requested total", () => {
  for (const { label, workout } of realWorkouts()) {
    const plan = buildPlan(workout);
    assert.equal(viewAt(plan, -plan.leadInSec).totalRemainingSec, workout.durationSeconds, label);
    assert.equal(viewAt(plan, 0).totalRemainingSec, workout.durationSeconds, label);
  }
});

test("real workouts: work-start plus side-swap events number one per slot", () => {
  for (const { label, workout } of realWorkouts()) {
    const starts = fullEvents(buildPlan(workout)).filter(
      (e) => e.type === "work-start" || e.type === "side-swap"
    );
    assert.equal(starts.length, workout.slots.length, label);
  }
});

test("real workouts: the work-start and side-swap events visit slots 0..n-1 in order", () => {
  for (const { label, workout } of realWorkouts()) {
    const indices = fullEvents(buildPlan(workout))
      .filter((e) => e.type === "work-start" || e.type === "side-swap")
      .map((e) => e.slotIndex);
    assert.deepEqual(indices, workout.slots.map((_, i) => i), label);
  }
});

test("real workouts: side-swap marks exactly the right-side slots", () => {
  for (const { label, workout } of realWorkouts()) {
    const plan = buildPlan(workout);
    const swaps = fullEvents(plan).filter((e) => e.type === "side-swap").map((e) => e.slotIndex);
    const rights = workout.slots.filter((s) => s.side === "right").map((s) => s.index);
    assert.deepEqual(swaps, rights, label);
  }
});

test("real workouts: each work-start or side-swap fires at its slot's startSec", () => {
  for (const { label, workout } of realWorkouts()) {
    const starts = fullEvents(buildPlan(workout)).filter(
      (e) => e.type === "work-start" || e.type === "side-swap"
    );
    for (const e of starts) assert.equal(e.at, workout.slots[e.slotIndex].startSec, label);
  }
});

test("real workouts: rest-start fires exactly after slots that have a rest, with the next slot named", () => {
  for (const { label, workout } of realWorkouts()) {
    const rests = fullEvents(buildPlan(workout)).filter((e) => e.type === "rest-start");
    const expected = workout.slots.filter((s) => s.restAfter > 0);
    assert.deepEqual(
      rests.map((e) => [e.slotIndex, e.at, e.nextSlotIndex]),
      expected.map((s) => [s.index, s.endSec, s.index + 1]),
      label
    );
  }
});

test("real workouts: done fires once, last, at the duration on the last slot", () => {
  for (const { label, workout } of realWorkouts()) {
    const plan = buildPlan(workout);
    const events = fullEvents(plan);
    assert.equal(events.filter((e) => e.type === "done").length, 1, label);
    assert.deepEqual(norm(events.at(-1)), E.done(plan.durationSec, workout.slots.length - 1), label);
  }
});

test("real workouts: events are ordered by time", () => {
  for (const { label, workout } of realWorkouts()) {
    const ats = fullEvents(buildPlan(workout)).map((e) => e.at);
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b), label);
  }
});

test("real workouts: every cadence delivers the same events exactly once", () => {
  for (const { label, workout } of realWorkouts(4)) {
    const plan = buildPlan(workout);
    for (const step of [1000, 7000]) {
      assertSameAsReference(plan, runTicks(plan, everyMs(plan, step)).events, `${label} step ${step}`);
    }
    for (let seed = 1; seed <= 3; seed++) {
      assertSameAsReference(plan, runTicks(plan, randomJumps(plan, seed)).events, `${label} jumps ${seed}`);
    }
    assertSameAsReference(plan, runTicks(plan, [farMs(plan)]).events, `${label} single tick`);
  }
});

test("real workouts: a 100ms cadence over a full generated workout matches the reference", () => {
  const workout = generateWorkout(library, optionSets[1][1], mulberry32(3));
  const plan = buildPlan(workout);
  assertSameAsReference(plan, runTicks(plan, everyMs(plan, 100)).events, "100ms");
});

test("real workouts: the phase sequence over the run is ready, then work/rest alternating, then done", () => {
  for (const { label, workout } of realWorkouts(3)) {
    const plan = buildPlan(workout);
    const phases = [];
    for (let sec = -plan.leadInSec; sec <= plan.durationSec; sec += 1) {
      const p = viewAt(plan, sec).phase;
      if (phases.at(-1) !== p) phases.push(p);
    }
    assert.equal(phases[0], "ready", label);
    assert.equal(phases.at(-1), "done", label);
    assert.ok(phases.slice(1, -1).every((p) => p === "work" || p === "rest"), label);
    assert.ok(!phases.includes("done") || phases.indexOf("done") === phases.length - 1, label);
  }
});

test("real workouts: the view tracks every slot, matching slot.side while working", () => {
  for (const { label, workout } of realWorkouts(3)) {
    const plan = buildPlan(workout);
    for (const slot of workout.slots) {
      const v = viewAt(plan, slot.startSec);
      assert.equal(v.phase, "work", label);
      assert.equal(v.slotIndex, slot.index, label);
      assert.equal(v.side, slot.side, label);
      assert.equal(v.phaseDurationSec, slot.workSeconds, label);
      assert.equal(v.phaseRemainingSec, slot.workSeconds, label);
      assert.equal(v.nextIsSideSwap, slot.side === "left", label);
    }
  }
});

// ===========================================================================
// Warm-up two-sided moves: one slot with side "alternate"
// ===========================================================================

// Like makeWorkout, but the first `warmCount` rows are in the warm-up section.
function makeWarmWorkout(rows, warmCount) {
  const w = makeWorkout(rows);
  w.slots.forEach((s, i) => {
    if (i < warmCount) {
      s.section = "warmup";
      s.blockId = "warmup";
    }
  });
  return w;
}

// Work 10s / rest 5s, default 5s lead-in. Timeline:
//   ready [-5,0)  work0(alternate) [0,10)  rest [10,15)  work1 [15,25)  rest [25,30)
//   work2(left) [30,40)  work3(right) [40,50)  rest [50,55)  work4 [55,65)    duration 65
// Slot 0 is a two-sided warm-up move: one slot, so one work segment and no side swap.
const warmFixture = () =>
  makeWarmWorkout(
    [
      ["bird-dog", "alternate", 10, 5],
      ["cat-cow", null, 10, 5],
      ["side-plank", "left", 10, 0],
      ["side-plank", "right", 10, 5],
      ["dead-bug", null, 10, 0],
    ],
    2
  );

// Two two-sided warm-up moves back to back, then one normal move.
//   ready [-5,0)  work0 [0,10)  rest [10,15)  work1(alternate) [15,25)  rest [25,30)  work2 [30,40)
const twoAlternateFixture = () =>
  makeWarmWorkout(
    [
      ["bird-dog", "alternate", 10, 5],
      ["reach-through", "alternate", 10, 5],
      ["dead-bug", null, 10, 0],
    ],
    2
  );

const nonCountdown = (plan) => fullEvents(plan).filter((e) => e.type !== "countdown");

test("warm-up alternate: the plan has one work segment for the slot, then a normal rest", () => {
  const plan = buildPlan(warmFixture());
  const seen = [];
  for (let sec = -5; sec < 65; sec += 0.5) {
    const v = viewAt(plan, sec);
    const key = `${v.phase}:${v.slotIndex}`;
    if (seen.at(-1) !== key) seen.push(key);
  }
  assert.deepEqual(seen, ["ready:null", "work:0", "rest:0", "work:1", "rest:1", "work:2", "work:3", "rest:3", "work:4"]);
});

test("warm-up alternate: its start event is work-start with side alternate, not side-swap", () => {
  const plan = buildPlan(warmFixture());
  const e = fullEvents(plan).filter((x) => x.slotIndex === 0 && (x.type === "work-start" || x.type === "side-swap"));
  assert.deepEqual(norm(e), [E.work(0, 0, "alternate")]);
});

test("warm-up alternate: no side-swap event exists for the slot, and the only swap in the plan is the main right side", () => {
  const plan = buildPlan(warmFixture());
  const swaps = fullEvents(plan).filter((e) => e.type === "side-swap");
  assert.deepEqual(norm(swaps), [E.swap(40, 3)]);
});

test("warm-up alternate: the full non-countdown event list for a workout with one alternate warm-up slot", () => {
  const plan = buildPlan(warmFixture());
  assert.deepEqual(norm(nonCountdown(plan)), [
    E.ready(-5, 0),
    E.work(0, 0, "alternate"),
    E.rest(10, 0),
    E.work(15, 1),
    E.rest(25, 1),
    E.work(30, 2, "left"),
    E.swap(40, 3),
    E.rest(50, 3),
    E.work(55, 4),
    E.done(65, 4),
  ]);
});

test("warm-up alternate: the slot gets the usual countdown 3, 2, 1 before its single work phase ends", () => {
  const plan = buildPlan(warmFixture());
  const cds = fullEvents(plan).filter((e) => e.type === "countdown" && e.slotIndex === 0 && e.phase === "work");
  assert.deepEqual(norm(cds), [E.cd(7, 3, "work", 0), E.cd(8, 2, "work", 0), E.cd(9, 1, "work", 0)]);
});

test("warm-up alternate: view.side is alternate for the whole work phase of the slot", () => {
  const plan = buildPlan(warmFixture());
  for (const sec of [0, 0.001, 3, 9.999]) {
    const v = viewAt(plan, sec);
    assert.equal(v.phase, "work", `at ${sec}`);
    assert.equal(v.slotIndex, 0);
    assert.equal(v.side, "alternate", `at ${sec}`);
  }
});

test("warm-up alternate: the view during the slot has the full single-interval duration and remaining time", () => {
  const plan = buildPlan(warmFixture());
  const v = viewAt(plan, 0);
  assert.equal(v.phaseDurationSec, 10);
  assert.equal(v.phaseRemainingSec, 10);
  assert.equal(viewAt(plan, 7).phaseRemainingSec, 3);
});

test("warm-up alternate: nextIsSideSwap is false while it is the current slot, and next is the following move", () => {
  const plan = buildPlan(warmFixture());
  const v = viewAt(plan, 3);
  assert.equal(v.nextIsSideSwap, false);
  assert.equal(v.next.exerciseId, "cat-cow");
});

test("warm-up alternate: nextIsSideSwap is false in the rest before it and when it is the next slot", () => {
  const plan = buildPlan(twoAlternateFixture());
  const rest = viewAt(plan, 12);
  assert.equal(rest.phase, "rest");
  assert.equal(rest.next.side, "alternate");
  assert.equal(rest.nextIsSideSwap, false);
  const work0 = viewAt(plan, 3);
  assert.equal(work0.next.side, "alternate");
  assert.equal(work0.nextIsSideSwap, false);
});

test("warm-up alternate: nextIsSideSwap is false during the lead-in when the first slot is alternate", () => {
  const plan = buildPlan(twoAlternateFixture());
  const v = viewAt(plan, -3);
  assert.equal(v.phase, "ready");
  assert.equal(v.next.side, "alternate");
  assert.equal(v.nextIsSideSwap, false);
});

test("warm-up alternate: two alternate slots in a row give two work-starts and no side-swap", () => {
  const plan = buildPlan(twoAlternateFixture());
  assert.deepEqual(norm(nonCountdown(plan)), [
    E.ready(-5, 0),
    E.work(0, 0, "alternate"),
    E.rest(10, 0),
    E.work(15, 1, "alternate"),
    E.rest(25, 1),
    E.work(30, 2),
    E.done(40, 2),
  ]);
});

test("main two-sided moves still produce work-start for left then side-swap for right (next to a warm-up alternate slot)", () => {
  const plan = buildPlan(warmFixture());
  const starts = fullEvents(plan).filter((e) => e.type === "work-start" || e.type === "side-swap");
  assert.deepEqual(
    norm(starts.filter((e) => e.slotIndex >= 2 && e.slotIndex <= 3)),
    [E.work(30, 2, "left"), E.swap(40, 3)]
  );
  // The left side still flags the upcoming swap; the right side does not.
  assert.equal(viewAt(plan, 32).nextIsSideSwap, true);
  assert.equal(viewAt(plan, 42).nextIsSideSwap, false);
});

test("warm-up alternate: events are still delivered exactly once at any cadence", () => {
  const plan = buildPlan(warmFixture());
  const reference = norm(fullEvents(plan));
  for (const step of [250, 1000, 7000]) {
    const { events } = runTicks(plan, everyMs(plan, step));
    assert.deepEqual(norm(events), reference, `step ${step}`);
  }
  assert.deepEqual(norm(runTicks(plan, [farMs(plan)]).events), reference);
});

// A real generateWorkout whose warm-up pool is two two-sided moves.
const mkEx = (id, over = {}) => ({
  id,
  name: `Move ${id}`,
  focus: ["full"],
  position: "back",
  pattern: "static",
  difficulty: 1,
  perSide: false,
  formCue: "cue",
  ...over,
});
const PATTERNS = ["static", "dynamic", "rotational"];
const twoSidedWarmLib = [
  mkEx("wa", { warmup: "only", perSide: true }),
  mkEx("wb", { warmup: "only", perSide: true, pattern: "dynamic" }),
  ...Array.from({ length: 12 }, (_, i) => mkEx(`m${i + 1}`, { pattern: PATTERNS[i % 3], perSide: i % 3 === 0 })),
];
const warmGen = (seed) =>
  generateWorkout(
    twoSidedWarmLib,
    { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null, warmup: { enabled: true } },
    mulberry32(seed)
  );

test("real two-sided warm-up: the warm-up slots start with work-start events carrying side alternate", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const workout = warmGen(seed);
    const warmIdx = workout.slots.filter((s) => s.section === "warmup").map((s) => s.index);
    assert.deepEqual(warmIdx, [0, 1], `seed ${seed}`);
    const starts = fullEvents(buildPlan(workout)).filter((e) => e.type === "work-start" || e.type === "side-swap");
    for (const i of warmIdx) {
      assert.deepEqual(
        norm(starts.find((e) => e.slotIndex === i)),
        E.work(workout.slots[i].startSec, i, "alternate"),
        `seed ${seed} slot ${i}`
      );
    }
  }
});

test("real two-sided warm-up: side-swap events mark exactly the main right-side slots and none of the warm-up", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const workout = warmGen(seed);
    const swaps = fullEvents(buildPlan(workout)).filter((e) => e.type === "side-swap").map((e) => e.slotIndex);
    const rights = workout.slots.filter((s) => s.section === "main" && s.side === "right").map((s) => s.index);
    assert.deepEqual(swaps, rights, `seed ${seed}`);
    assert.ok(swaps.every((i) => workout.slots[i].section === "main"));
  }
});

test("real two-sided warm-up: the view reports side alternate for each warm-up slot and nextIsSideSwap stays false there", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const workout = warmGen(seed);
    const plan = buildPlan(workout);
    for (const slot of workout.slots.filter((s) => s.section === "warmup")) {
      const v = viewAt(plan, slot.startSec);
      assert.equal(v.phase, "work");
      assert.equal(v.slotIndex, slot.index);
      assert.equal(v.side, "alternate", `seed ${seed}`);
      assert.equal(v.phaseDurationSec, slot.workSeconds);
      assert.equal(v.nextIsSideSwap, false, `seed ${seed} slot ${slot.index}`);
    }
  }
});

test("real two-sided warm-up: the plan lasts the full workout duration and shows the full total at the start", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const workout = warmGen(seed);
    const plan = buildPlan(workout);
    assert.equal(plan.durationSec, 600, `seed ${seed}`);
    assert.equal(viewAt(plan, 0).totalRemainingSec, 600);
  }
});

// ===========================================================================
// Warning event: "10 seconds left" in a work interval
// ===========================================================================

// Work intervals longer than 10 s, so every work segment gets a warning except
// the last one (exactly 10 s). Default 5 s lead-in. Timeline:
//   ready [-5,0)  work0 [0,15)  rest [15,20)  work1(left) [20,32)
//   work2(right) [32,43)  rest [43,48)  work3 [48,58)                 duration 58
const longFixture = () =>
  makeWorkout([
    ["a", null, 15, 5],
    ["b", "left", 12, 0],
    ["b", "right", 11, 5],
    ["c", null, 10, 0],
  ]);

const expectedLongFixtureEvents = () => [
  E.ready(-5, 0),
  E.cd(-3, 3, "ready", null),
  E.cd(-2, 2, "ready", null),
  E.cd(-1, 1, "ready", null),
  E.work(0, 0),
  E.warn(5, 0),
  E.cd(12, 3, "work", 0),
  E.cd(13, 2, "work", 0),
  E.cd(14, 1, "work", 0),
  E.rest(15, 0),
  E.cd(17, 3, "rest", 0),
  E.cd(18, 2, "rest", 0),
  E.cd(19, 1, "rest", 0),
  E.work(20, 1, "left"),
  E.warn(22, 1),
  E.cd(29, 3, "work", 1),
  E.cd(30, 2, "work", 1),
  E.cd(31, 1, "work", 1),
  E.swap(32, 2),
  E.warn(33, 2),
  E.cd(40, 3, "work", 2),
  E.cd(41, 2, "work", 2),
  E.cd(42, 1, "work", 2),
  E.rest(43, 2),
  E.cd(45, 3, "rest", 2),
  E.cd(46, 2, "rest", 2),
  E.cd(47, 1, "rest", 2),
  E.work(48, 3),
  E.cd(55, 3, "work", 3),
  E.cd(56, 2, "work", 3),
  E.cd(57, 1, "work", 3),
  E.done(58, 3),
];

test("warning: every work segment longer than 10 s gets one warning 10 s before it ends, and the exact ordered list is right", () => {
  const plan = buildPlan(longFixture());
  assert.deepEqual(norm(fullEvents(plan)), expectedLongFixtureEvents());
});

test("warning: the event carries type, at, n 10, phase work and the slot index", () => {
  const plan = buildPlan(longFixture());
  const w = fullEvents(plan).filter((e) => e.type === "warning");
  assert.deepEqual(norm(w), [E.warn(5, 0), E.warn(22, 1), E.warn(33, 2)]);
});

test("warning: a work interval of exactly 10 s gets none (it would fire on the work start)", () => {
  const plan = buildPlan(longFixture());
  assert.ok(!fullEvents(plan).some((e) => e.type === "warning" && e.slotIndex === 3));
  // And the existing 10 s fixture has no warnings at all.
  assert.ok(!fullEvents(buildPlan(fixture())).some((e) => e.type === "warning"));
});

test("warning: work intervals of 9 and 10 s get none and 11 s gets one a second after the start", () => {
  const plan = buildPlan(
    makeWorkout([
      ["a", null, 9, 5],
      ["b", null, 10, 5],
      ["c", null, 11, 0],
    ]),
    { leadInSec: 0 }
  );
  const w = fullEvents(plan).filter((e) => e.type === "warning");
  assert.deepEqual(norm(w), [E.warn(30, 2)]); // c runs [29,40)
});

test("warning: never emitted for a long rest or a long lead-in", () => {
  const plan = buildPlan(
    makeWorkout([
      ["a", null, 12, 15],
      ["b", null, 10, 0],
    ]),
    { leadInSec: 15 }
  );
  const w = fullEvents(plan).filter((e) => e.type === "warning");
  assert.deepEqual(norm(w), [E.warn(2, 0)]);
  assert.ok(w.every((e) => e.phase === "work"));
});

test("warning: warm-up alternate slots longer than 10 s get a warning like any other work interval", () => {
  const workout = makeWarmWorkout(
    [
      ["bird-dog", "alternate", 20, 5],
      ["dead-bug", null, 20, 0],
    ],
    1
  );
  const w = fullEvents(buildPlan(workout)).filter((e) => e.type === "warning");
  assert.deepEqual(norm(w), [E.warn(10, 0), E.warn(35, 1)]);
});

test("warning: a tick reports it once, in order, between the surrounding events", () => {
  const plan = buildPlan(longFixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 4.9));
  assert.ok(!a.events.some((e) => e.type === "warning"));
  const b = tick(plan, a.state, msAt(plan, 5));
  assert.deepEqual(norm(b.events), [E.warn(5, 0)]);
  const c = tick(plan, b.state, msAt(plan, 12));
  assert.deepEqual(norm(c.events), [E.cd(12, 3, "work", 0)]);
});

test("warning: eventsBetween includes it like any other event", () => {
  const plan = buildPlan(longFixture());
  assert.deepEqual(norm(eventsBetween(plan, 4, 6)), [E.warn(5, 0)]);
  assert.deepEqual(norm(eventsBetween(plan, 21, 23)), [E.warn(22, 1)]);
});

test("warning: the shown phase countdown reads 10 when the warning fires", () => {
  const plan = buildPlan(longFixture());
  const warnings = fullEvents(plan).filter((x) => x.type === "warning");
  assert.equal(warnings.length, 3);
  for (const e of warnings) {
    const v = viewAt(plan, e.at);
    assert.equal(v.phase, "work");
    assert.equal(v.slotIndex, e.slotIndex);
    assert.equal(v.phaseRemainingSec, 10);
  }
});

test("warning: throttling invariance, every cadence delivers the exact long-fixture list once", () => {
  const plan = buildPlan(longFixture());
  for (const step of [50, 100, 1000, 7000]) {
    assertSameAsReference(plan, runTicks(plan, everyMs(plan, step)).events, `step ${step}`);
    assert.deepEqual(norm(runTicks(plan, everyMs(plan, step)).events), expectedLongFixtureEvents(), `step ${step}`);
  }
  assert.deepEqual(norm(runTicks(plan, [farMs(plan)]).events), expectedLongFixtureEvents());
  for (let seed = 1; seed <= 25; seed++) {
    assertSameAsReference(plan, runTicks(plan, randomJumps(plan, seed)).events, `seed ${seed}`);
  }
});

test("warning: a throttled page still gets the missed warning on its next tick", () => {
  const plan = buildPlan(longFixture());
  const a = tick(plan, start(plan, T0), msAt(plan, 2));
  const b = tick(plan, a.state, msAt(plan, 8)); // 6 s gap straddles the warning at 5
  assert.deepEqual(norm(b.events), [E.warn(5, 0)]);
});

test("warning: events are not duplicated or lost across a pause and resume that straddles one", () => {
  const plan = buildPlan(longFixture());
  const out = [];
  let r = tick(plan, start(plan, T0), msAt(plan, 4)); // just before the warning at 5
  out.push(...r.events);
  const s = pause(r.state, msAt(plan, 4));
  r = tick(plan, s, msAt(plan, 4) + 90_000);
  out.push(...r.events);
  const resumedAt = msAt(plan, 4) + 120_000;
  r = tick(plan, resume(r.state, resumedAt), resumedAt + 1000); // workout 5.0: warning fires now
  out.push(...r.events);
  assert.deepEqual(norm(r.events), [E.warn(5, 0)]);
  r = tick(plan, r.state, resumedAt + 3_600_000);
  out.push(...r.events);
  assertSameAsReference(plan, out, "across a pause");
  assert.deepEqual(norm(out), expectedLongFixtureEvents());
});

test("warning: pause/resume cycles with a warning in play keep the event stream intact", () => {
  const plan = buildPlan(longFixture());
  for (let seed = 1; seed <= 20; seed++) {
    const rng = mulberry32(seed);
    let now = T0;
    let r = { state: start(plan, T0), events: [] };
    const all = [];
    for (let i = 0; i < 8; i++) {
      now += 500 + Math.floor(rng() * 9000);
      r = tick(plan, r.state, now);
      all.push(...r.events);
      const paused = pause(r.state, now);
      now += 1000 + Math.floor(rng() * 60_000);
      r = tick(plan, paused, now);
      all.push(...r.events);
      r = { state: resume(r.state, now), events: [] };
    }
    r = tick(plan, r.state, now + 3_600_000);
    all.push(...r.events);
    assertSameAsReference(plan, all, `seed ${seed}`);
    assert.equal(all.filter((e) => e.type === "warning").length, 3, `seed ${seed}`);
  }
});

test("real workouts: warning events are exactly one per work slot longer than 10 s, at endSec - 10", () => {
  for (const { label, workout } of realWorkouts()) {
    const warnings = fullEvents(buildPlan(workout)).filter((e) => e.type === "warning");
    const expected = workout.slots
      .filter((s) => s.endSec - s.startSec > 10)
      .map((s) => E.warn(s.endSec - 10, s.index));
    assert.deepEqual(norm(warnings), expected, label);
  }
});

test("real workouts: a warning always lies strictly inside its work interval and the list stays time-ordered", () => {
  for (const { label, workout } of realWorkouts()) {
    const events = fullEvents(buildPlan(workout));
    const warnings = events.filter((x) => x.type === "warning");
    assert.ok(warnings.length > 0, `${label}: expected warnings`);
    for (const e of warnings) {
      const slot = workout.slots[e.slotIndex];
      assert.ok(e.at > slot.startSec && e.at < slot.endSec, label);
    }
    const ats = events.map((e) => e.at);
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b), label);
  }
});

test("real workouts: events including warnings are delivered exactly once at every cadence", () => {
  for (const { label, workout } of realWorkouts(3)) {
    const plan = buildPlan(workout);
    assert.ok(fullEvents(plan).some((e) => e.type === "warning"), `${label}: expected warnings in this run`);
    for (const step of [100, 1000, 7000]) {
      assertSameAsReference(plan, runTicks(plan, everyMs(plan, step)).events, `${label} step ${step}`);
    }
    assertSameAsReference(plan, runTicks(plan, randomJumps(plan, 5)).events, `${label} jumps`);
  }
});

// ===========================================================================
// view.positionSec: signed workout time, negative during the lead-in
// ===========================================================================

test("positionSec: the very start of the lead-in is -leadInSec", () => {
  const plan = buildPlan(fixture());
  assert.equal(viewAt(plan, -5).positionSec, -5);
});

test("positionSec: it is negative during the lead-in, while elapsedSec stays 0", () => {
  const plan = buildPlan(fixture());
  const v = viewAt(plan, -3.5);
  assert.equal(v.positionSec, -3.5);
  assert.equal(v.elapsedSec, 0);
  const late = viewAt(plan, -0.5);
  assert.equal(late.positionSec, -0.5);
  assert.equal(late.elapsedSec, 0);
});

test("positionSec: the lead-in length follows leadInSec", () => {
  const plan = buildPlan(fixture(), { leadInSec: 3 });
  assert.equal(tick(plan, start(plan, T0), T0).view.positionSec, -3);
  assert.equal(tick(plan, start(plan, T0), T0 + 1000).view.positionSec, -2);
});

test("positionSec: it is 0 at the first move and equals elapsedSec from then on", () => {
  const plan = buildPlan(fixture());
  for (const sec of [0, 0.001, 3.5, 12.25, 25, 49.999]) {
    const v = viewAt(plan, sec);
    assert.equal(v.positionSec, sec, `at ${sec}`);
    assert.equal(v.positionSec, v.elapsedSec, `at ${sec}`);
  }
});

test("positionSec: with no lead-in the run starts at 0", () => {
  const plan = buildPlan(fixture(), { leadInSec: 0 });
  assert.equal(tick(plan, start(plan, T0), T0).view.positionSec, 0);
});

test("positionSec: a nowMs before the start is the start of the lead-in, not lower", () => {
  const plan = buildPlan(fixture());
  assert.equal(tick(plan, start(plan, T0), T0 - 20_000).view.positionSec, -5);
});

test("positionSec: the done view reports durationSec, and so does a tick long after the end", () => {
  const plan = buildPlan(fixture());
  assert.equal(viewAt(plan, 50).positionSec, 50);
  assert.equal(viewAt(plan, 500).positionSec, 50);
  assert.equal(tick(plan, start(plan, T0), farMs(plan)).view.positionSec, 50);
});

test("positionSec: it is frozen while paused, during the lead-in and during the workout", () => {
  const plan = buildPlan(fixture());
  const inLeadIn = tick(plan, pause(start(plan, T0), msAt(plan, -3)), msAt(plan, -3) + 99_000).view;
  assert.equal(inLeadIn.status, "paused");
  assert.equal(inLeadIn.positionSec, -3);
  const inWork = tick(plan, pause(start(plan, T0), msAt(plan, 12.5)), msAt(plan, 40)).view;
  assert.equal(inWork.positionSec, 12.5);
});

test("positionSec: resuming continues from the frozen point", () => {
  const plan = buildPlan(fixture());
  const paused = pause(start(plan, T0), msAt(plan, 3));
  const resumedAt = msAt(plan, 3) + 45_000;
  assert.equal(tick(plan, resume(paused, resumedAt), resumedAt).view.positionSec, 3);
  assert.equal(tick(plan, resume(paused, resumedAt), resumedAt + 2500).view.positionSec, 5.5);
});

test("positionSec: it never decreases across a sweep, and ends at durationSec", () => {
  const plan = buildPlan(fixture());
  let prev = -Infinity;
  for (const ms of sweepPoints(plan)) {
    const v = tick(plan, start(plan, T0), T0 + ms).view;
    assert.ok(Number.isFinite(v.positionSec));
    assert.ok(v.positionSec >= prev, `+${ms}ms`);
    assert.ok(v.positionSec >= -plan.leadInSec && v.positionSec <= plan.durationSec, `+${ms}ms`);
    prev = v.positionSec;
  }
  assert.equal(prev, plan.durationSec);
});

test("positionSec: the position of a tick is at or after every event that tick reports", () => {
  const plan = buildPlan(longFixture());
  for (const step of [100, 1000, 7000]) {
    let state = start(plan, T0);
    for (const now of everyMs(plan, step)) {
      const r = tick(plan, state, now);
      state = r.state;
      for (const e of r.events) assert.ok(e.at <= r.view.positionSec, `step ${step}: ${e.type} at ${e.at}`);
    }
  }
});
