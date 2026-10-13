import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateWorkout } from "../src/generator.js";

// Logic-layer tests for generateWorkout (issue #7). The contract is the scope
// comment on #7: generateWorkout(library, options = {}, rng = Math.random)
// returns { options, randomized, durationSeconds, slots, blocks, warnings }.

const library = JSON.parse(
  readFileSync(new URL("../exercises.json", import.meta.url), "utf8")
);
const byId = Object.fromEntries(library.map((e) => [e.id, e]));

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

// One entry per exercise in the main section: drops the "right" half of a
// perSide pair and circuit rounds after the first, so adjacency rules can be
// checked on the order in which distinct moves are introduced.
function mainEntries(result) {
  return result.slots.filter((s) => {
    if (s.section !== "main" || s.side === "right") return false;
    const block = result.blocks.find((b) => b.id === s.blockId);
    return !(block && block.kind === "circuit" && s.round > 1);
  });
}

function focusOverlap(a, b) {
  if (a.includes("full") || b.includes("full")) return false;
  return a.some((f) => b.includes(f));
}

function assertNoBackToBackFocus(result) {
  const e = mainEntries(result);
  for (let i = 1; i < e.length; i++) {
    const a = byId[e[i - 1].exerciseId];
    const b = byId[e[i].exerciseId];
    assert.ok(
      !focusOverlap(a.focus, b.focus),
      `back-to-back focus overlap: ${a.id} -> ${b.id}`
    );
  }
}

function assertNoThreePatternsInARow(result) {
  const e = mainEntries(result).map((s) => byId[s.exerciseId].pattern);
  for (let i = 2; i < e.length; i++) {
    assert.ok(
      !(e[i] === e[i - 1] && e[i] === e[i - 2]),
      `pattern "${e[i]}" three times in a row at ${i - 2}..${i}`
    );
  }
}

function assertNoRepeatedExercise(result) {
  const ids = mainEntries(result).map((s) => s.exerciseId);
  assert.equal(new Set(ids).size, ids.length, `repeated exercise in ${ids}`);
}

// ---------------------------------------------------------------------------
// Shape, determinism, purity
// ---------------------------------------------------------------------------

test("returns options, randomized, durationSeconds, slots, blocks and warnings", () => {
  const r = generateWorkout(library, {}, mulberry32(1));
  assert.equal(typeof r.options, "object");
  assert.ok(Array.isArray(r.randomized));
  assert.equal(typeof r.durationSeconds, "number");
  assert.ok(Array.isArray(r.slots) && r.slots.length > 0);
  assert.ok(Array.isArray(r.blocks) && r.blocks.length > 0);
  assert.ok(Array.isArray(r.warnings));
});

test("works with only a library argument (default options and default rng)", () => {
  const r = generateWorkout(library);
  assert.ok(r.slots.length > 0);
  assert.equal(r.durationSeconds, r.slots[r.slots.length - 1].endSec);
});

test("same seed and same inputs produce deep-equal output", () => {
  for (const seed of seeds(10)) {
    const a = generateWorkout(library, {}, mulberry32(seed));
    const b = generateWorkout(library, {}, mulberry32(seed));
    assert.deepEqual(a, b);
  }
});

test("different seeds produce different workouts", () => {
  const sigs = new Set(
    seeds(20).map((seed) =>
      JSON.stringify(generateWorkout(library, {}, mulberry32(seed)))
    )
  );
  assert.ok(sigs.size > 1);
});

test("does not mutate the input library or options (frozen inputs do not throw)", () => {
  const lib = deepFreeze(structuredClone(library));
  const opts = deepFreeze({
    totalSeconds: 600,
    workSeconds: 40,
    restSeconds: 20,
    warmup: { enabled: true, countsInTotal: true },
    position: { mode: "none", values: ["face-down"] },
    focus: { mode: "none", values: ["deep-core"] },
    circuit: { size: 3, rounds: 2 },
    maxDifficulty: 3,
  });
  for (const seed of seeds(10)) {
    assert.doesNotThrow(() => generateWorkout(lib, opts, mulberry32(seed)));
  }
  assert.deepEqual(lib, library);
});

// ---------------------------------------------------------------------------
// Randomized options and resolved options
// ---------------------------------------------------------------------------

test("unset time options are randomized within range and step, and listed in randomized", () => {
  const totals = new Set();
  const works = new Set();
  const rests = new Set();
  for (const seed of seeds(50)) {
    const r = generateWorkout(library, {}, mulberry32(seed));
    const { totalSeconds, workSeconds, restSeconds } = r.options;
    assert.ok(totalSeconds >= 480 && totalSeconds <= 720 && totalSeconds % 60 === 0,
      `total ${totalSeconds}`);
    assert.ok(workSeconds >= 30 && workSeconds <= 50 && workSeconds % 5 === 0,
      `work ${workSeconds}`);
    assert.ok(restSeconds >= 10 && restSeconds <= 30 && restSeconds % 5 === 0,
      `rest ${restSeconds}`);
    for (const k of ["totalSeconds", "workSeconds", "restSeconds"]) {
      assert.ok(r.randomized.includes(k), `${k} should be listed in randomized`);
    }
    totals.add(totalSeconds);
    works.add(workSeconds);
    rests.add(restSeconds);
  }
  assert.ok(totals.size > 1 && works.size > 1 && rests.size > 1,
    "randomized values should vary across seeds");
});

test("explicit time options are kept as given and not listed in randomized", () => {
  const r = generateWorkout(
    library,
    { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null },
    mulberry32(3)
  );
  assert.equal(r.options.totalSeconds, 600);
  assert.equal(r.options.workSeconds, 40);
  assert.equal(r.options.restSeconds, 20);
  for (const k of ["totalSeconds", "workSeconds", "restSeconds"]) {
    assert.ok(!r.randomized.includes(k), `${k} should not be randomized`);
  }
});

test("only the unset time options are randomized when some are given", () => {
  const r = generateWorkout(library, { totalSeconds: 600 }, mulberry32(4));
  assert.equal(r.options.totalSeconds, 600);
  assert.ok(!r.randomized.includes("totalSeconds"));
  assert.ok(r.randomized.includes("workSeconds"));
  assert.ok(r.randomized.includes("restSeconds"));
});

// ---------------------------------------------------------------------------
// Timeline and duration
// ---------------------------------------------------------------------------

test("slot index matches array position and the first slot starts at 0", () => {
  for (const seed of seeds(20)) {
    const { slots } = generateWorkout(library, {}, mulberry32(seed));
    slots.forEach((s, i) => assert.equal(s.index, i));
    assert.equal(slots[0].startSec, 0);
  }
});

test("each slot ends at start plus work, and the next starts after the rest", () => {
  for (const seed of seeds(30)) {
    const { slots } = generateWorkout(library, {}, mulberry32(seed));
    for (let i = 0; i < slots.length; i++) {
      assert.equal(slots[i].endSec, slots[i].startSec + slots[i].workSeconds);
      if (i + 1 < slots.length) {
        assert.equal(slots[i + 1].startSec, slots[i].endSec + slots[i].restAfter);
      }
    }
  }
});

test("the final slot has no rest after it and durationSeconds is its endSec", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(library, {}, mulberry32(seed));
    const last = r.slots[r.slots.length - 1];
    assert.equal(last.restAfter, 0);
    assert.equal(r.durationSeconds, last.endSec);
  }
});

const COMBOS = [
  [600, 40, 20], // divides evenly
  [600, 45, 25], // leftover time
  [540, 50, 30], // leftover time
  [480, 30, 10],
  [720, 50, 30],
  [660, 35, 15],
];

for (const [total, work, rest] of COMBOS) {
  test(`duration is exactly ${total}s with work ${work}s / rest ${rest}s (no circuit, no warm-up)`, () => {
    for (const seed of seeds(10)) {
      const r = generateWorkout(
        library,
        { totalSeconds: total, workSeconds: work, restSeconds: rest, circuit: null },
        mulberry32(seed)
      );
      assert.equal(r.durationSeconds, total, `seed ${seed}`);
      assert.equal(r.slots[r.slots.length - 1].endSec, total, `seed ${seed}`);
    }
  });

  test(`duration is exactly ${total}s with work ${work}s / rest ${rest}s when the roulette may add a circuit`, () => {
    for (const seed of seeds(10)) {
      const r = generateWorkout(
        library,
        { totalSeconds: total, workSeconds: work, restSeconds: rest },
        mulberry32(seed)
      );
      assert.equal(r.durationSeconds, total, `seed ${seed}`);
    }
  });
}

test("non-final slots use the resolved work and rest lengths, with no rest between the two sides of a move", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(
      library,
      { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null },
      mulberry32(seed)
    );
    r.slots.slice(0, -1).forEach((s) => {
      assert.equal(s.workSeconds, 40, `slot ${s.index} work`);
      assert.equal(s.restAfter, s.side === "left" ? 0 : 20, `slot ${s.index} rest`);
    });
  }
});

test("the final slot absorbs leftover time, so it is never shorter than the work length", () => {
  for (const [total, work, rest] of COMBOS) {
    for (const seed of seeds(10)) {
      const r = generateWorkout(
        library,
        { totalSeconds: total, workSeconds: work, restSeconds: rest, circuit: null },
        mulberry32(seed)
      );
      assert.ok(r.slots[r.slots.length - 1].workSeconds >= work);
    }
  }
});

test("a per-exercise workSeconds in the library overrides the default work length", () => {
  const mk = (id, pattern, workSeconds) => ({
    id,
    name: id,
    focus: ["full"], // "full" overlaps nothing, so focus never constrains order here
    position: "back",
    pattern,
    difficulty: 1,
    perSide: false,
    formCue: "cue",
    ...(workSeconds ? { workSeconds } : {}),
  });
  const lib = [
    mk("a", "static"),
    mk("b", "dynamic"),
    mk("c", "rotational"),
    mk("d", "static"),
    mk("quick", "dynamic", 25),
    mk("f", "rotational"),
  ];
  let seen = 0;
  for (const seed of seeds(30)) {
    const r = generateWorkout(
      lib,
      { totalSeconds: 300, workSeconds: 40, restSeconds: 20, circuit: null },
      mulberry32(seed)
    );
    assert.equal(r.durationSeconds, 300);
    // The final slot absorbs leftover time, so only check non-final slots.
    for (const s of r.slots.slice(0, -1)) {
      if (s.exerciseId === "quick") {
        assert.equal(s.workSeconds, 25);
        seen++;
      } else {
        assert.equal(s.workSeconds, 40);
      }
    }
  }
  assert.ok(seen > 0, "override move never appeared in a non-final slot");
});

// ---------------------------------------------------------------------------
// perSide expansion
// ---------------------------------------------------------------------------

test("perSide exercise expands into consecutive left then right slots with the full work time", () => {
  let pairs = 0;
  for (const seed of seeds(40)) {
    const r = generateWorkout(
      library,
      { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null },
      mulberry32(seed)
    );
    r.slots.forEach((s, i) => {
      if (s.side === "left") {
        const next = r.slots[i + 1];
        assert.ok(next, "left slot must be followed by a right slot");
        assert.equal(next.side, "right");
        assert.equal(next.exerciseId, s.exerciseId);
        assert.equal(s.workSeconds, 40, "left side gets the full work time");
        assert.ok(next.workSeconds >= 40, "right side gets at least the full work time");
        assert.equal(s.restAfter, 0);
        pairs++;
      }
      if (s.side === "right") {
        const prev = r.slots[i - 1];
        assert.ok(prev && prev.side === "left" && prev.exerciseId === s.exerciseId);
      }
    });
  }
  assert.ok(pairs > 0, "no perSide move showed up across 40 seeds");
});

test("only perSide library moves get sides; every other slot has side null", () => {
  for (const seed of seeds(40)) {
    const r = generateWorkout(library, {}, mulberry32(seed));
    for (const s of r.slots) {
      if (byId[s.exerciseId].perSide) {
        assert.ok(s.side === "left" || s.side === "right", `${s.exerciseId} needs a side`);
      } else {
        assert.equal(s.side, null, `${s.exerciseId} should have no side`);
      }
    }
  }
});

test("the rest after a perSide pair comes after the right side", () => {
  for (const seed of seeds(40)) {
    const r = generateWorkout(
      library,
      { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null },
      mulberry32(seed)
    );
    r.slots.forEach((s, i) => {
      if (s.side === "right" && i < r.slots.length - 1) assert.equal(s.restAfter, 20);
    });
  }
});

test("slot name and exerciseId come from the library entry", () => {
  const r = generateWorkout(library, {}, mulberry32(8));
  for (const s of r.slots) {
    assert.ok(byId[s.exerciseId], `unknown exercise ${s.exerciseId}`);
    assert.equal(s.name, byId[s.exerciseId].name);
  }
});

// ---------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------

const WARM = {
  totalSeconds: 600,
  workSeconds: 40,
  restSeconds: 20,
  circuit: null,
  warmup: { enabled: true },
};

test("warm-up unset means no warm-up slots", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(library, {}, mulberry32(seed));
    assert.ok(r.slots.every((s) => s.section === "main"));
    assert.ok(r.blocks.every((b) => b.kind !== "warmup"));
  }
});

test("warm-up enabled puts two warm-up moves first, then the main section", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(library, WARM, mulberry32(seed));
    const sections = r.slots.map((s) => s.section);
    const firstMain = sections.indexOf("main");
    assert.ok(firstMain > 0, "warm-up slots must come first");
    assert.ok(sections.slice(0, firstMain).every((x) => x === "warmup"));
    assert.ok(sections.slice(firstMain).every((x) => x === "main"));
    const warmIds = new Set(r.slots.slice(0, firstMain).map((s) => s.exerciseId));
    assert.equal(warmIds.size, 2, "exactly two distinct warm-up moves");
  }
});

test("a perSide warm-up move counts as one move but two slots", () => {
  let sawPerSide = false;
  for (const seed of seeds(60)) {
    const r = generateWorkout(library, WARM, mulberry32(seed));
    const warm = r.slots.filter((s) => s.section === "warmup");
    const moves = new Set(warm.map((s) => s.exerciseId)).size;
    const expectedSlots = [...new Set(warm.map((s) => s.exerciseId))]
      .map((id) => (byId[id].perSide ? 2 : 1))
      .reduce((a, b) => a + b, 0);
    assert.equal(moves, 2);
    assert.equal(warm.length, expectedSlots);
    if (warm.some((s) => s.side)) sawPerSide = true;
  }
  assert.ok(sawPerSide, "bird-dog never drawn as a warm-up across 60 seeds");
});

test("warm-up moves are drawn only from warmup eligible/only entries at difficulty 1", () => {
  const lib = [
    ...library,
    {
      id: "hard-warmup",
      name: "Hard Warmup",
      focus: ["deep-core"],
      position: "back",
      warmup: "eligible",
      pattern: "static",
      difficulty: 2,
      perSide: false,
      formCue: "cue",
    },
  ];
  const libById = Object.fromEntries(lib.map((e) => [e.id, e]));
  for (const seed of seeds(40)) {
    const r = generateWorkout(lib, WARM, mulberry32(seed));
    for (const s of r.slots.filter((x) => x.section === "warmup")) {
      const e = libById[s.exerciseId];
      assert.ok(["eligible", "only"].includes(e.warmup), `${e.id} not warm-up eligible`);
      assert.equal(e.difficulty, 1, `${e.id} is not difficulty 1`);
    }
  }
});

test("warm-up moves never reappear in the main section", () => {
  for (const seed of seeds(50)) {
    const r = generateWorkout(library, WARM, mulberry32(seed));
    const warm = new Set(r.slots.filter((s) => s.section === "warmup").map((s) => s.exerciseId));
    for (const s of r.slots.filter((x) => x.section === "main")) {
      assert.ok(!warm.has(s.exerciseId), `${s.exerciseId} is in both sections`);
    }
  }
});

test("warmup: only moves never appear in the main section even with warm-up disabled", () => {
  const only = new Set(library.filter((e) => e.warmup === "only").map((e) => e.id));
  assert.ok(only.size > 0);
  for (const seed of seeds(50)) {
    const r = generateWorkout(library, {}, mulberry32(seed));
    for (const s of r.slots) assert.ok(!only.has(s.exerciseId), `${s.exerciseId} leaked`);
  }
});

test("warm-up ignores the position and focus filters", () => {
  // No face-down or upper-abs move is warm-up eligible, so a warm-up can only
  // exist here if the filters were ignored for it.
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      {
        ...WARM,
        position: { mode: "any", values: ["face-down"] },
        focus: { mode: "none", values: ["lower-abs"] },
      },
      mulberry32(seed)
    );
    const warm = r.slots.filter((s) => s.section === "warmup");
    assert.ok(warm.length >= 2);
    for (const s of r.slots.filter((x) => x.section === "main")) {
      assert.equal(byId[s.exerciseId].position, "face-down");
    }
    assert.equal(r.durationSeconds, 600);
  }
});

test("warm-up counted in the total (default) keeps durationSeconds equal to totalSeconds", () => {
  for (const seed of seeds(20)) {
    const a = generateWorkout(library, WARM, mulberry32(seed));
    const b = generateWorkout(
      library,
      { ...WARM, warmup: { enabled: true, countsInTotal: true } },
      mulberry32(seed)
    );
    assert.equal(a.durationSeconds, 600);
    assert.equal(b.durationSeconds, 600);
  }
});

test("warm-up not counted in the total adds the warm-up time on top of totalSeconds", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      { ...WARM, warmup: { enabled: true, countsInTotal: false } },
      mulberry32(seed)
    );
    const warm = r.slots.filter((s) => s.section === "warmup");
    const lastWarm = warm[warm.length - 1];
    const firstMain = r.slots.find((s) => s.section === "main");
    assert.ok(r.durationSeconds > 600);
    // Warm-up time is the warm-up end (lower bound) up to the start of main
    // (upper bound, includes the rest after the last warm-up move).
    assert.ok(r.durationSeconds >= 600 + lastWarm.endSec, `seed ${seed}`);
    assert.ok(r.durationSeconds <= 600 + firstMain.startSec, `seed ${seed}`);
  }
});

test("warm-up uses the normal work length", () => {
  const r = generateWorkout(library, WARM, mulberry32(5));
  for (const s of r.slots.filter((x) => x.section === "warmup")) {
    assert.equal(s.workSeconds, 40);
  }
});

// ---------------------------------------------------------------------------
// Filters (main section)
// ---------------------------------------------------------------------------

const SHORT = { totalSeconds: 300, workSeconds: 40, restSeconds: 20, circuit: null };

function mainIds(r) {
  return r.slots.filter((s) => s.section === "main").map((s) => s.exerciseId);
}

test("position mode any keeps only moves in the listed positions", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      { ...SHORT, position: { mode: "any", values: ["back", "face-down"] } },
      mulberry32(seed)
    );
    for (const id of mainIds(r)) {
      assert.ok(["back", "face-down"].includes(byId[id].position), id);
    }
  }
});

test("position mode none excludes moves in the listed positions", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      { ...SHORT, position: { mode: "none", values: ["back"] } },
      mulberry32(seed)
    );
    for (const id of mainIds(r)) assert.notEqual(byId[id].position, "back", id);
  }
});

test("focus mode any keeps moves whose focus array overlaps the listed values", () => {
  const seen = new Set();
  for (const seed of seeds(40)) {
    const r = generateWorkout(
      library,
      { ...SHORT, focus: { mode: "any", values: ["obliques"] } },
      mulberry32(seed)
    );
    for (const id of mainIds(r)) {
      assert.ok(byId[id].focus.includes("obliques"), id);
      seen.add(id);
    }
  }
  // Bicycle crunch is [upper-abs, obliques]: matches via secondary focus.
  assert.ok(seen.has("bicycle-crunch"), "multi-focus overlap should count as a match");
});

test("focus mode none excludes a move if any of its focus values is listed", () => {
  for (const seed of seeds(40)) {
    const r = generateWorkout(
      library,
      { ...SHORT, focus: { mode: "none", values: ["obliques"] } },
      mulberry32(seed)
    );
    for (const id of mainIds(r)) {
      assert.ok(!byId[id].focus.includes("obliques"), `${id} has obliques focus`);
    }
  }
});

test("position and focus filters combine", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      {
        ...SHORT,
        position: { mode: "any", values: ["back"] },
        focus: { mode: "any", values: ["lower-abs"] },
      },
      mulberry32(seed)
    );
    for (const id of mainIds(r)) {
      assert.equal(byId[id].position, "back");
      assert.ok(byId[id].focus.includes("lower-abs"));
    }
  }
});

test("empty filter values mean no filtering", () => {
  const positions = new Set();
  for (const seed of seeds(40)) {
    const r = generateWorkout(
      library,
      {
        ...SHORT,
        position: { mode: "any", values: [] },
        focus: { mode: "none", values: [] },
      },
      mulberry32(seed)
    );
    for (const id of mainIds(r)) positions.add(byId[id].position);
  }
  // Every position that has a main-pool move in the library should show up.
  const expected = [...new Set(library.filter((e) => e.warmup !== "only").map((e) => e.position))].sort();
  assert.deepEqual([...positions].sort(), expected);
});

test("maxDifficulty excludes harder moves", () => {
  for (const max of [1, 2]) {
    for (const seed of seeds(20)) {
      const r = generateWorkout(library, { ...SHORT, maxDifficulty: max }, mulberry32(seed));
      for (const id of mainIds(r)) {
        assert.ok(byId[id].difficulty <= max, `${id} exceeds maxDifficulty ${max}`);
      }
    }
  }
});

test("unset maxDifficulty allows difficulty 3 moves", () => {
  const seen = new Set();
  for (const seed of seeds(60)) {
    const r = generateWorkout(library, SHORT, mulberry32(seed));
    for (const id of mainIds(r)) seen.add(byId[id].difficulty);
  }
  assert.ok(seen.has(3));
});

test("throws a clear error when the filters match no exercise", () => {
  assert.throws(
    () =>
      generateWorkout(
        library,
        {
          position: { mode: "any", values: ["face-down"] },
          focus: { mode: "any", values: ["upper-abs"] },
        },
        mulberry32(1)
      ),
    (err) => err instanceof Error && /filter|exercise/i.test(err.message)
  );
});

test("throws when the library is empty", () => {
  assert.throws(
    () => generateWorkout([], {}, mulberry32(1)),
    (err) => err instanceof Error && /filter|exercise/i.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Ordering rules (default library)
// ---------------------------------------------------------------------------

const FIXED = { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null };

test("no back-to-back overlapping focus (fixed 600/40/20, 50 seeds)", () => {
  for (const seed of seeds(50)) assertNoBackToBackFocus(generateWorkout(library, FIXED, mulberry32(seed)));
});

test("no pattern three times in a row (fixed 600/40/20, 50 seeds)", () => {
  for (const seed of seeds(50)) assertNoThreePatternsInARow(generateWorkout(library, FIXED, mulberry32(seed)));
});

test("no exercise repeated within a workout (fixed 600/40/20, 50 seeds)", () => {
  for (const seed of seeds(50)) assertNoRepeatedExercise(generateWorkout(library, FIXED, mulberry32(seed)));
});

test("ordering rules hold with fully default options whenever the generator did not have to relax them", () => {
  // A workout that warns ("too few moves") is allowed to relax soft rules, so
  // only warning-free workouts are checked. Guard against this going vacuous.
  let checked = 0;
  for (const seed of seeds(50)) {
    const r = generateWorkout(library, {}, mulberry32(seed));
    if (r.warnings.length > 0) continue;
    checked++;
    assertNoBackToBackFocus(r);
    assertNoThreePatternsInARow(r);
    assertNoRepeatedExercise(r);
  }
  assert.ok(checked >= 25, `only ${checked}/50 default workouts were warning-free`);
});

test("a move with full focus overlaps with nothing, so it may sit next to any other move", () => {
  // Library of only full-focus moves: back-to-back is fine, repeats are not.
  const lib = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({
    id,
    name: id,
    focus: ["full"],
    position: "back",
    pattern: ["static", "dynamic", "rotational"][i % 3],
    difficulty: 1,
    perSide: false,
    formCue: "cue",
  }));
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      lib,
      { totalSeconds: 300, workSeconds: 40, restSeconds: 20, circuit: null },
      mulberry32(seed)
    );
    assert.equal(r.durationSeconds, 300);
    assertNoRepeatedExercise(r);
  }
});

// ---------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------

const CIRCUIT = {
  totalSeconds: 720,
  workSeconds: 40,
  restSeconds: 20,
  circuit: { size: 3, rounds: 2 },
};

function circuitOf(r) {
  const cs = r.blocks.filter((b) => b.kind === "circuit");
  assert.equal(cs.length, 1, "expected exactly one circuit block");
  return cs[0];
}

test("a requested circuit yields exactly one circuit block with the requested rounds", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(library, CIRCUIT, mulberry32(seed));
    const c = circuitOf(r);
    assert.equal(c.rounds, 2);
    assert.ok(c.firstSlot <= c.lastSlot);
    assert.equal(r.durationSeconds, 720);
  }
});

test("circuit slots repeat the same exercise sequence once per round, with round 1 then 2", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(library, CIRCUIT, mulberry32(seed));
    const c = circuitOf(r);
    const inBlock = r.slots.slice(c.firstSlot, c.lastSlot + 1);
    assert.ok(inBlock.every((s) => s.blockId === c.id));
    const round1 = inBlock.filter((s) => s.round === 1);
    const round2 = inBlock.filter((s) => s.round === 2);
    assert.equal(round1.length + round2.length, inBlock.length);
    assert.equal(round1.length, round2.length);
    // Rounds are contiguous: all of round 1, then all of round 2.
    assert.deepEqual(inBlock.slice(0, round1.length), round1);
    const key = (s) => `${s.exerciseId}/${s.side}`;
    assert.deepEqual(round1.map(key), round2.map(key));
    // Three distinct moves in the circuit.
    assert.equal(new Set(round1.map((s) => s.exerciseId)).size, 3);
  }
});

test("the circuit's exercises do not appear anywhere else in the workout", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(library, CIRCUIT, mulberry32(seed));
    const c = circuitOf(r);
    const ids = new Set(r.slots.slice(c.firstSlot, c.lastSlot + 1).map((s) => s.exerciseId));
    r.slots.forEach((s, i) => {
      if (i < c.firstSlot || i > c.lastSlot) {
        assert.ok(!ids.has(s.exerciseId), `${s.exerciseId} also appears outside the circuit`);
      }
    });
  }
});

test("the circuit sits after the warm-up and is a main-section block", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(
      library,
      { ...CIRCUIT, warmup: { enabled: true } },
      mulberry32(seed)
    );
    const c = circuitOf(r);
    const lastWarm = r.slots.map((s) => s.section).lastIndexOf("warmup");
    assert.ok(c.firstSlot > lastWarm, "circuit starts before the warm-up ends");
    assert.ok(r.slots.slice(c.firstSlot, c.lastSlot + 1).every((s) => s.section === "main"));
    assert.equal(r.durationSeconds, 720);
  }
});

test("the circuit lands at different points across seeds", () => {
  const firsts = new Set(
    seeds(40).map((seed) => circuitOf(generateWorkout(library, CIRCUIT, mulberry32(seed))).firstSlot)
  );
  assert.ok(firsts.size > 1);
});

test("resolved options echo the requested circuit and do not list it as randomized", () => {
  const r = generateWorkout(library, CIRCUIT, mulberry32(2));
  assert.deepEqual(r.options.circuit, { size: 3, rounds: 2 });
  assert.ok(!r.randomized.includes("circuit"));
});

test("circuit: null yields no circuit block", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(library, { circuit: null }, mulberry32(seed));
    assert.ok(r.blocks.every((b) => b.kind !== "circuit"));
    assert.ok(r.slots.every((s) => r.blocks.find((b) => b.id === s.blockId).kind !== "circuit"));
  }
});

test("ordering rules still hold around a circuit (focus, pattern, no repeats outside circuit rounds)", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(library, CIRCUIT, mulberry32(seed));
    if (r.warnings.length > 0) continue;
    assertNoBackToBackFocus(r);
    assertNoThreePatternsInARow(r);
    assertNoRepeatedExercise(r);
  }
});

test("a circuit too large for the time shrinks or is dropped with a warning, and the duration stays exact", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      { totalSeconds: 240, workSeconds: 40, restSeconds: 20, circuit: { size: 5, rounds: 4 } },
      mulberry32(seed)
    );
    assert.equal(r.durationSeconds, 240, `seed ${seed}`);
    const circuits = r.blocks.filter((b) => b.kind === "circuit");
    if (circuits.length === 0) {
      assert.ok(r.warnings.length > 0, "dropped circuit must come with a warning");
    } else {
      assert.equal(circuits.length, 1);
      const c = circuits[0];
      const moves = new Set(r.slots.slice(c.firstSlot, c.lastSlot + 1).map((s) => s.exerciseId)).size;
      assert.ok(c.rounds <= 4 && moves <= 5);
      assert.ok(c.rounds < 4 || moves < 5, "circuit should have shrunk");
    }
  }
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function assertBlocksCoverSlots(r) {
  assert.equal(r.blocks[0].firstSlot, 0);
  for (let i = 1; i < r.blocks.length; i++) {
    assert.equal(r.blocks[i].firstSlot, r.blocks[i - 1].lastSlot + 1, "gap or overlap between blocks");
  }
  assert.equal(r.blocks[r.blocks.length - 1].lastSlot, r.slots.length - 1);
  assert.equal(new Set(r.blocks.map((b) => b.id)).size, r.blocks.length, "block ids must be unique");
  for (const b of r.blocks) {
    assert.ok(["warmup", "straight", "circuit"].includes(b.kind), `bad kind ${b.kind}`);
    assert.ok(Number.isInteger(b.rounds) && b.rounds >= 1);
    assert.ok(b.firstSlot <= b.lastSlot);
  }
  for (const s of r.slots) {
    const b = r.blocks.find((x) => x.id === s.blockId);
    assert.ok(b, `slot ${s.index} has unknown blockId ${s.blockId}`);
    assert.ok(s.index >= b.firstSlot && s.index <= b.lastSlot, `slot ${s.index} outside its block`);
  }
}

test("blocks cover the slots in order with no gaps, and every slot's blockId matches a block", () => {
  for (const seed of seeds(40)) {
    assertBlocksCoverSlots(generateWorkout(library, {}, mulberry32(seed)));
  }
});

test("blocks stay consistent with warm-up and a circuit together", () => {
  for (const seed of seeds(30)) {
    const r = generateWorkout(library, { ...CIRCUIT, warmup: { enabled: true } }, mulberry32(seed));
    assertBlocksCoverSlots(r);
    assert.equal(r.blocks[0].kind, "warmup");
    assert.equal(r.blocks.filter((b) => b.kind === "warmup").length, 1);
  }
});

test("warm-up block spans exactly the warm-up slots and non-circuit blocks have one round", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(library, WARM, mulberry32(seed));
    const warm = r.blocks.find((b) => b.kind === "warmup");
    const lastWarmIdx = r.slots.map((s) => s.section).lastIndexOf("warmup");
    assert.equal(warm.firstSlot, 0);
    assert.equal(warm.lastSlot, lastWarmIdx);
    for (const b of r.blocks.filter((x) => x.kind !== "circuit")) assert.equal(b.rounds, 1);
  }
});

// ---------------------------------------------------------------------------
// Too few moves
// ---------------------------------------------------------------------------

// These use a small made-up library so they keep testing the "too few moves"
// path however large exercises.json grows: 3 side moves (the filtered pool) and
// 6 back moves (filtered out).
const NARROW_LIB = [
  ["s1", "side", "obliques", "static"],
  ["s2", "side", "deep-core", "dynamic"],
  ["s3", "side", "lower-abs", "rotational"],
  ["b1", "back", "upper-abs", "static"],
  ["b2", "back", "obliques", "dynamic"],
  ["b3", "back", "deep-core", "rotational"],
  ["b4", "back", "lower-abs", "static"],
  ["b5", "back", "upper-abs", "dynamic"],
  ["b6", "back", "obliques", "rotational"],
].map(([id, position, focus, pattern]) => ({
  id,
  name: id,
  focus: [focus],
  position,
  pattern,
  difficulty: 1,
  perSide: false,
  formCue: "cue",
}));
const NARROW_OPTIONS = {
  totalSeconds: 600,
  workSeconds: 40,
  restSeconds: 20,
  circuit: null,
  position: { mode: "any", values: ["side"] },
};

test("with a narrow filter the workout still reaches the exact duration and warns", () => {
  const narrowById = Object.fromEntries(NARROW_LIB.map((e) => [e.id, e]));
  for (const seed of seeds(20)) {
    const r = generateWorkout(NARROW_LIB, NARROW_OPTIONS, mulberry32(seed));
    assert.equal(r.durationSeconds, 600, `seed ${seed}`);
    assert.ok(r.warnings.length > 0, `seed ${seed}: expected a warning`);
    for (const id of mainIds(r)) assert.equal(narrowById[id].position, "side");
  }
});

test("with too few moves, exercises repeat but never back-to-back", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(NARROW_LIB, NARROW_OPTIONS, mulberry32(seed));
    const entries = r.slots.filter((s) => s.side !== "right");
    const ids = entries.map((s) => s.exerciseId);
    assert.ok(new Set(ids).size < ids.length, "expected at least one repeated exercise");
    for (let i = 1; i < ids.length; i++) {
      assert.notEqual(ids[i], ids[i - 1], `back-to-back repeat at ${i}`);
    }
  }
});

test("a workout with enough moves produces no warnings", () => {
  for (const seed of seeds(20)) {
    const r = generateWorkout(
      library,
      { totalSeconds: 300, workSeconds: 40, restSeconds: 20, circuit: null },
      mulberry32(seed)
    );
    assert.deepEqual(r.warnings, []);
  }
});
