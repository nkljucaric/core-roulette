import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeRunner } from "../src/runner.js";
import { buildPlan, start, pause, tick } from "../src/timer.js";
import { generateWorkout } from "../src/generator.js";

// Logic-layer tests for describeRunner (issue #10). describeRunner(view,
// workout, library) turns the timer's `tick(...).view` into everything the run
// screen shows: { phase, phaseLabel, paused, phaseRemainingSec, totalRemainingSec,
// progress, title, sideLabel, sectionLabel, formCue, upNext }.
//
// The "shown slot" is the move the screen is about: view.slot during work,
// view.next during get-ready and rest (the upcoming move), and none when done.
// Title, side, section and form cue all come from the shown slot. upNext is only
// set during work.

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

const seeds = (n) => Array.from({ length: n }, (_, i) => i + 1);

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Hand-built workouts with the same shape generateWorkout returns
// ---------------------------------------------------------------------------

// slotSpecs: [exerciseId, section, blockId, round, side, workSeconds, restAfter]
// blockSpecs: [id, kind, rounds]
// A slot starts when the previous slot's work and rest are over.
function fixture(slotSpecs, blockSpecs) {
  let cursor = 0;
  const slots = slotSpecs.map(([exerciseId, section, blockId, round, side, work, rest], index) => {
    const slot = {
      index,
      exerciseId,
      name: `Name ${exerciseId}`,
      section,
      blockId,
      round,
      side,
      workSeconds: work,
      restAfter: rest,
      startSec: cursor,
      endSec: cursor + work,
    };
    cursor += work + rest;
    return slot;
  });
  const blocks = blockSpecs.map(([id, kind, rounds]) => {
    const idx = slots.filter((s) => s.blockId === id).map((s) => s.index);
    return { id, kind, rounds, firstSlot: idx[0], lastSlot: idx[idx.length - 1] };
  });
  const last = slots[slots.length - 1];
  return {
    options: { totalSeconds: last.endSec, workSeconds: 10, restSeconds: 5 },
    randomized: [],
    durationSeconds: last.endSec,
    slots,
    blocks,
    warnings: [],
  };
}

// Work 10s / rest 5s everywhere except where noted. With the default 5s lead-in
// the timeline (workout seconds, 0 = first move starts) is:
//   slot 0  wu-a      warm-up, alternate      work [0,10)    rest [10,15)
//   slot 1  wu-b      warm-up                 work [15,25)   rest [25,30)
//   slot 2  mv-a      main                    work [30,40)   rest [40,45)
//   slot 3  side-m    main, left              work [45,55)   (no rest)
//   slot 4  side-m    main, right             work [55,65)   rest [65,70)
//   slot 5  circ-a    circuit round 1 of 2    work [70,80)   rest [80,85)
//   slot 6  circ-b    circuit round 1 of 2    work [85,95)   rest [95,100)
//   slot 7  circ-a    circuit round 2 of 2    work [100,110) rest [110,115)
//   slot 8  circ-b    circuit round 2 of 2    work [115,125) rest [125,130)
//   slot 9  mv-final  main                    work [130,140) (no rest)   total 140
const fullWorkout = () =>
  fixture(
    [
      ["wu-a", "warmup", "warmup", 1, "alternate", 10, 5],
      ["wu-b", "warmup", "warmup", 1, null, 10, 5],
      ["mv-a", "main", "straight-1", 1, null, 10, 5],
      ["side-m", "main", "straight-1", 1, "left", 10, 0],
      ["side-m", "main", "straight-1", 1, "right", 10, 5],
      ["circ-a", "main", "circuit", 1, null, 10, 5],
      ["circ-b", "main", "circuit", 1, null, 10, 5],
      ["circ-a", "main", "circuit", 2, null, 10, 5],
      ["circ-b", "main", "circuit", 2, null, 10, 5],
      ["mv-final", "main", "straight-2", 1, null, 10, 0],
    ],
    [
      ["warmup", "warmup", 1],
      ["straight-1", "straight", 1],
      ["circuit", "circuit", 2],
      ["straight-2", "straight", 1],
    ]
  );

// circ-b deliberately has no formCue; mv-final is deliberately absent.
const fixtureLibrary = () => [
  { id: "wu-a", name: "Wu A", formCue: "Cue wu-a" },
  { id: "wu-b", name: "Wu B", formCue: "Cue wu-b" },
  { id: "mv-a", name: "Mv A", formCue: "Cue mv-a" },
  { id: "side-m", name: "Side M", formCue: "Cue side-m" },
  { id: "circ-a", name: "Circ A", formCue: "Cue circ-a" },
  { id: "circ-b", name: "Circ B" },
];

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

const T0 = 1_000_000;
// nowMs at which the workout clock reads `sec` when the run started at T0.
const msAt = (plan, sec) => T0 + Math.round((sec + plan.leadInSec) * 1000);

// A real view straight from the timer, `sec` workout-seconds into the run.
const viewAt = (plan, sec) => tick(plan, start(plan, T0), msAt(plan, sec)).view;

// A real paused view: run to `sec`, pause there, then read a later clock.
function pausedViewAt(plan, sec) {
  const s = tick(plan, start(plan, T0), msAt(plan, sec)).state;
  const paused = pause(s, msAt(plan, sec));
  return tick(plan, paused, msAt(plan, sec) + 60_000).view;
}

const run = (workout, sec, lib = library) => describeRunner(viewAt(buildPlan(workout), sec), workout, lib);

// ---------------------------------------------------------------------------
// Phase and label mapping
// ---------------------------------------------------------------------------

test("start of the lead-in is GET READY with the first move as the title and the full lead-in remaining", () => {
  const w = fullWorkout();
  const r = run(w, -5, fixtureLibrary());
  assert.equal(r.phase, "ready");
  assert.equal(r.phaseLabel, "GET READY");
  assert.equal(r.paused, false);
  assert.equal(r.phaseRemainingSec, 5);
  assert.equal(r.totalRemainingSec, 140);
  assert.equal(r.title, "Name wu-a");
  assert.equal(r.upNext, null);
});

test("mid lead-in is still GET READY and counts the lead-in down", () => {
  const w = fullWorkout();
  const r = run(w, -3, fixtureLibrary());
  assert.equal(r.phase, "ready");
  assert.equal(r.phaseLabel, "GET READY");
  assert.equal(r.phaseRemainingSec, 3);
  assert.equal(r.title, "Name wu-a");
});

test("get-ready shows the first move's side, section and form cue", () => {
  const w = fullWorkout();
  const r = run(w, -2, fixtureLibrary());
  assert.equal(r.sideLabel, "Alternate sides");
  assert.equal(r.sectionLabel, "Warm-up");
  assert.equal(r.formCue, "Cue wu-a");
});

test("get-ready for a workout that starts with a plain main move has no side and no section label", () => {
  const w = fixture([["mv-a", "main", "straight-1", 1, null, 10, 0]], [["straight-1", "straight", 1]]);
  const r = run(w, -4, fixtureLibrary());
  assert.equal(r.title, "Name mv-a");
  assert.equal(r.sideLabel, null);
  assert.equal(r.sectionLabel, null);
});

test("the instant work begins the phase is WORK and the title is the current move", () => {
  const w = fullWorkout();
  const r = run(w, 0, fixtureLibrary());
  assert.equal(r.phase, "work");
  assert.equal(r.phaseLabel, "WORK");
  assert.equal(r.title, "Name wu-a");
  assert.equal(r.phaseRemainingSec, 10);
  assert.equal(r.totalRemainingSec, 140);
});

test("mid work passes the timer's remaining times straight through", () => {
  const w = fullWorkout();
  const plan = buildPlan(w);
  const view = viewAt(plan, 34);
  const r = describeRunner(view, w, fixtureLibrary());
  assert.equal(r.phase, "work");
  assert.equal(r.title, "Name mv-a");
  assert.equal(r.phaseRemainingSec, view.phaseRemainingSec);
  assert.equal(r.totalRemainingSec, view.totalRemainingSec);
  assert.equal(r.phaseRemainingSec, 6);
  assert.equal(r.totalRemainingSec, 106);
  assert.equal(r.paused, false);
});

test("during work the up-next line names the following move", () => {
  const w = fullWorkout();
  const r = run(w, 34, fixtureLibrary());
  assert.deepEqual(r.upNext, { kind: "move", text: "Name side-m" });
});

test("during work the shown form cue is the current move's", () => {
  const w = fullWorkout();
  assert.equal(run(w, 34, fixtureLibrary()).formCue, "Cue mv-a");
});

test("rest is labelled REST and shows the upcoming move as the title", () => {
  const w = fullWorkout();
  const r = run(w, 41, fixtureLibrary()); // rest after mv-a, before side-m
  assert.equal(r.phase, "rest");
  assert.equal(r.phaseLabel, "REST");
  assert.equal(r.title, "Name side-m");
  assert.equal(r.phaseRemainingSec, 4);
  assert.equal(r.formCue, "Cue side-m");
});

test("the instant a rest begins it is REST, not WORK", () => {
  const w = fullWorkout();
  const r = run(w, 40, fixtureLibrary());
  assert.equal(r.phaseLabel, "REST");
  assert.equal(r.phaseRemainingSec, 5);
});

test("up-next is null during rest, because the title already names the next move", () => {
  const w = fullWorkout();
  assert.equal(run(w, 41, fixtureLibrary()).upNext, null);
});

test("rest before a two-sided move shows the next slot's side, Left side", () => {
  const w = fullWorkout();
  const r = run(w, 42, fixtureLibrary());
  assert.equal(r.phase, "rest");
  assert.equal(r.title, "Name side-m");
  assert.equal(r.sideLabel, "Left side");
});

test("rest after a two-sided move shows the following move with no side label", () => {
  const w = fullWorkout();
  const r = run(w, 66, fixtureLibrary()); // rest after side-m right, before circ-a
  assert.equal(r.phase, "rest");
  assert.equal(r.title, "Name circ-a");
  assert.equal(r.sideLabel, null);
});

test("the left side of a two-sided move shows Left side and warns that the swap is next", () => {
  const w = fullWorkout();
  const r = run(w, 50, fixtureLibrary());
  assert.equal(r.phase, "work");
  assert.equal(r.title, "Name side-m");
  assert.equal(r.sideLabel, "Left side");
  assert.deepEqual(r.upNext, { kind: "side-swap", text: "Switch to right side" });
});

test("the instant the left side ends the right side starts as Right side with no rest between", () => {
  const w = fullWorkout();
  const r = run(w, 55, fixtureLibrary());
  assert.equal(r.phase, "work");
  assert.equal(r.title, "Name side-m");
  assert.equal(r.sideLabel, "Right side");
  assert.equal(r.phaseRemainingSec, 10);
});

test("the right side's up-next is the move after the pair, not another swap", () => {
  const w = fullWorkout();
  const r = run(w, 60, fixtureLibrary());
  assert.deepEqual(r.upNext, { kind: "move", text: "Name circ-a" });
});

test("the last second of the left side is still Left side with the swap cue", () => {
  const w = fullWorkout();
  const r = run(w, 54, fixtureLibrary());
  assert.equal(r.sideLabel, "Left side");
  assert.equal(r.upNext.kind, "side-swap");
});

test("a warm-up move that alternates sides shows Alternate sides and the Warm-up label", () => {
  const w = fullWorkout();
  const r = run(w, 5, fixtureLibrary());
  assert.equal(r.phase, "work");
  assert.equal(r.title, "Name wu-a");
  assert.equal(r.sideLabel, "Alternate sides");
  assert.equal(r.sectionLabel, "Warm-up");
  assert.deepEqual(r.upNext, { kind: "move", text: "Name wu-b" });
});

test("a plain warm-up move has the Warm-up label and no side label", () => {
  const w = fullWorkout();
  const r = run(w, 20, fixtureLibrary());
  assert.equal(r.title, "Name wu-b");
  assert.equal(r.sideLabel, null);
  assert.equal(r.sectionLabel, "Warm-up");
});

test("the rest between the warm-up and the main set labels the upcoming main move, not Warm-up", () => {
  const w = fullWorkout();
  const r = run(w, 27, fixtureLibrary()); // rest after wu-b, before mv-a
  assert.equal(r.phase, "rest");
  assert.equal(r.title, "Name mv-a");
  assert.equal(r.sectionLabel, null);
});

test("the rest between two warm-up moves is labelled Warm-up", () => {
  const w = fullWorkout();
  const r = run(w, 12, fixtureLibrary()); // rest after wu-a, before wu-b
  assert.equal(r.phase, "rest");
  assert.equal(r.title, "Name wu-b");
  assert.equal(r.sectionLabel, "Warm-up");
});

test("a main-set move in a straight block has no section label", () => {
  const w = fullWorkout();
  assert.equal(run(w, 34, fixtureLibrary()).sectionLabel, null);
  assert.equal(run(w, 135, fixtureLibrary()).sectionLabel, null);
});

test("a circuit move in round 1 is labelled with its round and the block's total rounds", () => {
  const w = fullWorkout();
  const r = run(w, 75, fixtureLibrary());
  assert.equal(r.title, "Name circ-a");
  assert.equal(r.sectionLabel, "Circuit, round 1 of 2");
});

test("a circuit move in round 2 is labelled round 2 of 2", () => {
  const w = fullWorkout();
  const r = run(w, 105, fixtureLibrary());
  assert.equal(r.title, "Name circ-a");
  assert.equal(r.sectionLabel, "Circuit, round 2 of 2");
  assert.deepEqual(r.upNext, { kind: "move", text: "Name circ-b" });
});

test("the rest between circuit rounds shows the next round's number", () => {
  const w = fullWorkout();
  const r = run(w, 97, fixtureLibrary()); // rest after circ-b round 1, before circ-a round 2
  assert.equal(r.phase, "rest");
  assert.equal(r.title, "Name circ-a");
  assert.equal(r.sectionLabel, "Circuit, round 2 of 2");
});

test("the rest after the circuit's last move labels the main-set move that follows with no circuit text", () => {
  const w = fullWorkout();
  const r = run(w, 127, fixtureLibrary());
  assert.equal(r.phase, "rest");
  assert.equal(r.title, "Name mv-final");
  assert.equal(r.sectionLabel, null);
});

test("the circuit round label follows the block's rounds, not a fixed number", () => {
  const w = fixture(
    [
      ["circ-a", "main", "circuit", 1, null, 10, 5],
      ["circ-a", "main", "circuit", 2, null, 10, 5],
      ["circ-a", "main", "circuit", 3, null, 10, 0],
    ],
    [["circuit", "circuit", 3]]
  );
  assert.equal(run(w, 15, fixtureLibrary()).sectionLabel, "Circuit, round 2 of 3");
  assert.equal(run(w, 30, fixtureLibrary()).sectionLabel, "Circuit, round 3 of 3");
});

test("the final slot says Last move and has no next", () => {
  const w = fullWorkout();
  const r = run(w, 135, fixtureLibrary());
  assert.equal(r.phase, "work");
  assert.equal(r.title, "Name mv-final");
  assert.deepEqual(r.upNext, { kind: "last", text: "Last move" });
  assert.equal(r.totalRemainingSec, 5);
});

test("the very first instant of the final slot already says Last move", () => {
  const w = fullWorkout();
  assert.deepEqual(run(w, 130, fixtureLibrary()).upNext, { kind: "last", text: "Last move" });
});

test("a one-move workout says Last move from the start of work", () => {
  const w = fixture([["mv-a", "main", "straight-1", 1, null, 30, 0]], [["straight-1", "straight", 1]]);
  assert.deepEqual(run(w, 0, fixtureLibrary()).upNext, { kind: "last", text: "Last move" });
});

test("the right side of a two-sided move that ends the workout says Last move", () => {
  const w = fixture(
    [
      ["side-m", "main", "straight-1", 1, "left", 10, 0],
      ["side-m", "main", "straight-1", 1, "right", 10, 0],
    ],
    [["straight-1", "straight", 1]]
  );
  assert.equal(run(w, 5, fixtureLibrary()).upNext.kind, "side-swap");
  const r = run(w, 15, fixtureLibrary());
  assert.equal(r.sideLabel, "Right side");
  assert.deepEqual(r.upNext, { kind: "last", text: "Last move" });
});

test("done is labelled DONE with nothing shown", () => {
  const w = fullWorkout();
  const r = run(w, 140, fixtureLibrary());
  assert.equal(r.phase, "done");
  assert.equal(r.phaseLabel, "DONE");
  assert.equal(r.paused, false);
  assert.equal(r.title, null);
  assert.equal(r.sideLabel, null);
  assert.equal(r.sectionLabel, null);
  assert.equal(r.formCue, null);
  assert.equal(r.upNext, null);
  assert.equal(r.phaseRemainingSec, 0);
  assert.equal(r.totalRemainingSec, 0);
});

test("reading the clock long after the end is still DONE", () => {
  const w = fullWorkout();
  const r = run(w, 5000, fixtureLibrary());
  assert.equal(r.phaseLabel, "DONE");
  assert.equal(r.title, null);
});

test("done shows nothing even when the last move was a two-sided right side", () => {
  const w = fixture(
    [
      ["side-m", "main", "straight-1", 1, "left", 10, 0],
      ["side-m", "main", "straight-1", 1, "right", 10, 0],
    ],
    [["straight-1", "straight", 1]]
  );
  const r = run(w, 20, fixtureLibrary());
  assert.equal(r.phaseLabel, "DONE");
  assert.equal(r.sideLabel, null);
  assert.equal(r.formCue, null);
});

test("the returned object has exactly the documented keys", () => {
  const w = fullWorkout();
  const r = run(w, 34, fixtureLibrary());
  assert.deepEqual(Object.keys(r).sort(), [
    "formCue",
    "paused",
    "phase",
    "phaseLabel",
    "phaseRemainingSec",
    "progress",
    "sectionLabel",
    "sideLabel",
    "title",
    "totalRemainingSec",
    "upNext",
  ]);
});

// ---------------------------------------------------------------------------
// Paused views
// ---------------------------------------------------------------------------

test("a paused view during work reports paused and keeps the work display", () => {
  const w = fullWorkout();
  const plan = buildPlan(w);
  const view = pausedViewAt(plan, 34);
  assert.equal(view.status, "paused"); // sanity: the timer says paused
  const r = describeRunner(view, w, fixtureLibrary());
  assert.equal(r.paused, true);
  assert.equal(r.phase, "work");
  assert.equal(r.phaseLabel, "WORK");
  assert.equal(r.title, "Name mv-a");
  assert.equal(r.phaseRemainingSec, 6);
  assert.deepEqual(r.upNext, { kind: "move", text: "Name side-m" });
});

test("a paused view during rest reports paused and still shows the upcoming move", () => {
  const w = fullWorkout();
  const view = pausedViewAt(buildPlan(w), 42);
  const r = describeRunner(view, w, fixtureLibrary());
  assert.equal(r.paused, true);
  assert.equal(r.phaseLabel, "REST");
  assert.equal(r.title, "Name side-m");
  assert.equal(r.sideLabel, "Left side");
  assert.equal(r.upNext, null);
});

test("a paused view during the lead-in reports paused and GET READY", () => {
  const w = fullWorkout();
  const view = pausedViewAt(buildPlan(w), -3);
  const r = describeRunner(view, w, fixtureLibrary());
  assert.equal(r.paused, true);
  assert.equal(r.phaseLabel, "GET READY");
  assert.equal(r.title, "Name wu-a");
  assert.equal(r.progress, 0);
});

test("a paused view keeps the progress it had when paused", () => {
  const w = fullWorkout();
  const r = describeRunner(pausedViewAt(buildPlan(w), 70), w, fixtureLibrary());
  assert.equal(r.paused, true);
  assert.equal(r.progress, 0.5);
});

test("a running view is not paused", () => {
  const w = fullWorkout();
  assert.equal(run(w, 34, fixtureLibrary()).paused, false);
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test("progress is 0 throughout the get-ready lead-in", () => {
  const w = fullWorkout();
  for (const sec of [-5, -4, -2, -1]) {
    assert.equal(run(w, sec, fixtureLibrary()).progress, 0, `at ${sec}`);
  }
});

test("progress is 0 the instant work begins", () => {
  assert.equal(run(fullWorkout(), 0, fixtureLibrary()).progress, 0);
});

test("progress is elapsed over the workout total at known moments", () => {
  const w = fullWorkout();
  assert.equal(run(w, 70, fixtureLibrary()).progress, 0.5);
  assert.equal(run(w, 35, fixtureLibrary()).progress, 0.25);
  assert.equal(run(w, 105, fixtureLibrary()).progress, 0.75);
});

test("progress counts rest time too, not just work time", () => {
  const w = fullWorkout();
  const r = run(w, 42, fixtureLibrary()); // in the rest after mv-a
  assert.equal(r.phase, "rest");
  assert.equal(r.progress, 42 / 140);
});

test("progress is exactly 1 when done", () => {
  const w = fullWorkout();
  assert.equal(run(w, 140, fixtureLibrary()).progress, 1);
  assert.equal(run(w, 9999, fixtureLibrary()).progress, 1);
});

test("progress is just under 1 in the last second of work", () => {
  const w = fullWorkout();
  const p = run(w, 139, fixtureLibrary()).progress;
  assert.ok(p < 1 && p > 0.99, `got ${p}`);
});

test("progress is clamped to 0 for a view with negative elapsed time", () => {
  const w = fullWorkout();
  const view = { ...viewAt(buildPlan(w), 10), elapsedSec: -3 };
  assert.equal(describeRunner(view, w, fixtureLibrary()).progress, 0);
});

test("progress is clamped to 1 for a view with elapsed time past the total", () => {
  const w = fullWorkout();
  const view = { ...viewAt(buildPlan(w), 10), elapsedSec: 500 };
  assert.equal(describeRunner(view, w, fixtureLibrary()).progress, 1);
});

test("progress uses the last slot's end as the total, even with a long final slot", () => {
  const w = fixture(
    [
      ["mv-a", "main", "straight-1", 1, null, 10, 10],
      ["mv-final", "main", "straight-1", 1, null, 50, 0],
    ],
    [["straight-1", "straight", 1]]
  ); // last slot ends at 70
  assert.equal(run(w, 35, fixtureLibrary()).progress, 0.5);
});

// ---------------------------------------------------------------------------
// Form cue
// ---------------------------------------------------------------------------

test("the form cue is the library cue for the shown slot's exercise", () => {
  const w = fullWorkout();
  assert.equal(run(w, 75, fixtureLibrary()).formCue, "Cue circ-a");
});

test("the form cue during rest is the upcoming move's, not the one just finished", () => {
  const w = fullWorkout();
  const r = run(w, 41, fixtureLibrary()); // just did mv-a, next is side-m
  assert.equal(r.formCue, "Cue side-m");
});

test("both sides of a two-sided move show the same cue", () => {
  const w = fullWorkout();
  assert.equal(run(w, 50, fixtureLibrary()).formCue, "Cue side-m");
  assert.equal(run(w, 60, fixtureLibrary()).formCue, "Cue side-m");
});

test("a library entry without a formCue gives a null form cue", () => {
  const w = fullWorkout();
  const r = run(w, 90, fixtureLibrary()); // circ-b has no cue
  assert.equal(r.title, "Name circ-b");
  assert.equal(r.formCue, null);
});

test("an exercise id missing from the library gives a null form cue but still shows the title", () => {
  const w = fullWorkout();
  const r = run(w, 135, fixtureLibrary()); // mv-final is not in the library
  assert.equal(r.title, "Name mv-final");
  assert.equal(r.formCue, null);
});

test("an empty library gives a null form cue everywhere", () => {
  const w = fullWorkout();
  assert.equal(run(w, 34, []).formCue, null);
  assert.equal(run(w, -3, []).formCue, null);
});

test("a blank formCue string is treated as no cue", () => {
  const w = fullWorkout();
  const lib = [{ id: "mv-a", formCue: "" }];
  assert.equal(run(w, 34, lib).formCue, null);
});

// ---------------------------------------------------------------------------
// Real generated workouts
// ---------------------------------------------------------------------------

function realWorkout(seed, extra = {}) {
  return generateWorkout(
    library,
    {
      totalSeconds: 600,
      workSeconds: 40,
      restSeconds: 20,
      warmup: { enabled: true },
      circuit: { size: 2, rounds: 3 },
      ...extra,
    },
    mulberry32(seed)
  );
}

test("a real workout starts at GET READY showing its first move and that move's library cue", () => {
  const w = realWorkout(7);
  const r = run(w, -5);
  assert.equal(r.phaseLabel, "GET READY");
  assert.equal(r.title, w.slots[0].name);
  assert.equal(r.formCue, library.find((e) => e.id === w.slots[0].exerciseId).formCue);
  assert.equal(r.sectionLabel, "Warm-up");
});

test("a real workout with a circuit labels circuit moves with the generator's own round count", () => {
  const w = realWorkout(11);
  const circuit = w.blocks.find((b) => b.kind === "circuit");
  assert.ok(circuit, "fixture should include a circuit");
  const plan = buildPlan(w);
  const slot = w.slots[circuit.lastSlot];
  const mid = slot.startSec + 1;
  const r = describeRunner(viewAt(plan, mid), w, library);
  assert.equal(r.title, slot.name);
  assert.equal(r.sectionLabel, `Circuit, round ${slot.round} of ${circuit.rounds}`);
  assert.equal(slot.round, circuit.rounds);
});

test("a real workout ends in DONE with progress 1", () => {
  const w = realWorkout(3);
  const r = run(w, w.durationSeconds + 1);
  assert.equal(r.phaseLabel, "DONE");
  assert.equal(r.progress, 1);
  assert.equal(r.title, null);
});

// ---------------------------------------------------------------------------
// Input safety
// ---------------------------------------------------------------------------

test("describeRunner does not mutate its inputs", () => {
  const w = fullWorkout();
  const lib = fixtureLibrary();
  const plan = buildPlan(w);
  const times = [-5, -2, 0, 34, 42, 50, 55, 66, 105, 135, 140];
  const views = [...times.map((t) => viewAt(plan, t)), pausedViewAt(plan, 34)];

  const before = clone({ views, w, lib });
  deepFreeze(views);
  deepFreeze(w);
  deepFreeze(lib);

  // Frozen inputs make any write throw in strict mode (ES modules are strict).
  for (const view of views) {
    assert.doesNotThrow(() => describeRunner(view, w, lib));
  }
  assert.deepEqual(clone({ views, w, lib }), before);
});

test("describeRunner is deterministic: the same inputs give equal results", () => {
  const w = fullWorkout();
  const view = viewAt(buildPlan(w), 50);
  assert.deepEqual(describeRunner(view, w, fixtureLibrary()), describeRunner(view, w, fixtureLibrary()));
});

test("the result does not share references with the workout or the view", () => {
  const w = fullWorkout();
  const view = viewAt(buildPlan(w), 50);
  const r = describeRunner(view, w, fixtureLibrary());
  for (const v of Object.values(r)) {
    if (v && typeof v === "object") {
      assert.ok(!Object.values(view).includes(v), "result shares an object with the view");
      assert.ok(!Object.values(w).includes(v), "result shares an object with the workout");
    }
  }
});

// ---------------------------------------------------------------------------
// Property sweep over generated workouts
// ---------------------------------------------------------------------------

const PHASE_LABELS = { ready: "GET READY", work: "WORK", rest: "REST", done: "DONE" };
const SIDE_LABELS = { left: "Left side", right: "Right side", alternate: "Alternate sides" };

test("property: 200 random generated workouts describe consistently at 1 s steps from lead-in to done", () => {
  const STEP = (rng, lo, hi, step) => lo + Math.floor(rng() * ((hi - lo) / step + 1)) * step;
  let checked = 0;
  let sawCircuit = false;
  let sawWarmup = false;
  let sawSwap = false;
  let sawAlternate = false;

  for (const seed of seeds(200)) {
    const rng = mulberry32(seed);
    const options = {
      totalSeconds: STEP(rng, 300, 1200, 60),
      workSeconds: STEP(rng, 20, 60, 5),
      restSeconds: STEP(rng, 5, 45, 5),
      maxDifficulty: 1 + Math.floor(rng() * 3),
      warmup: { enabled: rng() < 0.5, countsInTotal: rng() < 0.7 },
      circuit: rng() < 0.5 ? { size: 2 + Math.floor(rng() * 3), rounds: 2 + Math.floor(rng() * 3) } : null,
    };
    let w;
    try {
      w = generateWorkout(library, options, rng);
    } catch {
      continue; // total too short for these settings; nothing to run
    }
    checked++;
    const label = `seed ${seed}`;
    const plan = buildPlan(w);
    const total = w.slots.at(-1).endSec;
    const byId = new Map(library.map((e) => [e.id, e]));

    let state = start(plan, T0);
    let prevProgress = 0;
    let prevTotalRemaining = Infinity;
    let sawDone = false;

    for (let sec = -plan.leadInSec; sec <= total + 2; sec++) {
      const res = tick(plan, state, msAt(plan, sec));
      state = res.state;
      const view = res.view;
      const r = describeRunner(view, w, library);
      const at = `${label} @ ${sec}s`;

      // Phase and label mapping.
      assert.equal(r.phase, view.phase, `${at}: phase`);
      assert.equal(r.phaseLabel, PHASE_LABELS[view.phase], `${at}: phaseLabel`);
      assert.equal(r.paused, false, `${at}: paused`);
      assert.equal(r.phaseRemainingSec, view.phaseRemainingSec, `${at}: phaseRemainingSec`);
      assert.equal(r.totalRemainingSec, view.totalRemainingSec, `${at}: totalRemainingSec`);

      // The shown slot.
      const shown = view.phase === "work" ? view.slot : view.phase === "done" ? null : view.next;
      if (view.phase === "done") {
        sawDone = true;
        assert.equal(r.title, null, `${at}: done title`);
        assert.equal(r.sideLabel, null, `${at}: done sideLabel`);
        assert.equal(r.sectionLabel, null, `${at}: done sectionLabel`);
        assert.equal(r.formCue, null, `${at}: done formCue`);
      } else {
        assert.ok(shown, `${at}: a shown slot exists`);
        assert.notEqual(r.title, null, `${at}: title non-null`);
        assert.equal(r.title, shown.name, `${at}: title is the shown slot's name`);
        assert.equal(r.sideLabel, SIDE_LABELS[shown.side] ?? null, `${at}: sideLabel`);
        assert.equal(r.formCue, byId.get(shown.exerciseId)?.formCue || null, `${at}: formCue`);
        const block = w.blocks.find((b) => b.id === shown.blockId);
        const expectedSection =
          shown.section === "warmup"
            ? "Warm-up"
            : block?.kind === "circuit"
              ? `Circuit, round ${shown.round} of ${block.rounds}`
              : null;
        assert.equal(r.sectionLabel, expectedSection, `${at}: sectionLabel`);
        if (expectedSection?.startsWith("Circuit")) sawCircuit = true;
        if (expectedSection === "Warm-up") sawWarmup = true;
        if (shown.side === "alternate") sawAlternate = true;
      }

      if (view.phase === "work") {
        assert.equal(r.title, view.slot.name, `${at}: work title is view.slot.name`);
      }
      if (view.phase === "rest") {
        assert.equal(r.title, view.next.name, `${at}: rest title is view.next.name`);
      }
      if (view.phase === "ready") {
        assert.equal(r.title, w.slots[0].name, `${at}: ready title is the first move`);
        assert.equal(r.progress, 0, `${at}: ready progress`);
      }

      // Up next.
      if (view.phase === "work") {
        assert.notEqual(r.upNext, null, `${at}: upNext in work`);
        if (view.nextIsSideSwap) {
          sawSwap = true;
          assert.deepEqual(r.upNext, { kind: "side-swap", text: "Switch to right side" }, `${at}: swap`);
        } else if (view.next) {
          assert.deepEqual(r.upNext, { kind: "move", text: view.next.name }, `${at}: move`);
        } else {
          assert.deepEqual(r.upNext, { kind: "last", text: "Last move" }, `${at}: last`);
        }
      } else {
        assert.equal(r.upNext, null, `${at}: upNext outside work`);
      }

      // Progress.
      assert.ok(r.progress >= 0 && r.progress <= 1, `${at}: progress in range (${r.progress})`);
      assert.ok(r.progress >= prevProgress, `${at}: progress went backwards (${prevProgress} -> ${r.progress})`);
      prevProgress = r.progress;
      if (view.phase === "done") assert.equal(r.progress, 1, `${at}: done progress`);

      // Total remaining never increases.
      assert.ok(
        r.totalRemainingSec <= prevTotalRemaining,
        `${at}: totalRemainingSec increased (${prevTotalRemaining} -> ${r.totalRemainingSec})`
      );
      prevTotalRemaining = r.totalRemainingSec;
    }

    assert.ok(sawDone, `${label}: reached done`);
    assert.equal(prevProgress, 1, `${label}: progress ends at 1`);
  }

  assert.ok(checked >= 100, `only ${checked} of 200 seeds produced a workout`);
  assert.ok(sawCircuit, "sweep should include circuit moves");
  assert.ok(sawWarmup, "sweep should include warm-up moves");
  assert.ok(sawSwap, "sweep should include a side-swap cue");
  assert.ok(sawAlternate, "sweep should include an alternate-sides warm-up move");
});
