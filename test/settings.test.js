import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIMITS,
  DIFFICULTIES,
  POSITIONS,
  FOCUSES,
  DEFAULTS,
  quickOptions,
  advancedOptions,
  buildOptions,
  randomizeAdvanced,
  sanitize,
} from "../src/settings.js";
import { generateWorkout, RANGES, CIRCUIT_SIZE, CIRCUIT_ROUNDS } from "../src/generator.js";

// Logic-layer tests for src/settings.js (issue #19). The module turns the
// settings-screen state into generateWorkout options, randomizes the Advanced
// screen, and validates untrusted stored settings. Pure: no DOM, no
// localStorage, rng injected.

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

const clone = (o) => JSON.parse(JSON.stringify(o));

// Every value on a { min, max, step } grid.
const gridOf = ({ min, max, step }) =>
  Array.from({ length: (max - min) / step + 1 }, (_, i) => min + i * step);

const onGrid = (v, { min, max, step }) =>
  Number.isInteger(v) && v >= min && v <= max && (v - min) % step === 0;

// Counts how many times the wrapped rng is called.
function countingRng(seed) {
  const inner = mulberry32(seed);
  const rng = () => {
    rng.calls++;
    return inner();
  };
  rng.calls = 0;
  return rng;
}

// The literal defaults from the contract, independent of the implementation.
const EXPECTED_DEFAULTS = {
  mode: "quick",
  quick: { totalSeconds: 600, difficulty: "medium", warmup: false },
  advanced: {
    totalSeconds: 600,
    workSeconds: 40,
    restSeconds: 20,
    warmup: { enabled: false, countsInTotal: true },
    position: { mode: "any", values: [] },
    focus: { mode: "any", values: [] },
    circuit: false,
  },
};

// A fully valid settings object that differs from the defaults everywhere.
const validSettings = () => ({
  mode: "advanced",
  quick: { totalSeconds: 900, difficulty: "hard", warmup: true },
  advanced: {
    totalSeconds: 480,
    workSeconds: 45,
    restSeconds: 15,
    warmup: { enabled: true, countsInTotal: false },
    position: { mode: "none", values: ["back", "side"] },
    focus: { mode: "any", values: ["obliques", "full"] },
    circuit: true,
  },
});

const advancedState = (over = {}) => ({ ...clone(EXPECTED_DEFAULTS.advanced), ...over });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("LIMITS holds the slider ranges for total, work and rest", () => {
  assert.deepEqual(LIMITS, {
    totalSeconds: { min: 300, max: 1200, step: 60 },
    workSeconds: { min: 20, max: 60, step: 5 },
    restSeconds: { min: 5, max: 45, step: 5 },
  });
});

test("every LIMITS range is a whole number of steps wide", () => {
  for (const [key, { min, max, step }] of Object.entries(LIMITS)) {
    assert.equal((max - min) % step, 0, key);
  }
});

test("the generator's random RANGES sit inside LIMITS and on its step grid", () => {
  for (const key of Object.keys(LIMITS)) {
    for (const v of gridOf(RANGES[key])) {
      assert.ok(onGrid(v, LIMITS[key]), `${key} ${v}`);
    }
  }
});

test("DIFFICULTIES maps easy, medium and hard to 1, 2 and 3", () => {
  assert.deepEqual(DIFFICULTIES, { easy: 1, medium: 2, hard: 3 });
});

test("POSITIONS lists the four body positions", () => {
  assert.deepEqual(POSITIONS, ["back", "face-down", "side", "standing"]);
});

test("FOCUSES lists the five focus areas", () => {
  assert.deepEqual(FOCUSES, ["upper-abs", "lower-abs", "obliques", "deep-core", "full"]);
});

test("POSITIONS and FOCUSES match the values used in exercises.json", () => {
  for (const ex of library) {
    assert.ok(POSITIONS.includes(ex.position), `${ex.id} position ${ex.position}`);
    for (const f of ex.focus) assert.ok(FOCUSES.includes(f), `${ex.id} focus ${f}`);
  }
});

test("DEFAULTS starts in Quick Start with 10:00, medium and no warm-up", () => {
  assert.equal(DEFAULTS.mode, "quick");
  assert.deepEqual(DEFAULTS.quick, { totalSeconds: 600, difficulty: "medium", warmup: false });
});

test("DEFAULTS Advanced matches the generator's usual 10:00 / 40s / 20s with no filters", () => {
  assert.deepEqual(DEFAULTS.advanced, EXPECTED_DEFAULTS.advanced);
});

test("every DEFAULTS value is inside LIMITS and on its step grid", () => {
  for (const key of Object.keys(LIMITS)) {
    assert.ok(onGrid(DEFAULTS.advanced[key], LIMITS[key]), key);
  }
  assert.ok(onGrid(DEFAULTS.quick.totalSeconds, LIMITS.totalSeconds));
  assert.ok(Object.hasOwn(DIFFICULTIES, DEFAULTS.quick.difficulty));
});

// ---------------------------------------------------------------------------
// quickOptions
// ---------------------------------------------------------------------------

for (const [difficulty, level] of [["easy", 1], ["medium", 2], ["hard", 3]]) {
  for (const warmup of [false, true]) {
    test(`quickOptions maps ${difficulty} with warm-up ${warmup ? "on" : "off"} to maxDifficulty ${level}`, () => {
      const opts = quickOptions({ totalSeconds: 720, difficulty, warmup });
      assert.deepEqual(opts, {
        totalSeconds: 720,
        maxDifficulty: level,
        warmup: { enabled: warmup, countsInTotal: true },
      });
    });
  }
}

test("quickOptions leaves work, rest, circuit, position and focus keys out entirely", () => {
  const opts = quickOptions({ totalSeconds: 600, difficulty: "medium", warmup: true });
  for (const key of ["workSeconds", "restSeconds", "circuit", "position", "focus"]) {
    assert.ok(!(key in opts), `${key} should be absent`);
  }
});

test("quickOptions returns exactly the keys totalSeconds, maxDifficulty and warmup", () => {
  const opts = quickOptions(DEFAULTS.quick);
  assert.deepEqual(Object.keys(opts).sort(), ["maxDifficulty", "totalSeconds", "warmup"]);
});

test("quickOptions warm-up always counts inside the total", () => {
  for (const warmup of [false, true]) {
    assert.equal(quickOptions({ totalSeconds: 600, difficulty: "easy", warmup }).warmup.countsInTotal, true);
  }
});

test("quickOptions coerces a truthy warmup value to a real boolean", () => {
  const opts = quickOptions({ totalSeconds: 600, difficulty: "easy", warmup: 1 });
  assert.equal(opts.warmup.enabled, true);
});

test("quickOptions passes totalSeconds through at the slider extremes", () => {
  assert.equal(quickOptions({ totalSeconds: 300, difficulty: "easy", warmup: false }).totalSeconds, 300);
  assert.equal(quickOptions({ totalSeconds: 1200, difficulty: "hard", warmup: false }).totalSeconds, 1200);
});

test("quickOptions does not mutate its input", () => {
  const input = deepFreeze({ totalSeconds: 600, difficulty: "hard", warmup: true });
  assert.doesNotThrow(() => quickOptions(input));
  assert.deepEqual(input, { totalSeconds: 600, difficulty: "hard", warmup: true });
});

test("quickOptions returns a fresh object each call", () => {
  const input = { totalSeconds: 600, difficulty: "easy", warmup: true };
  const a = quickOptions(input);
  const b = quickOptions(input);
  assert.notEqual(a, b);
  assert.notEqual(a.warmup, b.warmup);
});

// ---------------------------------------------------------------------------
// advancedOptions
// ---------------------------------------------------------------------------

test("advancedOptions with circuit off passes every setting through and sets circuit null", () => {
  const input = validSettings().advanced;
  input.circuit = false;
  assert.deepEqual(advancedOptions(input, mulberry32(1)), {
    totalSeconds: 480,
    workSeconds: 45,
    restSeconds: 15,
    warmup: { enabled: true, countsInTotal: false },
    position: { mode: "none", values: ["back", "side"] },
    focus: { mode: "any", values: ["obliques", "full"] },
    circuit: null,
  });
});

test("advancedOptions returns exactly the generator option keys (no maxDifficulty)", () => {
  const opts = advancedOptions(advancedState(), mulberry32(1));
  assert.deepEqual(Object.keys(opts).sort(), [
    "circuit",
    "focus",
    "position",
    "restSeconds",
    "totalSeconds",
    "warmup",
    "workSeconds",
  ]);
  assert.ok(!("maxDifficulty" in opts));
});

test("advancedOptions with circuit off sets circuit to null, not undefined or false", () => {
  const opts = advancedOptions(advancedState({ circuit: false }), mulberry32(1));
  assert.ok("circuit" in opts);
  assert.equal(opts.circuit, null);
});

test("advancedOptions with circuit on returns { size, rounds }", () => {
  const opts = advancedOptions(advancedState({ circuit: true }), mulberry32(1));
  assert.deepEqual(Object.keys(opts.circuit).sort(), ["rounds", "size"]);
});

test("advancedOptions circuit size is an integer in CIRCUIT_SIZE and rounds in CIRCUIT_ROUNDS", () => {
  for (const seed of seeds(200)) {
    const { size, rounds } = advancedOptions(advancedState({ circuit: true }), mulberry32(seed)).circuit;
    assert.ok(Number.isInteger(size) && size >= CIRCUIT_SIZE.min && size <= CIRCUIT_SIZE.max, `size ${size}`);
    assert.ok(
      Number.isInteger(rounds) && rounds >= CIRCUIT_ROUNDS.min && rounds <= CIRCUIT_ROUNDS.max,
      `rounds ${rounds}`
    );
  }
});

test("advancedOptions circuit covers every size 2-5 and every rounds 2-4 across seeds", () => {
  const sizes = new Set();
  const rounds = new Set();
  for (const seed of seeds(300)) {
    const c = advancedOptions(advancedState({ circuit: true }), mulberry32(seed)).circuit;
    sizes.add(c.size);
    rounds.add(c.rounds);
  }
  assert.deepEqual([...sizes].sort(), [2, 3, 4, 5]);
  assert.deepEqual([...rounds].sort(), [2, 3, 4]);
});

test("advancedOptions circuit hits the minimum when the rng always returns 0", () => {
  const { circuit } = advancedOptions(advancedState({ circuit: true }), () => 0);
  assert.deepEqual(circuit, { size: CIRCUIT_SIZE.min, rounds: CIRCUIT_ROUNDS.min });
});

test("advancedOptions circuit hits the maximum when the rng always returns just under 1", () => {
  const { circuit } = advancedOptions(advancedState({ circuit: true }), () => 0.9999999);
  assert.deepEqual(circuit, { size: CIRCUIT_SIZE.max, rounds: CIRCUIT_ROUNDS.max });
});

test("advancedOptions is deterministic for a given seed", () => {
  for (const seed of [1, 7, 42]) {
    const a = advancedOptions(advancedState({ circuit: true }), mulberry32(seed));
    const b = advancedOptions(advancedState({ circuit: true }), mulberry32(seed));
    assert.deepEqual(a, b);
  }
});

test("advancedOptions with circuit off never calls the rng", () => {
  const rng = countingRng(3);
  advancedOptions(advancedState({ circuit: false }), rng);
  assert.equal(rng.calls, 0);
});

test("advancedOptions with circuit on consumes the rng", () => {
  const rng = countingRng(3);
  advancedOptions(advancedState({ circuit: true }), rng);
  assert.ok(rng.calls > 0);
});

test("advancedOptions works without an rng argument when circuit is off", () => {
  assert.equal(advancedOptions(advancedState({ circuit: false })).circuit, null);
});

test("advancedOptions falls back to Math.random when circuit is on and no rng is given", () => {
  const { circuit } = advancedOptions(advancedState({ circuit: true }));
  assert.ok(circuit.size >= CIRCUIT_SIZE.min && circuit.size <= CIRCUIT_SIZE.max);
  assert.ok(circuit.rounds >= CIRCUIT_ROUNDS.min && circuit.rounds <= CIRCUIT_ROUNDS.max);
});

test("advancedOptions copies filter value arrays instead of sharing them", () => {
  const input = advancedState({
    position: { mode: "any", values: ["back"] },
    focus: { mode: "none", values: ["obliques"] },
  });
  const opts = advancedOptions(input, mulberry32(1));
  assert.notEqual(opts.position.values, input.position.values);
  assert.notEqual(opts.focus.values, input.focus.values);
  assert.notEqual(opts.position, input.position);
  assert.notEqual(opts.focus, input.focus);
  assert.deepEqual(opts.position.values, ["back"]);
  assert.deepEqual(opts.focus.values, ["obliques"]);
});

test("advancedOptions result can be mutated without touching the input", () => {
  const input = advancedState({ position: { mode: "any", values: ["back"] } });
  const opts = advancedOptions(input, mulberry32(1));
  opts.position.values.push("side");
  opts.warmup.enabled = true;
  assert.deepEqual(input.position.values, ["back"]);
  assert.equal(input.warmup.enabled, false);
});

test("advancedOptions does not mutate its input", () => {
  const input = deepFreeze(advancedState({ circuit: true, position: { mode: "none", values: ["side"] } }));
  const snapshot = clone(input);
  assert.doesNotThrow(() => advancedOptions(input, mulberry32(5)));
  assert.deepEqual(input, snapshot);
});

test("advancedOptions keeps the warm-up outside-the-total choice", () => {
  const opts = advancedOptions(advancedState({ warmup: { enabled: true, countsInTotal: false } }), mulberry32(1));
  assert.deepEqual(opts.warmup, { enabled: true, countsInTotal: false });
});

// ---------------------------------------------------------------------------
// buildOptions
// ---------------------------------------------------------------------------

test("buildOptions in quick mode returns quickOptions of the quick settings", () => {
  const s = validSettings();
  s.mode = "quick";
  assert.deepEqual(buildOptions(s, mulberry32(1)), quickOptions(s.quick));
});

test("buildOptions in advanced mode returns advancedOptions of the advanced settings", () => {
  const s = validSettings();
  assert.deepEqual(buildOptions(s, mulberry32(9)), advancedOptions(s.advanced, mulberry32(9)));
});

test("buildOptions in advanced mode passes the rng through to the circuit roll", () => {
  const s = validSettings();
  const rng = countingRng(2);
  buildOptions(s, rng);
  assert.ok(rng.calls > 0);
});

test("buildOptions in quick mode never touches the rng", () => {
  const s = validSettings();
  s.mode = "quick";
  const rng = countingRng(2);
  buildOptions(s, rng);
  assert.equal(rng.calls, 0);
});

test("buildOptions ignores the other mode's settings", () => {
  const a = clone(EXPECTED_DEFAULTS);
  const b = clone(EXPECTED_DEFAULTS);
  b.advanced.totalSeconds = 1200;
  assert.deepEqual(buildOptions(a), buildOptions(b));
});

test("buildOptions throws RangeError for an unknown mode", () => {
  assert.throws(() => buildOptions({ ...validSettings(), mode: "expert" }), RangeError);
});

test("buildOptions throws RangeError when mode is missing", () => {
  const { mode, ...rest } = validSettings();
  assert.throws(() => buildOptions(rest), RangeError);
});

test("buildOptions mode matching is case sensitive", () => {
  assert.throws(() => buildOptions({ ...validSettings(), mode: "Quick" }), RangeError);
});

test("buildOptions does not mutate its input", () => {
  const s = deepFreeze(validSettings());
  const snapshot = clone(s);
  assert.doesNotThrow(() => buildOptions(s, mulberry32(1)));
  assert.deepEqual(s, snapshot);
});

// ---------------------------------------------------------------------------
// randomizeAdvanced
// ---------------------------------------------------------------------------

test("randomizeAdvanced returns a full Advanced state with the expected keys", () => {
  const r = randomizeAdvanced(DEFAULTS.advanced, mulberry32(1));
  assert.deepEqual(Object.keys(r).sort(), [
    "circuit",
    "focus",
    "position",
    "restSeconds",
    "totalSeconds",
    "warmup",
    "workSeconds",
  ]);
  assert.deepEqual(Object.keys(r.warmup).sort(), ["countsInTotal", "enabled"]);
});

test("randomizeAdvanced total, work and rest land on the generator's RANGES grid", () => {
  for (const seed of seeds(200)) {
    const r = randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed));
    for (const key of ["totalSeconds", "workSeconds", "restSeconds"]) {
      assert.ok(onGrid(r[key], RANGES[key]), `${key} ${r[key]} (seed ${seed})`);
    }
  }
});

test("randomizeAdvanced results always lie inside LIMITS on the slider step grid", () => {
  for (const seed of seeds(200)) {
    const r = randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed));
    for (const key of Object.keys(LIMITS)) {
      assert.ok(onGrid(r[key], LIMITS[key]), `${key} ${r[key]} (seed ${seed})`);
    }
  }
});

for (const key of ["totalSeconds", "workSeconds", "restSeconds"]) {
  test(`randomizeAdvanced reaches every ${key} grid value across seeds`, () => {
    const seen = new Set();
    for (const seed of seeds(400)) seen.add(randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed))[key]);
    assert.deepEqual([...seen].sort((a, b) => a - b), gridOf(RANGES[key]));
  });
}

test("randomizeAdvanced produces both warm-up on and warm-up off across seeds", () => {
  const seen = new Set();
  for (const seed of seeds(100)) seen.add(randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed)).warmup.enabled);
  assert.deepEqual([...seen].sort(), [false, true]);
});

test("randomizeAdvanced produces both circuit on and circuit off across seeds", () => {
  const seen = new Set();
  for (const seed of seeds(100)) seen.add(randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed)).circuit);
  assert.deepEqual([...seen].sort(), [false, true]);
});

test("randomizeAdvanced warm-up flags are real booleans and the warm-up always counts in the total", () => {
  for (const seed of seeds(100)) {
    const r = randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed));
    assert.equal(typeof r.warmup.enabled, "boolean");
    assert.equal(r.warmup.countsInTotal, true);
    assert.equal(typeof r.circuit, "boolean");
  }
});

test("randomizeAdvanced clears position and focus filters even when the current state has some", () => {
  const current = advancedState({
    position: { mode: "none", values: ["back", "side"] },
    focus: { mode: "any", values: ["obliques"] },
  });
  for (const seed of seeds(20)) {
    const r = randomizeAdvanced(current, mulberry32(seed));
    assert.deepEqual(r.position, { mode: "any", values: [] });
    assert.deepEqual(r.focus, { mode: "any", values: [] });
  }
});

test("randomizeAdvanced is deterministic for a given seed", () => {
  for (const seed of [1, 2, 99]) {
    assert.deepEqual(
      randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed)),
      randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed))
    );
  }
});

test("randomizeAdvanced gives different results for different seeds", () => {
  const results = new Set(seeds(50).map((s) => JSON.stringify(randomizeAdvanced(DEFAULTS.advanced, mulberry32(s)))));
  assert.ok(results.size > 10);
});

test("randomizeAdvanced does not depend on the current state's values", () => {
  const other = advancedState({
    totalSeconds: 1200,
    workSeconds: 60,
    restSeconds: 45,
    circuit: true,
    warmup: { enabled: true, countsInTotal: false },
    position: { mode: "none", values: ["standing"] },
  });
  assert.deepEqual(
    randomizeAdvanced(DEFAULTS.advanced, mulberry32(11)),
    randomizeAdvanced(other, mulberry32(11))
  );
});

test("randomizeAdvanced does not mutate the current state", () => {
  const current = deepFreeze(advancedState({ position: { mode: "none", values: ["back"] } }));
  const snapshot = clone(current);
  assert.doesNotThrow(() => randomizeAdvanced(current, mulberry32(1)));
  assert.deepEqual(current, snapshot);
});

test("randomizeAdvanced returns a new object that shares no references with the input", () => {
  const current = advancedState({ position: { mode: "none", values: ["back"] } });
  const r = randomizeAdvanced(current, mulberry32(1));
  assert.notEqual(r, current);
  assert.notEqual(r.warmup, current.warmup);
  assert.notEqual(r.position, current.position);
  assert.notEqual(r.position.values, current.position.values);
  assert.notEqual(r.focus, current.focus);
});

test("randomizeAdvanced results are never shared with DEFAULTS", () => {
  const r = randomizeAdvanced(DEFAULTS.advanced, mulberry32(1));
  r.position.values.push("back");
  r.focus.values.push("full");
  assert.deepEqual(DEFAULTS.advanced.position.values, []);
  assert.deepEqual(DEFAULTS.advanced.focus.values, []);
});

test("randomizeAdvanced result passes sanitize unchanged", () => {
  for (const seed of seeds(100)) {
    const state = randomizeAdvanced(DEFAULTS.advanced, mulberry32(seed));
    const stored = { ...clone(EXPECTED_DEFAULTS), mode: "advanced", advanced: state };
    assert.deepEqual(sanitize(stored).advanced, state);
  }
});

// ---------------------------------------------------------------------------
// sanitize: structure and round-tripping
// ---------------------------------------------------------------------------

test("sanitize round-trips a fully valid settings object unchanged", () => {
  const s = validSettings();
  assert.deepEqual(sanitize(s), s);
});

test("sanitize round-trips the defaults unchanged", () => {
  assert.deepEqual(sanitize(clone(EXPECTED_DEFAULTS)), EXPECTED_DEFAULTS);
});

test("sanitize round-trips settings that went through JSON, like localStorage does", () => {
  const s = validSettings();
  assert.deepEqual(sanitize(JSON.parse(JSON.stringify(s))), s);
});

test("sanitize does not mutate its input", () => {
  const input = deepFreeze({
    mode: "bogus",
    quick: { totalSeconds: 610, difficulty: "nope", warmup: "yes", extra: 1 },
    advanced: { workSeconds: 99999, position: { mode: "all", values: ["back", "back", "x"] }, extra: 2 },
    extra: 3,
  });
  const snapshot = clone(input);
  assert.doesNotThrow(() => sanitize(input));
  assert.deepEqual(input, snapshot);
});

test("sanitize returns a new object that does not alias its input", () => {
  const s = validSettings();
  const out = sanitize(s);
  assert.notEqual(out, s);
  assert.notEqual(out.quick, s.quick);
  assert.notEqual(out.advanced, s.advanced);
  assert.notEqual(out.advanced.warmup, s.advanced.warmup);
  assert.notEqual(out.advanced.position.values, s.advanced.position.values);
  assert.notEqual(out.advanced.focus.values, s.advanced.focus.values);
});

test("sanitize drops unknown extra keys at every level", () => {
  const s = validSettings();
  s.extra = 1;
  s.quick.extra = 2;
  s.advanced.extra = 3;
  s.advanced.warmup.extra = 4;
  s.advanced.position.extra = 5;
  s.advanced.focus.extra = 6;
  assert.deepEqual(sanitize(s), validSettings());
});

test("sanitize is idempotent on messy input", () => {
  const messy = {
    mode: "advanced",
    quick: { totalSeconds: 611, difficulty: "HARD", warmup: 1 },
    advanced: {
      totalSeconds: "600",
      workSeconds: 62,
      restSeconds: 6,
      warmup: { enabled: "true" },
      position: { mode: "all", values: ["side", "side", "bogus", 5, "back"] },
      focus: "obliques",
      circuit: "yes",
    },
  };
  const once = sanitize(messy);
  assert.deepEqual(sanitize(once), once);
});

test("sanitize is idempotent on every defaulting case", () => {
  for (const input of [null, undefined, "x", 3, [], {}, { mode: "advanced" }]) {
    const once = sanitize(input);
    assert.deepEqual(sanitize(once), once);
  }
});

// ---------------------------------------------------------------------------
// sanitize: non-object input
// ---------------------------------------------------------------------------

for (const [label, input] of [
  ["null", null],
  ["undefined", undefined],
  ["a string", '{"mode":"advanced"}'],
  ["a number", 42],
  ["a boolean", true],
  ["an array", [1, 2, 3]],
  ["an array of settings", [validSettings()]],
]) {
  test(`sanitize turns ${label} into a copy of the defaults`, () => {
    assert.deepEqual(sanitize(input), EXPECTED_DEFAULTS);
  });
}

test("sanitize turns an empty object into the defaults", () => {
  assert.deepEqual(sanitize({}), EXPECTED_DEFAULTS);
});

test("sanitize fills in a missing advanced block from the defaults and keeps the quick block", () => {
  const out = sanitize({ mode: "quick", quick: { totalSeconds: 900, difficulty: "easy", warmup: true } });
  assert.deepEqual(out.quick, { totalSeconds: 900, difficulty: "easy", warmup: true });
  assert.deepEqual(out.advanced, EXPECTED_DEFAULTS.advanced);
});

test("sanitize fills in a missing quick block from the defaults and keeps the advanced block", () => {
  const s = validSettings();
  delete s.quick;
  const out = sanitize(s);
  assert.deepEqual(out.quick, EXPECTED_DEFAULTS.quick);
  assert.deepEqual(out.advanced, validSettings().advanced);
});

for (const bad of [null, "quick", 5, []]) {
  test(`sanitize replaces a non-object quick block (${JSON.stringify(bad)}) with the defaults`, () => {
    assert.deepEqual(sanitize({ mode: "quick", quick: bad }).quick, EXPECTED_DEFAULTS.quick);
  });
  test(`sanitize replaces a non-object advanced block (${JSON.stringify(bad)}) with the defaults`, () => {
    assert.deepEqual(sanitize({ mode: "advanced", advanced: bad }).advanced, EXPECTED_DEFAULTS.advanced);
  });
}

test("sanitize never returns DEFAULTS or its nested objects by reference", () => {
  const out = sanitize(null);
  assert.notEqual(out, DEFAULTS);
  assert.notEqual(out.quick, DEFAULTS.quick);
  assert.notEqual(out.advanced, DEFAULTS.advanced);
  assert.notEqual(out.advanced.warmup, DEFAULTS.advanced.warmup);
  assert.notEqual(out.advanced.position, DEFAULTS.advanced.position);
  assert.notEqual(out.advanced.position.values, DEFAULTS.advanced.position.values);
  assert.notEqual(out.advanced.focus.values, DEFAULTS.advanced.focus.values);
});

test("mutating a sanitize result deeply never changes DEFAULTS or later results", () => {
  const first = sanitize(null);
  first.mode = "advanced";
  first.quick.totalSeconds = 1;
  first.quick.difficulty = "hard";
  first.advanced.workSeconds = 1;
  first.advanced.warmup.enabled = true;
  first.advanced.position.values.push("back");
  first.advanced.focus.mode = "none";
  first.advanced.focus.values.push("full");
  assert.deepEqual(sanitize(null), EXPECTED_DEFAULTS);
  assert.deepEqual(DEFAULTS, EXPECTED_DEFAULTS);
});

// ---------------------------------------------------------------------------
// sanitize: mode
// ---------------------------------------------------------------------------

test("sanitize keeps mode advanced", () => {
  assert.equal(sanitize({ mode: "advanced" }).mode, "advanced");
});

test("sanitize keeps mode quick", () => {
  assert.equal(sanitize({ mode: "quick" }).mode, "quick");
});

for (const bad of ["expert", "Advanced", "", null, 1, true, ["advanced"], {}]) {
  test(`sanitize falls back to quick for mode ${JSON.stringify(bad)}`, () => {
    assert.equal(sanitize({ mode: bad }).mode, "quick");
  });
}

// ---------------------------------------------------------------------------
// sanitize: numbers (clamp and snap)
// ---------------------------------------------------------------------------

const numberCases = [
  // [label, quick-or-advanced key path, limits key, default]
  ["quick totalSeconds", (v) => ({ quick: { totalSeconds: v } }), (o) => o.quick.totalSeconds, "totalSeconds", 600],
  ["advanced totalSeconds", (v) => ({ advanced: { totalSeconds: v } }), (o) => o.advanced.totalSeconds, "totalSeconds", 600],
  ["advanced workSeconds", (v) => ({ advanced: { workSeconds: v } }), (o) => o.advanced.workSeconds, "workSeconds", 40],
  ["advanced restSeconds", (v) => ({ advanced: { restSeconds: v } }), (o) => o.advanced.restSeconds, "restSeconds", 20],
];

for (const [label, build, read, limitKey, dflt] of numberCases) {
  const { min, max, step } = LIMITS[limitKey];

  test(`sanitize keeps a valid ${label}`, () => {
    assert.equal(read(sanitize(build(min + step))), min + step);
  });

  test(`sanitize keeps ${label} at exactly min and max`, () => {
    assert.equal(read(sanitize(build(min))), min);
    assert.equal(read(sanitize(build(max))), max);
  });

  test(`sanitize clamps ${label} below min and above max`, () => {
    assert.equal(read(sanitize(build(min - step * 3))), min);
    assert.equal(read(sanitize(build(-5))), min);
    assert.equal(read(sanitize(build(0))), min);
    assert.equal(read(sanitize(build(max + step * 3))), max);
    assert.equal(read(sanitize(build(99999))), max);
  });

  test(`sanitize snaps an off-grid ${label} to the nearest step`, () => {
    const base = min + step;
    assert.equal(read(sanitize(build(base + Math.floor(step / 2) - 1))), base);
    assert.equal(read(sanitize(build(base + Math.ceil(step / 2) + 1))), base + step);
  });

  test(`sanitize resets a non-numeric ${label} to the default ${dflt}`, () => {
    for (const bad of [NaN, Infinity, -Infinity, "600", "abc", "", null, undefined, true, [], {}, [600]]) {
      assert.equal(read(sanitize(build(bad))), dflt, JSON.stringify(bad) ?? String(bad));
    }
  });
}

test("sanitize snaps total 610 to 600", () => {
  assert.equal(sanitize({ quick: { totalSeconds: 610 } }).quick.totalSeconds, 600);
});

test("sanitize snaps rest 6 to 5", () => {
  assert.equal(sanitize({ advanced: { restSeconds: 6 } }).advanced.restSeconds, 5);
});

test("sanitize snaps work 42 to 40 and 43 to 45", () => {
  assert.equal(sanitize({ advanced: { workSeconds: 42 } }).advanced.workSeconds, 40);
  assert.equal(sanitize({ advanced: { workSeconds: 43 } }).advanced.workSeconds, 45);
});

test("sanitize snaps a fractional value to the grid", () => {
  assert.equal(sanitize({ advanced: { workSeconds: 40.4 } }).advanced.workSeconds, 40);
});

test("sanitize snaps total relative to min, not zero (min 300 with step 60 shares the 60 grid)", () => {
  assert.equal(sanitize({ quick: { totalSeconds: 329 } }).quick.totalSeconds, 300);
  assert.equal(sanitize({ quick: { totalSeconds: 331 } }).quick.totalSeconds, 360);
});

test("sanitize output numbers are always integers on the LIMITS grid", () => {
  const rng = mulberry32(77);
  for (let i = 0; i < 300; i++) {
    const v = (rng() - 0.3) * 2000;
    const out = sanitize({ quick: { totalSeconds: v }, advanced: { totalSeconds: v, workSeconds: v / 10, restSeconds: v / 20 } });
    assert.ok(onGrid(out.quick.totalSeconds, LIMITS.totalSeconds), `quick total ${v}`);
    assert.ok(onGrid(out.advanced.totalSeconds, LIMITS.totalSeconds), `adv total ${v}`);
    assert.ok(onGrid(out.advanced.workSeconds, LIMITS.workSeconds), `work ${v / 10}`);
    assert.ok(onGrid(out.advanced.restSeconds, LIMITS.restSeconds), `rest ${v / 20}`);
  }
});

// ---------------------------------------------------------------------------
// sanitize: difficulty and booleans
// ---------------------------------------------------------------------------

for (const d of Object.keys(DIFFICULTIES)) {
  test(`sanitize keeps difficulty ${d}`, () => {
    assert.equal(sanitize({ quick: { difficulty: d } }).quick.difficulty, d);
  });
}

for (const bad of ["EASY", "extreme", "", 1, 2, null, true, ["easy"], "toString", "__proto__"]) {
  test(`sanitize falls back to medium for difficulty ${JSON.stringify(bad)}`, () => {
    assert.equal(sanitize({ quick: { difficulty: bad } }).quick.difficulty, "medium");
  });
}

test("sanitize keeps quick warmup true and false", () => {
  assert.equal(sanitize({ quick: { warmup: true } }).quick.warmup, true);
  assert.equal(sanitize({ quick: { warmup: false } }).quick.warmup, false);
});

test("sanitize resets a non-boolean quick warmup to false", () => {
  for (const bad of ["true", 1, 0, null, {}, [], "yes"]) {
    assert.equal(sanitize({ quick: { warmup: bad } }).quick.warmup, false, JSON.stringify(bad));
  }
});

test("sanitize keeps advanced warmup enabled and countsInTotal booleans", () => {
  const w = { enabled: true, countsInTotal: false };
  assert.deepEqual(sanitize({ advanced: { warmup: w } }).advanced.warmup, w);
});

test("sanitize defaults advanced warmup.enabled to false and countsInTotal to true when missing", () => {
  assert.deepEqual(sanitize({ advanced: { warmup: {} } }).advanced.warmup, { enabled: false, countsInTotal: true });
});

test("sanitize defaults a non-boolean warmup.enabled to false and countsInTotal to true", () => {
  const out = sanitize({ advanced: { warmup: { enabled: "true", countsInTotal: "no" } } });
  assert.deepEqual(out.advanced.warmup, { enabled: false, countsInTotal: true });
});

test("sanitize judges the two advanced warm-up flags independently", () => {
  const out = sanitize({ advanced: { warmup: { enabled: true, countsInTotal: "no" } } });
  assert.deepEqual(out.advanced.warmup, { enabled: true, countsInTotal: true });
  const out2 = sanitize({ advanced: { warmup: { enabled: 1, countsInTotal: false } } });
  assert.deepEqual(out2.advanced.warmup, { enabled: false, countsInTotal: false });
});

test("sanitize replaces a non-object advanced warmup (such as a bare boolean) with the defaults", () => {
  for (const bad of [true, false, "on", 1, null, []]) {
    assert.deepEqual(
      sanitize({ advanced: { warmup: bad } }).advanced.warmup,
      { enabled: false, countsInTotal: true },
      JSON.stringify(bad)
    );
  }
});

test("sanitize keeps circuit true and false", () => {
  assert.equal(sanitize({ advanced: { circuit: true } }).advanced.circuit, true);
  assert.equal(sanitize({ advanced: { circuit: false } }).advanced.circuit, false);
});

test("sanitize resets a non-boolean circuit to false, including a stored options-style object", () => {
  for (const bad of ["true", 1, null, {}, { size: 3, rounds: 2 }, []]) {
    assert.equal(sanitize({ advanced: { circuit: bad } }).advanced.circuit, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// sanitize: filters
// ---------------------------------------------------------------------------

for (const key of ["position", "focus"]) {
  const known = key === "position" ? POSITIONS : FOCUSES;
  const read = (out) => out.advanced[key];
  const make = (f) => ({ advanced: { [key]: f } });

  test(`sanitize keeps a valid ${key} filter with mode any`, () => {
    const f = { mode: "any", values: [known[0], known[1]] };
    assert.deepEqual(read(sanitize(make(f))), f);
  });

  test(`sanitize keeps a valid ${key} filter with mode none`, () => {
    const f = { mode: "none", values: [known[2]] };
    assert.deepEqual(read(sanitize(make(f))), f);
  });

  test(`sanitize accepts every known ${key} value`, () => {
    const f = { mode: "any", values: [...known] };
    assert.deepEqual(read(sanitize(make(f))).values, known);
  });

  for (const bad of ["all", "ANY", "", null, 1, true, undefined]) {
    test(`sanitize falls back to mode any for ${key} mode ${JSON.stringify(bad)}`, () => {
      const out = read(sanitize(make({ mode: bad, values: [known[0]] })));
      assert.equal(out.mode, "any");
      assert.deepEqual(out.values, [known[0]]);
    });
  }

  test(`sanitize drops unknown ${key} values and non-strings`, () => {
    const f = { mode: "any", values: [known[0], "bogus", 7, null, {}, known[1], ["x"], true] };
    assert.deepEqual(read(sanitize(make(f))).values, [known[0], known[1]]);
  });

  test(`sanitize drops values that belong to the other filter from ${key}`, () => {
    const other = key === "position" ? FOCUSES[0] : POSITIONS[0];
    assert.deepEqual(read(sanitize(make({ mode: "any", values: [other, known[0]] }))).values, [known[0]]);
  });

  test(`sanitize removes duplicate ${key} values and keeps first-occurrence order`, () => {
    const f = { mode: "none", values: [known[2], known[0], known[2], known[1], known[0]] };
    assert.deepEqual(read(sanitize(make(f))).values, [known[2], known[0], known[1]]);
  });

  test(`sanitize treats ${key} values as case sensitive`, () => {
    assert.deepEqual(read(sanitize(make({ mode: "any", values: [known[0].toUpperCase()] }))).values, []);
  });

  for (const bad of ["back", 5, null, {}, { 0: known[0], length: 1 }, true]) {
    test(`sanitize turns non-array ${key} values (${JSON.stringify(bad)}) into []`, () => {
      assert.deepEqual(read(sanitize(make({ mode: "none", values: bad }))), { mode: "none", values: [] });
    });
  }

  test(`sanitize turns a missing ${key} values into []`, () => {
    assert.deepEqual(read(sanitize(make({ mode: "none" }))), { mode: "none", values: [] });
  });

  for (const bad of [null, "back", 5, [], true]) {
    test(`sanitize replaces a non-object ${key} filter (${JSON.stringify(bad)}) with any and no values`, () => {
      assert.deepEqual(read(sanitize(make(bad))), { mode: "any", values: [] });
    });
  }
}

test("sanitize does not treat prototype names as valid filter values", () => {
  const out = sanitize({ advanced: { position: { mode: "any", values: ["toString", "__proto__", "constructor"] } } });
  assert.deepEqual(out.advanced.position.values, []);
});

// ---------------------------------------------------------------------------
// Integration with generateWorkout (real library)
// ---------------------------------------------------------------------------

const mainSlots = (w) => w.slots.filter((s) => s.section === "main");
const warmupSlots = (w) => w.slots.filter((s) => s.section === "warmup");

for (const difficulty of Object.keys(DIFFICULTIES)) {
  for (const warmup of [false, true]) {
    test(`Quick Start ${difficulty} with warm-up ${warmup ? "on" : "off"} generates exactly 10:00 for many seeds`, () => {
      const opts = quickOptions({ totalSeconds: 600, difficulty, warmup });
      for (const seed of seeds(40)) {
        let w;
        assert.doesNotThrow(() => {
          w = generateWorkout(library, opts, mulberry32(seed));
        }, `seed ${seed}`);
        assert.ok(w.slots.length > 0, `seed ${seed}`);
        assert.equal(w.durationSeconds, 600, `seed ${seed}`);
        assert.equal(warmupSlots(w).length > 0, warmup, `seed ${seed}`);
      }
    });
  }
}

test("Quick Start generates the requested total at the slider extremes and in between", () => {
  for (const totalSeconds of gridOf(LIMITS.totalSeconds)) {
    for (const difficulty of Object.keys(DIFFICULTIES)) {
      for (const warmup of [false, true]) {
        const opts = quickOptions({ totalSeconds, difficulty, warmup });
        for (const seed of seeds(5)) {
          const w = generateWorkout(library, opts, mulberry32(seed));
          assert.ok(w.slots.length > 0);
          assert.equal(w.durationSeconds, totalSeconds, `${totalSeconds} ${difficulty} warmup=${warmup} seed ${seed}`);
        }
      }
    }
  }
});

test("Quick Start easy workouts contain only difficulty-1 main moves", () => {
  const opts = quickOptions({ totalSeconds: 600, difficulty: "easy", warmup: true });
  for (const seed of seeds(60)) {
    const w = generateWorkout(library, opts, mulberry32(seed));
    for (const s of mainSlots(w)) {
      assert.equal(byId[s.exerciseId].difficulty, 1, `${s.exerciseId} (seed ${seed})`);
    }
  }
});

test("Quick Start medium workouts contain only difficulty 1-2 main moves", () => {
  const opts = quickOptions({ totalSeconds: 600, difficulty: "medium", warmup: false });
  for (const seed of seeds(60)) {
    const w = generateWorkout(library, opts, mulberry32(seed));
    for (const s of mainSlots(w)) {
      assert.ok(byId[s.exerciseId].difficulty <= 2, `${s.exerciseId} (seed ${seed})`);
    }
  }
});

test("Quick Start hard workouts can include difficulty-3 moves", () => {
  const opts = quickOptions({ totalSeconds: 600, difficulty: "hard", warmup: false });
  const hard = seeds(80).some((seed) =>
    mainSlots(generateWorkout(library, opts, mulberry32(seed))).some((s) => byId[s.exerciseId].difficulty === 3)
  );
  assert.ok(hard);
});

test("Quick Start resolved maxDifficulty matches the chosen difficulty", () => {
  for (const [difficulty, level] of Object.entries(DIFFICULTIES)) {
    const w = generateWorkout(library, quickOptions({ totalSeconds: 600, difficulty, warmup: false }), mulberry32(1));
    assert.equal(w.options.maxDifficulty, level);
  }
});

test("Quick Start leaves work, rest and circuit for the generator to randomize but fixes the total", () => {
  const opts = quickOptions(DEFAULTS.quick);
  const w = generateWorkout(library, opts, mulberry32(3));
  assert.ok(w.randomized.includes("workSeconds"));
  assert.ok(w.randomized.includes("restSeconds"));
  assert.ok(w.randomized.includes("circuit"));
  assert.ok(!w.randomized.includes("totalSeconds"));
});

test("Quick Start work and rest vary between seeds and circuits sometimes appear", () => {
  const opts = quickOptions(DEFAULTS.quick);
  const works = new Set();
  const rests = new Set();
  let circuits = 0;
  for (const seed of seeds(120)) {
    const w = generateWorkout(library, opts, mulberry32(seed));
    works.add(w.options.workSeconds);
    rests.add(w.options.restSeconds);
    if (w.options.circuit) circuits++;
  }
  assert.ok(works.size > 1);
  assert.ok(rests.size > 1);
  assert.ok(circuits > 0 && circuits < 120);
});

test("Quick Start with the same seed gives the same workout", () => {
  const opts = quickOptions({ totalSeconds: 720, difficulty: "hard", warmup: true });
  assert.deepEqual(generateWorkout(library, opts, mulberry32(8)), generateWorkout(library, opts, mulberry32(8)));
});

test("randomizeAdvanced then advancedOptions then generateWorkout never throws and fills the requested time", () => {
  for (const seed of seeds(250)) {
    const rng = mulberry32(seed);
    const state = randomizeAdvanced(DEFAULTS.advanced, rng);
    const opts = advancedOptions(state, rng);
    let w;
    assert.doesNotThrow(() => {
      w = generateWorkout(library, opts, rng);
    }, `seed ${seed}`);
    assert.ok(w.slots.length > 0, `seed ${seed}`);
    // Randomize always counts the warm-up inside the total, so the total is exact.
    assert.equal(w.durationSeconds, state.totalSeconds, `seed ${seed}`);
  }
});

test("a randomized Advanced screen leaves nothing for the generator to randomize", () => {
  for (const seed of seeds(60)) {
    const rng = mulberry32(seed);
    const opts = advancedOptions(randomizeAdvanced(DEFAULTS.advanced, rng), rng);
    const w = generateWorkout(library, opts, rng);
    assert.deepEqual(w.randomized, [], `seed ${seed}`);
  }
});

test("a randomized Advanced screen produces workouts with the chosen work and rest lengths", () => {
  for (const seed of seeds(60)) {
    const rng = mulberry32(seed);
    const state = randomizeAdvanced(DEFAULTS.advanced, rng);
    const w = generateWorkout(library, advancedOptions(state, rng), rng);
    assert.equal(w.options.workSeconds, state.workSeconds);
    assert.equal(w.options.restSeconds, state.restSeconds);
    assert.equal(w.options.totalSeconds, state.totalSeconds);
  }
});

test("a randomized Advanced screen with warm-up on starts with warm-up slots", () => {
  let checked = 0;
  for (const seed of seeds(120)) {
    const rng = mulberry32(seed);
    const state = randomizeAdvanced(DEFAULTS.advanced, rng);
    if (!state.warmup.enabled) continue;
    const w = generateWorkout(library, advancedOptions(state, rng), rng);
    assert.ok(warmupSlots(w).length > 0, `seed ${seed}`);
    assert.equal(w.slots[0].section, "warmup");
    checked++;
  }
  assert.ok(checked > 0);
});

test("Advanced with circuit off generates no circuit block", () => {
  for (const seed of seeds(40)) {
    const rng = mulberry32(seed);
    const opts = advancedOptions(advancedState({ circuit: false }), rng);
    const w = generateWorkout(library, opts, rng);
    assert.equal(w.options.circuit, null, `seed ${seed}`);
    assert.ok(!w.blocks.some((b) => b.kind === "circuit"), `seed ${seed}`);
  }
});

test("Advanced with circuit on generates a circuit within the rolled size and rounds", () => {
  let seen = 0;
  for (const seed of seeds(80)) {
    const rng = mulberry32(seed);
    const opts = advancedOptions(advancedState({ circuit: true }), rng);
    const w = generateWorkout(library, opts, rng);
    assert.equal(w.durationSeconds, 600, `seed ${seed}`);
    if (w.options.circuit) {
      seen++;
      assert.ok(w.options.circuit.size <= opts.circuit.size, `seed ${seed}`);
      assert.ok(w.options.circuit.rounds <= opts.circuit.rounds, `seed ${seed}`);
    }
  }
  assert.ok(seen > 0);
});

test("Advanced default state generates exactly 10:00 at 40s work and 20s rest", () => {
  const opts = advancedOptions(DEFAULTS.advanced, mulberry32(1));
  const w = generateWorkout(library, opts, mulberry32(1));
  assert.equal(w.durationSeconds, 600);
  assert.equal(w.options.workSeconds, 40);
  assert.equal(w.options.restSeconds, 20);
});

test("Advanced position and focus filters reach the generator and are honored", () => {
  const state = advancedState({
    position: { mode: "any", values: ["back"] },
    focus: { mode: "none", values: ["full"] },
  });
  for (const seed of seeds(30)) {
    const w = generateWorkout(library, advancedOptions(state, mulberry32(seed)), mulberry32(seed));
    for (const s of mainSlots(w)) {
      assert.equal(byId[s.exerciseId].position, "back", `${s.exerciseId} (seed ${seed})`);
      assert.ok(!byId[s.exerciseId].focus.includes("full"), `${s.exerciseId} (seed ${seed})`);
    }
  }
});

test("Advanced warm-up outside the total adds the warm-up time on top of the total", () => {
  const state = advancedState({ warmup: { enabled: true, countsInTotal: false } });
  for (const seed of seeds(40)) {
    const rng = mulberry32(seed);
    const w = generateWorkout(library, advancedOptions(state, rng), rng);
    const warm = warmupSlots(w);
    assert.ok(warm.length > 0, `seed ${seed}`);
    const warmCost = warm.reduce((sum, s) => sum + s.workSeconds + s.restAfter, 0);
    assert.equal(w.durationSeconds, 600 + warmCost, `seed ${seed}`);
    // The main section itself still takes exactly the requested total.
    const firstMain = mainSlots(w)[0];
    assert.equal(w.durationSeconds - firstMain.startSec, 600, `seed ${seed}`);
  }
});

test("Advanced warm-up inside the total keeps the whole workout at the requested total", () => {
  const state = advancedState({ warmup: { enabled: true, countsInTotal: true } });
  for (const seed of seeds(40)) {
    const rng = mulberry32(seed);
    const w = generateWorkout(library, advancedOptions(state, rng), rng);
    assert.equal(w.durationSeconds, 600, `seed ${seed}`);
  }
});

test("settings that round-trip through sanitize generate the same workout as the originals", () => {
  const s = validSettings();
  const direct = generateWorkout(library, buildOptions(s, mulberry32(4)), mulberry32(5));
  const viaStorage = generateWorkout(
    library,
    buildOptions(sanitize(JSON.parse(JSON.stringify(s))), mulberry32(4)),
    mulberry32(5)
  );
  assert.deepEqual(viaStorage, direct);
});

test("sanitized garbage still produces options the generator accepts", () => {
  const garbage = [
    null,
    "x",
    [],
    {},
    { mode: "advanced", advanced: { totalSeconds: -1, workSeconds: 1e9, restSeconds: NaN, circuit: true } },
    { mode: "quick", quick: { totalSeconds: "10", difficulty: "brutal", warmup: "yes" } },
  ];
  for (const g of garbage) {
    const settings = sanitize(g);
    const opts = buildOptions(settings, mulberry32(1));
    const w = generateWorkout(library, opts, mulberry32(1));
    assert.ok(w.slots.length > 0);
  }
});
