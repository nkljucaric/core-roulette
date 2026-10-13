import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPreview } from "../src/preview.js";
import { generateWorkout } from "../src/generator.js";

// Logic-layer tests for buildPreview (issue #20). The contract is the scope
// comment on #20: buildPreview(workout) turns generateWorkout's output into
// { totalSec, moveCount, workSeconds, restSeconds, warnings, sections }, where
// each section lists "move" rows (both sides of a two-sided move folded into
// one) and "rest" rows, and circuits are collapsed to round 1.

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

// ---------------------------------------------------------------------------
// Hand-built workouts with the same shape generateWorkout returns
// ---------------------------------------------------------------------------

// slotSpecs: [exerciseId, section, blockId, round, side, workSeconds, restAfter]
// blockSpecs: [id, kind, rounds]
// Times are laid out like the real timeline: a slot starts when the previous
// slot's work and rest are over.
function fixture(slotSpecs, blockSpecs, { workSeconds = 40, restSeconds = 20, warnings = [] } = {}) {
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
    options: { totalSeconds: last.endSec, workSeconds, restSeconds },
    randomized: [],
    durationSeconds: last.endSec,
    slots,
    blocks,
    warnings,
  };
}

// Warm-up (one alternating move, one plain move), then a main set with a
// two-sided move and a longer final move.
//   cat-cow       alternate   0-40   rest 40-60
//   glute-bridge              60-100 rest 100-120
//   side-plank    left        120-160 (no rest)
//   side-plank    right       160-200 rest 200-220
//   dead-bug                  220-260 rest 260-280
//   plank (long)              280-340
const warmThenMain = () =>
  fixture(
    [
      ["cat-cow", "warmup", "warmup", 1, "alternate", 40, 20],
      ["glute-bridge", "warmup", "warmup", 1, null, 40, 20],
      ["side-plank", "main", "straight-1", 1, "left", 40, 0],
      ["side-plank", "main", "straight-1", 1, "right", 40, 20],
      ["dead-bug", "main", "straight-1", 1, null, 40, 20],
      ["plank", "main", "straight-1", 1, null, 60, 0],
    ],
    [
      ["warmup", "warmup", 1],
      ["straight-1", "straight", 1],
    ]
  );

// A straight move, a 2-move x 3-round circuit, then another straight move.
//   dead-bug                       0-40    rest 40-60
//   circuit r1: v-up               60-100  rest 100-120;  heel-taps 120-160 rest 160-180
//   circuit r2: v-up               180-220 rest;          heel-taps 240-280 rest
//   circuit r3: v-up               300-340 rest;          heel-taps 360-400 rest 400-420
//   plank                          420-460
const circuitMiddle = () =>
  fixture(
    [
      ["dead-bug", "main", "straight-1", 1, null, 40, 20],
      ["v-up", "main", "circuit", 1, null, 40, 20],
      ["heel-taps", "main", "circuit", 1, null, 40, 20],
      ["v-up", "main", "circuit", 2, null, 40, 20],
      ["heel-taps", "main", "circuit", 2, null, 40, 20],
      ["v-up", "main", "circuit", 3, null, 40, 20],
      ["heel-taps", "main", "circuit", 3, null, 40, 20],
      ["plank", "main", "straight-2", 1, null, 40, 0],
    ],
    [
      ["straight-1", "straight", 1],
      ["circuit", "circuit", 3],
      ["straight-2", "straight", 1],
    ]
  );

// A single-block workout whose final move has the given per-side work times.
function endsWith(lastWorks, { baseWork = 40 } = {}) {
  const slots = [["dead-bug", "main", "straight-1", 1, null, baseWork, 20]];
  if (lastWorks.length === 1) {
    slots.push(["plank", "main", "straight-1", 1, null, lastWorks[0], 0]);
  } else {
    slots.push(["side-plank", "main", "straight-1", 1, "left", lastWorks[0], 0]);
    slots.push(["side-plank", "main", "straight-1", 1, "right", lastWorks[1], 0]);
  }
  return fixture(slots, [["straight-1", "straight", 1]], { workSeconds: baseWork });
}

const movesOf = (section) => section.items.filter((i) => i.type === "move");
const restsOf = (section) => section.items.filter((i) => i.type === "rest");

// ---------------------------------------------------------------------------
// Top-level summary
// ---------------------------------------------------------------------------

test("totalSec is the end of the last slot", () => {
  const p = buildPreview(warmThenMain());
  assert.equal(p.totalSec, 340);
});

test("workSeconds and restSeconds come from the workout options", () => {
  const w = fixture(
    [["dead-bug", "main", "straight-1", 1, null, 30, 0]],
    [["straight-1", "straight", 1]],
    { workSeconds: 30, restSeconds: 15 }
  );
  const p = buildPreview(w);
  assert.equal(p.workSeconds, 30);
  assert.equal(p.restSeconds, 15);
});

test("warnings are passed through unchanged", () => {
  const warnings = ["Some ordering rules were relaxed because few exercises matched.", "Another note."];
  const w = fixture(
    [["dead-bug", "main", "straight-1", 1, null, 40, 0]],
    [["straight-1", "straight", 1]],
    { warnings }
  );
  assert.deepEqual(buildPreview(w).warnings, warnings);
});

test("an empty warnings list stays empty", () => {
  assert.deepEqual(buildPreview(warmThenMain()).warnings, []);
});

test("moveCount counts a two-sided move once", () => {
  // cat-cow, glute-bridge, side-plank (two slots), dead-bug, plank
  assert.equal(buildPreview(warmThenMain()).moveCount, 5);
});

test("moveCount counts distinct exercises, so circuit rounds do not inflate it", () => {
  // dead-bug, v-up, heel-taps, plank across 8 slots
  assert.equal(buildPreview(circuitMiddle()).moveCount, 4);
});

test("moveCount counts an exercise used in two blocks only once", () => {
  const w = fixture(
    [
      ["dead-bug", "main", "straight-1", 1, null, 40, 20],
      ["v-up", "main", "circuit", 1, null, 40, 20],
      ["heel-taps", "main", "circuit", 1, null, 40, 20],
      ["v-up", "main", "circuit", 2, null, 40, 20],
      ["heel-taps", "main", "circuit", 2, null, 40, 20],
      ["dead-bug", "main", "straight-2", 1, null, 40, 0],
    ],
    [
      ["straight-1", "straight", 1],
      ["circuit", "circuit", 2],
      ["straight-2", "straight", 1],
    ]
  );
  assert.equal(buildPreview(w).moveCount, 3);
});

// ---------------------------------------------------------------------------
// Sections: order, kinds, headings, spans
// ---------------------------------------------------------------------------

test("sections follow block order with kinds warmup, main and circuit", () => {
  assert.deepEqual(buildPreview(warmThenMain()).sections.map((s) => s.kind), ["warmup", "main"]);
  assert.deepEqual(buildPreview(circuitMiddle()).sections.map((s) => s.kind), ["main", "circuit", "main"]);
});

test("the warm-up section is headed 'Warm-up' and has one round", () => {
  const s = buildPreview(warmThenMain()).sections[0];
  assert.equal(s.heading, "Warm-up");
  assert.equal(s.rounds, 1);
});

test("a circuit section is headed 'Circuit' and carries its round count", () => {
  const s = buildPreview(circuitMiddle()).sections[1];
  assert.equal(s.heading, "Circuit");
  assert.equal(s.rounds, 3);
});

test("a main set that comes first has no heading", () => {
  const s = buildPreview(circuitMiddle()).sections[0];
  assert.equal(s.kind, "main");
  assert.equal(s.heading, null);
});

test("a main set right after the warm-up is headed 'Main set'", () => {
  assert.equal(buildPreview(warmThenMain()).sections[1].heading, "Main set");
});

test("a main set right after a circuit is headed 'Main set'", () => {
  assert.equal(buildPreview(circuitMiddle()).sections[2].heading, "Main set");
});

test("a main set directly after another main set is not given a second heading", () => {
  const w = fixture(
    [
      ["dead-bug", "main", "straight-1", 1, null, 40, 20],
      ["plank", "main", "straight-2", 1, null, 40, 0],
    ],
    [
      ["straight-1", "straight", 1],
      ["straight-2", "straight", 1],
    ]
  );
  const s = buildPreview(w).sections;
  assert.equal(s[0].heading, null);
  assert.equal(s[1].heading, null);
});

test("a straight section outside a circuit has rounds of 1", () => {
  for (const s of buildPreview(circuitMiddle()).sections.filter((x) => x.kind === "main")) {
    assert.equal(s.rounds, 1);
  }
});

test("a section starts at its first slot and ends at its last slot", () => {
  const [warm, main] = buildPreview(warmThenMain()).sections;
  assert.equal(warm.startSec, 0);
  assert.equal(warm.endSec, 100);
  assert.equal(main.startSec, 120);
  assert.equal(main.endSec, 340);
});

test("a circuit section's span covers all of its rounds", () => {
  const circuit = buildPreview(circuitMiddle()).sections[1];
  assert.equal(circuit.startSec, 60);
  assert.equal(circuit.endSec, 400);
});

// ---------------------------------------------------------------------------
// Move rows
// ---------------------------------------------------------------------------

test("a plain move row carries id, name, window, work time and no sides", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  const deadBug = movesOf(main).find((m) => m.exerciseId === "dead-bug");
  assert.deepEqual(deadBug, {
    type: "move",
    exerciseId: "dead-bug",
    name: "Name dead-bug",
    startSec: 220,
    endSec: 260,
    workSeconds: 40,
    sides: null,
    longSeconds: null,
  });
});

test("a two-sided main move collapses left and right into one move row", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  const planks = movesOf(main).filter((m) => m.exerciseId === "side-plank");
  assert.equal(planks.length, 1);
});

test("a two-sided move's window spans both sides and its work time is per side", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  const m = movesOf(main).find((x) => x.exerciseId === "side-plank");
  assert.equal(m.startSec, 120);
  assert.equal(m.endSec, 200);
  assert.equal(m.workSeconds, 40);
  assert.equal(m.sides, "each");
});

test("a two-sided move's work time is taken from its first slot", () => {
  const w = fixture(
    [
      ["side-plank", "main", "straight-1", 1, "left", 45, 0],
      ["side-plank", "main", "straight-1", 1, "right", 45, 20],
      ["plank", "main", "straight-1", 1, null, 40, 0],
    ],
    [["straight-1", "straight", 1]]
  );
  const m = movesOf(buildPreview(w).sections[0])[0];
  assert.equal(m.workSeconds, 45);
});

test("a warm-up alternate move is one row with sides 'alternate'", () => {
  const warm = buildPreview(warmThenMain()).sections[0];
  const m = movesOf(warm)[0];
  assert.equal(m.exerciseId, "cat-cow");
  assert.equal(m.sides, "alternate");
  assert.equal(m.startSec, 0);
  assert.equal(m.endSec, 40);
  assert.equal(m.workSeconds, 40);
});

test("a warm-up move with no side has sides null", () => {
  const warm = buildPreview(warmThenMain()).sections[0];
  assert.equal(movesOf(warm)[1].sides, null);
});

test("the same exercise in consecutive slots of different rounds stays separate moves", () => {
  // Same exercise at the end of round 1 and start of round 2 must not merge.
  const w = fixture(
    [
      ["v-up", "main", "circuit", 1, null, 40, 20],
      ["heel-taps", "main", "circuit", 1, null, 40, 20],
      ["heel-taps", "main", "circuit", 2, null, 40, 20],
      ["v-up", "main", "circuit", 2, null, 40, 0],
    ],
    [["circuit", "circuit", 2]]
  );
  const items = buildPreview(w).sections[0].items;
  assert.deepEqual(
    items.filter((i) => i.type === "move").map((m) => m.exerciseId),
    ["v-up", "heel-taps"]
  );
});

// ---------------------------------------------------------------------------
// Rest rows
// ---------------------------------------------------------------------------

test("items alternate move, rest, move in time order within a section", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  assert.deepEqual(
    main.items.map((i) => (i.type === "move" ? i.exerciseId : "rest")),
    ["side-plank", "rest", "dead-bug", "rest", "plank"]
  );
});

test("a rest row follows a move with its seconds and window", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  assert.deepEqual(main.items[1], { type: "rest", seconds: 20, startSec: 200, endSec: 220 });
});

test("no rest row sits between the left and right sides of a move", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  // side-plank is first and is followed directly by a single rest row.
  assert.equal(main.items[0].exerciseId, "side-plank");
  assert.equal(main.items[1].type, "rest");
  assert.equal(restsOf(main).length, 2);
});

test("a rest row is built from the last slot's rest, not the first side's", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  const rest = main.items[1];
  assert.equal(rest.startSec, 200); // end of the right side
  assert.equal(rest.seconds, 20);
});

test("there is no rest row after the last move of the workout", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  assert.equal(main.items[main.items.length - 1].type, "move");
  assert.equal(main.items[main.items.length - 1].exerciseId, "plank");
});

test("the warm-up keeps a rest row after its last move when rest follows it", () => {
  const warm = buildPreview(warmThenMain()).sections[0];
  assert.equal(warm.items.length, 4);
  assert.deepEqual(warm.items[3], { type: "rest", seconds: 20, startSec: 100, endSec: 120 });
});

test("a workout with zero rest has no rest rows at all", () => {
  const w = fixture(
    [
      ["dead-bug", "main", "straight-1", 1, null, 40, 0],
      ["plank", "main", "straight-1", 1, null, 40, 0],
    ],
    [["straight-1", "straight", 1]],
    { restSeconds: 0 }
  );
  const p = buildPreview(w);
  assert.equal(restsOf(p.sections[0]).length, 0);
  assert.equal(p.sections[0].items.length, 2);
});

test("a single-move workout has one move row and no rest row", () => {
  const w = fixture(
    [["plank", "main", "straight-1", 1, null, 40, 0]],
    [["straight-1", "straight", 1]]
  );
  const p = buildPreview(w);
  assert.equal(p.sections.length, 1);
  assert.equal(p.sections[0].items.length, 1);
  assert.equal(p.sections[0].items[0].type, "move");
  assert.equal(p.totalSec, 40);
  assert.equal(p.moveCount, 1);
});

// ---------------------------------------------------------------------------
// Circuit collapse
// ---------------------------------------------------------------------------

test("a circuit's items come only from round 1", () => {
  const circuit = buildPreview(circuitMiddle()).sections[1];
  assert.deepEqual(
    circuit.items.map((i) => (i.type === "move" ? i.exerciseId : "rest")),
    ["v-up", "rest", "heel-taps", "rest"]
  );
});

test("collapsed circuit moves keep their round 1 times", () => {
  const circuit = buildPreview(circuitMiddle()).sections[1];
  const [vUp, , heel] = circuit.items;
  assert.equal(vUp.startSec, 60);
  assert.equal(vUp.endSec, 100);
  assert.equal(heel.startSec, 120);
  assert.equal(heel.endSec, 160);
});

test("a collapsed circuit keeps the rest row after round 1's final move", () => {
  const circuit = buildPreview(circuitMiddle()).sections[1];
  assert.deepEqual(circuit.items[3], { type: "rest", seconds: 20, startSec: 160, endSec: 180 });
});

test("a circuit round 1 final move has no rest row when its rest is zero", () => {
  const w = fixture(
    [
      ["v-up", "main", "circuit", 1, null, 40, 20],
      ["heel-taps", "main", "circuit", 1, null, 40, 0],
      ["v-up", "main", "circuit", 2, null, 40, 20],
      ["heel-taps", "main", "circuit", 2, null, 40, 0],
    ],
    [["circuit", "circuit", 2]]
  );
  const items = buildPreview(w).sections[0].items;
  assert.deepEqual(
    items.map((i) => i.type),
    ["move", "rest", "move"]
  );
});

test("a circuit with two-sided moves still collapses sides and rounds", () => {
  const w = fixture(
    [
      ["side-plank", "main", "circuit", 1, "left", 40, 0],
      ["side-plank", "main", "circuit", 1, "right", 40, 20],
      ["v-up", "main", "circuit", 1, null, 40, 20],
      ["side-plank", "main", "circuit", 2, "left", 40, 0],
      ["side-plank", "main", "circuit", 2, "right", 40, 20],
      ["v-up", "main", "circuit", 2, null, 40, 0],
    ],
    [["circuit", "circuit", 2]]
  );
  const s = buildPreview(w).sections[0];
  assert.deepEqual(
    movesOf(s).map((m) => [m.exerciseId, m.sides, m.startSec, m.endSec]),
    [
      ["side-plank", "each", 0, 80],
      ["v-up", null, 100, 140],
    ]
  );
  assert.equal(s.rounds, 2);
  assert.equal(s.endSec, 300);
});

// ---------------------------------------------------------------------------
// longSeconds (last move absorbs leftover time)
// ---------------------------------------------------------------------------

test("longSeconds is the last slot's work when it is much longer than the work length", () => {
  const main = buildPreview(warmThenMain()).sections[1];
  const last = movesOf(main).at(-1);
  assert.equal(last.exerciseId, "plank");
  assert.equal(last.workSeconds, 60);
  assert.equal(last.longSeconds, 60);
});

test("longSeconds is null when the last move is only 9 seconds over the work length", () => {
  const m = movesOf(buildPreview(endsWith([49])).sections[0]).at(-1);
  assert.equal(m.longSeconds, null);
});

test("longSeconds is set when the last move is exactly 10 seconds over the work length", () => {
  const m = movesOf(buildPreview(endsWith([50])).sections[0]).at(-1);
  assert.equal(m.longSeconds, 50);
});

test("longSeconds is null when the last move is exactly the work length", () => {
  const m = movesOf(buildPreview(endsWith([40])).sections[0]).at(-1);
  assert.equal(m.longSeconds, null);
});

test("longSeconds for a two-sided last move is the right side's work", () => {
  const m = movesOf(buildPreview(endsWith([40, 55])).sections[0]).at(-1);
  assert.equal(m.exerciseId, "side-plank");
  assert.equal(m.sides, "each");
  assert.equal(m.workSeconds, 40);
  assert.equal(m.longSeconds, 55);
});

test("a two-sided last move only 9 seconds over on the right side has no longSeconds", () => {
  const m = movesOf(buildPreview(endsWith([40, 49])).sections[0]).at(-1);
  assert.equal(m.longSeconds, null);
});

test("moves other than the last never get longSeconds, even with a long override", () => {
  // A middle move with a 90 s override is long, but only the final move is flagged.
  const w = fixture(
    [
      ["dead-bug", "main", "straight-1", 1, null, 90, 20],
      ["plank", "main", "straight-1", 1, null, 40, 0],
    ],
    [["straight-1", "straight", 1]]
  );
  const [first, , last] = buildPreview(w).sections[0].items;
  assert.equal(first.workSeconds, 90);
  assert.equal(first.longSeconds, null);
  assert.equal(last.longSeconds, null);
});

test("when the workout ends in another section after a circuit, only the final move can be long", () => {
  const w = circuitMiddle();
  const p = buildPreview(w);
  const longs = p.sections.flatMap((s) => movesOf(s)).filter((m) => m.longSeconds !== null);
  assert.equal(longs.length, 0); // final plank is 40 s, equal to the work length
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test("buildPreview does not mutate a deep-frozen workout", () => {
  for (const w of [warmThenMain(), circuitMiddle(), endsWith([40, 55])]) {
    deepFreeze(w);
    assert.doesNotThrow(() => buildPreview(w));
  }
});

test("buildPreview does not mutate a real generated workout", () => {
  const w = generateWorkout(
    library,
    { totalSeconds: 600, workSeconds: 40, restSeconds: 20, warmup: { enabled: true }, circuit: { size: 2, rounds: 3 } },
    mulberry32(5)
  );
  const copy = structuredClone(w);
  buildPreview(w);
  assert.deepEqual(w, copy);
});

test("buildPreview returns equal results for equal input", () => {
  assert.deepEqual(buildPreview(circuitMiddle()), buildPreview(circuitMiddle()));
});

test("the returned warnings do not share state with a later call's result", () => {
  const w = fixture(
    [["dead-bug", "main", "straight-1", 1, null, 40, 0]],
    [["straight-1", "straight", 1]],
    { warnings: ["note"] }
  );
  const a = buildPreview(w);
  a.warnings.push("mutated");
  assert.deepEqual(buildPreview(w).warnings, ["note"]);
});

// ---------------------------------------------------------------------------
// Real generated workouts
// ---------------------------------------------------------------------------

test("a generated workout with warm-up and circuit previews in section order", () => {
  const w = generateWorkout(
    library,
    { totalSeconds: 600, workSeconds: 40, restSeconds: 20, warmup: { enabled: true }, circuit: { size: 2, rounds: 2 } },
    mulberry32(11)
  );
  const p = buildPreview(w);
  assert.equal(p.sections[0].kind, "warmup");
  assert.ok(p.sections.some((s) => s.kind === "circuit"));
  assert.equal(p.totalSec, w.slots.at(-1).endSec);
  assert.deepEqual(p.warnings, w.warnings);
  assert.equal(p.workSeconds, w.options.workSeconds);
  assert.equal(p.restSeconds, w.options.restSeconds);
});

test("property: previews of 200 random generated workouts are consistent with their slots", () => {
  const STEP = (rng, lo, hi, step) => lo + Math.floor(rng() * ((hi - lo) / step + 1)) * step;
  let checked = 0;

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
      continue; // total too short for these settings; nothing to preview
    }
    checked++;
    const label = `seed ${seed}`;
    const p = buildPreview(w);
    const last = w.slots.at(-1);

    // Summary fields.
    assert.equal(p.totalSec, last.endSec, `${label}: totalSec`);
    assert.equal(p.moveCount, new Set(w.slots.map((s) => s.exerciseId)).size, `${label}: moveCount`);
    assert.deepEqual(p.warnings, w.warnings, `${label}: warnings`);

    // One section per block, in order.
    assert.equal(p.sections.length, w.blocks.length, `${label}: section count`);

    // Sections tile the workout: each starts where the previous one's last
    // slot finished, plus the rest that followed that slot.
    assert.equal(p.sections[0].startSec, 0, `${label}: first section starts at 0`);
    for (let i = 1; i < p.sections.length; i++) {
      const prevLast = w.slots[w.blocks[i - 1].lastSlot];
      assert.equal(
        p.sections[i].startSec,
        p.sections[i - 1].endSec + prevLast.restAfter,
        `${label}: section ${i} follows section ${i - 1} with no gap`
      );
    }
    assert.equal(p.sections.at(-1).endSec, p.totalSec, `${label}: last section ends at totalSec`);

    p.sections.forEach((section, i) => {
      const block = w.blocks[i];
      const blockSlots = w.slots.slice(block.firstSlot, block.lastSlot + 1);
      const moves = movesOf(section);

      // Move windows within a section never overlap, and each rest row
      // directly follows its move.
      for (let k = 1; k < section.items.length; k++) {
        assert.ok(
          section.items[k].startSec >= section.items[k - 1].endSec,
          `${label}: section ${i} item ${k} overlaps the previous item`
        );
      }
      section.items.forEach((item, k) => {
        if (item.type === "rest") {
          assert.equal(section.items[k - 1]?.type, "move", `${label}: rest follows a move`);
          assert.equal(item.startSec, section.items[k - 1].endSec, `${label}: rest starts when its move ends`);
          assert.equal(item.endSec, item.startSec + item.seconds, `${label}: rest window`);
          assert.ok(item.seconds > 0, `${label}: rest rows are positive`);
        }
      });

      if (block.kind !== "circuit") {
        // Every slot is covered by exactly one move window, and the windows
        // account for exactly the slots' time (no gaps, no double counting).
        for (const s of blockSlots) {
          const covering = moves.filter((m) => m.startSec <= s.startSec && s.endSec <= m.endSec);
          assert.equal(covering.length, 1, `${label}: slot ${s.index} covered exactly once`);
          assert.equal(covering[0].exerciseId, s.exerciseId, `${label}: slot ${s.index} owner`);
        }
        const slotTime = blockSlots.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
        const moveTime = moves.reduce((sum, m) => sum + (m.endSec - m.startSec), 0);
        assert.equal(moveTime, slotTime, `${label}: section ${i} move time equals slot time`);
      } else {
        // Circuits show round 1 only, but the section spans every round.
        const round1 = blockSlots.filter((s) => s.round === 1);
        assert.equal(section.rounds, block.rounds, `${label}: circuit rounds`);
        assert.equal(section.startSec, blockSlots[0].startSec, `${label}: circuit start`);
        assert.equal(section.endSec, blockSlots.at(-1).endSec, `${label}: circuit end`);
        assert.equal(moves[0].startSec, round1[0].startSec, `${label}: circuit first move`);
        assert.equal(moves.at(-1).endSec, round1.at(-1).endSec, `${label}: circuit last move`);
        assert.equal(
          new Set(moves.map((m) => m.exerciseId)).size,
          new Set(round1.map((s) => s.exerciseId)).size,
          `${label}: circuit shows each round 1 move once`
        );
      }
    });

    // longSeconds appears only on the final move of the workout. When that move
    // is in a collapsed circuit, the circuit section reports it as finalLong.
    const finalSection = p.sections.at(-1);
    const finalMove = movesOf(finalSection).at(-1);
    const expectLong = last.workSeconds - w.options.workSeconds >= 10 ? last.workSeconds : null;
    if (finalSection.kind === "circuit") {
      assert.equal(finalMove.longSeconds, null, `${label}: collapsed circuit rows are never long`);
      assert.equal(finalSection.finalLong?.longSeconds ?? null, expectLong, `${label}: circuit finalLong`);
      if (expectLong !== null) assert.equal(finalSection.finalLong.name, last.name, `${label}: finalLong name`);
    } else {
      assert.equal(finalMove.longSeconds, expectLong, `${label}: final move longSeconds`);
      assert.equal(finalSection.finalLong, null, `${label}: no finalLong outside circuits`);
    }
    const others = p.sections.flatMap((s) => movesOf(s)).filter((m) => m !== finalMove);
    assert.ok(others.every((m) => m.longSeconds === null), `${label}: only the final move can be long`);
  }

  assert.ok(checked >= 150, `expected most seeds to generate a workout, got ${checked}`);
});

// ---------------------------------------------------------------------------
// A long final move inside a collapsed circuit (only round 1 is listed)
// ---------------------------------------------------------------------------

const circuitLast = (lastWork) =>
  fixture(
    [
      ["v-up", "main", "circuit", 1, null, 40, 20],
      ["heel-taps", "main", "circuit", 1, null, 40, 20],
      ["v-up", "main", "circuit", 2, null, 40, 20],
      ["heel-taps", "main", "circuit", 2, null, lastWork, 0],
    ],
    [["circuit", "circuit", 2]]
  );

test("a long final move in a collapsed circuit is reported as finalLong on the circuit", () => {
  const circuit = buildPreview(circuitLast(90)).sections[0];
  assert.deepEqual(circuit.finalLong, { name: "Name heel-taps", longSeconds: 90 });
  assert.ok(movesOf(circuit).every((m) => m.longSeconds === null));
});

test("finalLong is null below the long threshold and for non-final sections", () => {
  assert.equal(buildPreview(circuitLast(49)).sections[0].finalLong, null);
  assert.equal(buildPreview(circuitMiddle()).sections[1].finalLong, null);
  assert.equal(buildPreview(warmThenMain()).sections[0].finalLong, null);
});
