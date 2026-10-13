import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rerollSlot } from "../src/reroll.js";
import { generateWorkout } from "../src/generator.js";

// Logic-layer tests for rerollSlot (issue #8). The contract is the scope
// comment on #8: rerollSlot(library, workout, slotIndex, rng = Math.random)
// returns { workout, changed, reason }, where `workout` has the same shape as
// generateWorkout's output.

const library = JSON.parse(
  readFileSync(new URL("../exercises.json", import.meta.url), "utf8")
);
const byId = Object.fromEntries(library.map((e) => [e.id, e]));
const libOf = (lib) => Object.fromEntries(lib.map((e) => [e.id, e]));

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

// A minimal valid exercise; "full" focus overlaps with nothing, so custom
// libraries built from it are never constrained by the focus rule.
const mk = (id, over = {}) => ({
  id,
  name: `Move ${id}`,
  focus: ["full"],
  position: "other",
  pattern: "static",
  difficulty: 1,
  perSide: false,
  formCue: "cue",
  ...over,
});
const PATTERNS = ["static", "dynamic", "rotational"];

// ---------------------------------------------------------------------------
// Helpers that describe a workout independently of the implementation
// ---------------------------------------------------------------------------

function focusOverlap(a, b) {
  if (a.includes("full") || b.includes("full")) return false;
  return a.some((f) => b.includes(f));
}

// Counts focus overlaps and pattern three-in-a-rows in a sequence of ids.
function violationCount(ids, L) {
  let v = 0;
  for (let i = 1; i < ids.length; i++) {
    if (focusOverlap(L[ids[i - 1]].focus, L[ids[i]].focus)) v++;
    if (
      i >= 2 &&
      L[ids[i]].pattern === L[ids[i - 1]].pattern &&
      L[ids[i]].pattern === L[ids[i - 2]].pattern
    ) {
      v++;
    }
  }
  return v;
}

function matchesFilter(values, filter) {
  if (!filter || !filter.values || filter.values.length === 0) return true;
  const hit = values.some((v) => filter.values.includes(v));
  return filter.mode === "none" ? !hit : hit;
}

// Library moves a workout's main section may draw from.
function mainPool(w, lib) {
  return lib.filter(
    (e) =>
      e.warmup !== "only" &&
      e.difficulty <= w.options.maxDifficulty &&
      matchesFilter([e.position], w.options.position) &&
      matchesFilter(e.focus, w.options.focus)
  );
}

const isWarmCandidate = (e) => e.warmup === "eligible" || e.warmup === "only";
const usedIds = (w) => new Set(w.slots.map((s) => s.exerciseId));
const baseWork = (w, lib, id) => libOf(lib)[id].workSeconds ?? w.options.workSeconds;
const moveCost = (w, lib, id) =>
  baseWork(w, lib, id) * (libOf(lib)[id].perSide ? 2 : 1) + w.options.restSeconds;

// The final slot's length beyond the base work length of its exercise.
function leftover(w, lib) {
  const last = w.slots[w.slots.length - 1];
  return last.workSeconds - baseWork(w, lib, last.exerciseId);
}

// One entry per block: the distinct moves of round 1 in order (the second side
// of a two-sided move and later circuit rounds are not repeated).
function groups(w) {
  return w.blocks.map((b) => {
    const inBlock = w.slots.slice(b.firstSlot, b.lastSlot + 1);
    return {
      id: b.id,
      kind: b.kind,
      rounds: b.rounds,
      section: inBlock[0].section,
      ids: inBlock.filter((s) => s.round === 1 && s.side !== "right").map((s) => s.exerciseId),
    };
  });
}

// The block and position (among the block's round-1 moves) that a slot is part of.
function locate(w, idx) {
  const s = w.slots[idx];
  const block = w.blocks.find((b) => b.id === s.blockId);
  const roundSlots = w.slots.slice(block.firstSlot, block.lastSlot + 1).filter((x) => x.round === s.round);
  let pos = -1;
  for (const x of roundSlots) {
    if (x.side !== "right") pos++;
    if (x.index === idx) break;
  }
  return { block, pos, oldId: s.exerciseId, section: s.section };
}

// The main sequence: straight moves and circuit round 1, in order.
function mainSequence(w) {
  return groups(w)
    .filter((g) => g.section === "main")
    .flatMap((g) => g.ids);
}

function mainSlotKeys(w) {
  return w.slots
    .filter((s) => s.section === "main")
    .map((s) => `${s.blockId}/${s.round}/${s.exerciseId}/${s.side}/${s.workSeconds}/${s.restAfter}`);
}

function warmCost(w, lib) {
  const g = groups(w).find((x) => x.kind === "warmup");
  return g ? g.ids.reduce((sum, id) => sum + moveCost(w, lib, id), 0) : 0;
}

// Slot-level well-formedness: names, sides, circuit rounds, blocks, timeline.
function assertSane(w, lib) {
  const L = libOf(lib);
  const { slots, blocks, options } = w;
  assert.ok(slots.length > 0);

  slots.forEach((s, i) => {
    assert.equal(s.index, i, `slot ${i} index`);
    const ex = L[s.exerciseId];
    assert.ok(ex, `unknown exercise ${s.exerciseId}`);
    assert.equal(s.name, ex.name);
    assert.equal(s.endSec, s.startSec + s.workSeconds, `slot ${i} endSec`);
    const base = ex.workSeconds ?? options.workSeconds;
    if (i === slots.length - 1) {
      assert.ok(s.workSeconds >= base, `final slot shorter than base work (${s.workSeconds} < ${base})`);
      assert.equal(s.restAfter, 0, "final slot has no rest");
    } else {
      assert.equal(s.workSeconds, base, `non-final slot ${i} keeps base work length`);
      assert.equal(s.restAfter, s.side === "left" ? 0 : options.restSeconds, `slot ${i} rest`);
      assert.equal(slots[i + 1].startSec, s.endSec + s.restAfter, `slot ${i + 1} start`);
    }
    if (ex.perSide) {
      assert.ok(s.side === "left" || s.side === "right", `${s.exerciseId} needs a side`);
      if (s.side === "left") {
        const next = slots[i + 1];
        assert.ok(next && next.side === "right" && next.exerciseId === s.exerciseId, "left must be followed by right");
        assert.equal(next.blockId, s.blockId);
        assert.equal(next.round, s.round);
      } else {
        const prev = slots[i - 1];
        assert.ok(prev && prev.side === "left" && prev.exerciseId === s.exerciseId, "right must follow left");
      }
    } else {
      assert.equal(s.side, null, `${s.exerciseId} has no sides`);
    }
  });
  assert.equal(slots[0].startSec, 0);
  assert.equal(w.durationSeconds, slots[slots.length - 1].endSec);

  assert.equal(blocks[0].firstSlot, 0);
  for (let i = 1; i < blocks.length; i++) {
    assert.equal(blocks[i].firstSlot, blocks[i - 1].lastSlot + 1, "gap or overlap between blocks");
  }
  assert.equal(blocks[blocks.length - 1].lastSlot, slots.length - 1);
  assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length);
  for (const b of blocks) {
    const inBlock = slots.slice(b.firstSlot, b.lastSlot + 1);
    assert.ok(inBlock.every((s) => s.blockId === b.id), `slots in block ${b.id} carry its id`);
    assert.ok(inBlock.every((s) => s.section === (b.kind === "warmup" ? "warmup" : "main")));
    const key = (s) => `${s.exerciseId}/${s.side}`;
    const round1 = inBlock.filter((s) => s.round === 1).map(key);
    for (let r = 1; r <= b.rounds; r++) {
      assert.deepEqual(inBlock.filter((s) => s.round === r).map(key), round1, `block ${b.id} round ${r}`);
    }
    assert.ok(inBlock.every((s) => s.round >= 1 && s.round <= b.rounds));
  }
}

// Checks that exactly one move (the one slot `idx` belongs to) was replaced
// and returns the new id. Block ids, kinds, rounds and sizes must be unchanged.
function assertOnlyMoveReplaced(before, after, idx) {
  const { block, pos, oldId } = locate(before, idx);
  const gb = groups(before);
  const ga = groups(after);
  assert.equal(ga.length, gb.length, "block count");
  let newId;
  gb.forEach((g, i) => {
    const h = ga[i];
    assert.equal(h.id, g.id, "block id");
    assert.equal(h.kind, g.kind, "block kind");
    assert.equal(h.rounds, g.rounds, "block rounds");
    assert.equal(h.section, g.section, "block section");
    assert.equal(h.ids.length, g.ids.length, `block ${g.id} size`);
    h.ids.forEach((id, j) => {
      if (g.id === block.id && j === pos) {
        assert.notEqual(id, oldId, "the move must actually change");
        newId = id;
      } else {
        assert.equal(id, g.ids[j], `block ${g.id} move ${j} must be untouched`);
      }
    });
  });
  return newId;
}

// ---------------------------------------------------------------------------
// A pool of generated workouts and re-rolls of every slot in them
// ---------------------------------------------------------------------------

const BASE = { totalSeconds: 600, workSeconds: 40, restSeconds: 20, circuit: null };
const SHORT = { totalSeconds: 300, workSeconds: 40, restSeconds: 20, circuit: null };
const CIRCUIT = { totalSeconds: 720, workSeconds: 40, restSeconds: 20, circuit: { size: 3, rounds: 2 } };

const CONFIGS = [
  ["plain", BASE],
  ["uneven", { ...BASE, workSeconds: 45, restSeconds: 25 }],
  ["circuit", CIRCUIT],
  ["warm", { ...BASE, warmup: { enabled: true } }],
  ["warm-outside", { ...BASE, warmup: { enabled: true, countsInTotal: false } }],
  ["warm-circuit", { ...CIRCUIT, warmup: { enabled: true } }],
  ["difficulty-1", { ...SHORT, maxDifficulty: 1 }],
  ["back-only", { ...SHORT, position: { mode: "any", values: ["back"] } }],
  ["no-obliques", { ...SHORT, focus: { mode: "none", values: ["obliques"] } }],
  ["random", {}],
];

let cache = null;
function cases() {
  if (!cache) {
    cache = [];
    for (const [name, opts] of CONFIGS) {
      for (const seed of seeds(6)) {
        cache.push({ name, opts, seed, w: generateWorkout(library, opts, mulberry32(seed)) });
      }
    }
  }
  return cache;
}

let rerollCache = null;
function rerolls() {
  if (!rerollCache) {
    rerollCache = [];
    for (const c of cases()) {
      for (let idx = 0; idx < c.w.slots.length; idx++) {
        for (const seed of [1, 2]) {
          const res = rerollSlot(library, c.w, idx, mulberry32(seed));
          rerollCache.push({ c, idx, seed, res, section: c.w.slots[idx].section });
        }
      }
    }
  }
  return rerollCache;
}

const changedRerolls = () => rerolls().filter((r) => r.res.changed);
// Rerolls whose input needed no rule relaxation, so every rule can be asserted.
const cleanRerolls = () => rerolls().filter((r) => r.c.w.warnings.length === 0);

// ---------------------------------------------------------------------------
// Return shape, purity, determinism
// ---------------------------------------------------------------------------

test("returns { workout, changed, reason } and a changed workout has the generator's shape", () => {
  const gen = generateWorkout(library, BASE, mulberry32(1));
  let checked = 0;
  for (const { c, res } of rerolls()) {
    assert.equal(typeof res.changed, "boolean");
    if (!res.changed) continue;
    checked++;
    assert.ok(res.reason === undefined || res.reason === null, `reason was ${res.reason}`);
    assert.notEqual(res.workout, c.w, "a changed workout must be a new object");
    assert.deepEqual(Object.keys(res.workout).sort(), Object.keys(gen).sort());
    assert.deepEqual(Object.keys(res.workout.slots[0]).sort(), Object.keys(gen.slots[0]).sort());
    assert.deepEqual(Object.keys(res.workout.blocks[0]).sort(), Object.keys(gen.blocks[0]).sort());
    assert.ok(Array.isArray(res.workout.warnings) && Array.isArray(res.workout.randomized));
  }
  assert.ok(checked > 100, `only ${checked} re-rolls changed anything`);
});

test("when nothing changes the result is changed: false, reason no-alternative and the very same workout object", () => {
  // Whether any re-roll in this pool is a no-op depends on how big exercises.json
  // is, so only the shape of unchanged results is asserted here. The no-alternative
  // cases themselves are built from tiny synthetic libraries further down.
  for (const { c, res } of rerolls()) {
    if (res.changed) continue;
    assert.equal(res.reason, "no-alternative");
    assert.equal(res.workout, c.w);
  }
});

test("does not mutate a deep-frozen library or workout (frozen inputs do not throw)", () => {
  for (const opts of [BASE, { ...CIRCUIT, warmup: { enabled: true, countsInTotal: false } }]) {
    const lib = deepFreeze(structuredClone(library));
    const w = deepFreeze(generateWorkout(library, opts, mulberry32(3)));
    const wBefore = structuredClone(w);
    for (let idx = 0; idx < w.slots.length; idx++) {
      for (const seed of [1, 2, 3]) {
        assert.doesNotThrow(() => rerollSlot(lib, w, idx, mulberry32(seed)));
      }
    }
    assert.deepEqual(lib, library);
    assert.deepEqual(w, wBefore);
  }
});

test("a no-alternative re-roll on a frozen workout returns that same frozen object", () => {
  const lib = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const w = deepFreeze(generateWorkout(lib, { ...SHORT, totalSeconds: 160 }, mulberry32(1)));
  const res = rerollSlot(deepFreeze(structuredClone(lib)), w, 0, mulberry32(1));
  assert.equal(res.changed, false);
  assert.equal(res.workout, w);
});

test("same seed and same inputs produce deep-equal output for every slot", () => {
  for (const c of cases().filter((x) => x.seed <= 3)) {
    for (let idx = 0; idx < c.w.slots.length; idx++) {
      const a = rerollSlot(library, c.w, idx, mulberry32(7));
      const b = rerollSlot(library, c.w, idx, mulberry32(7));
      assert.deepEqual(a, b);
    }
  }
});

test("different seeds can pick different replacements for the same slot", () => {
  const w = generateWorkout(library, BASE, mulberry32(1));
  const picks = new Set(
    seeds(40).map((seed) => rerollSlot(library, w, 0, mulberry32(seed)).workout.slots[0].exerciseId)
  );
  assert.ok(picks.size > 1, "re-roll should be random across seeds");
});

test("works without an rng argument (defaults to Math.random)", () => {
  const w = generateWorkout(library, BASE, mulberry32(1));
  const res = rerollSlot(library, w, 0);
  assert.equal(typeof res.changed, "boolean");
});

// ---------------------------------------------------------------------------
// slotIndex validation
// ---------------------------------------------------------------------------

test("a negative, too large, fractional, NaN or infinite slotIndex throws RangeError", () => {
  const w = generateWorkout(library, BASE, mulberry32(1));
  for (const bad of [-1, w.slots.length, w.slots.length + 5, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => rerollSlot(library, w, bad, mulberry32(1)), RangeError, `index ${bad}`);
  }
});

test("the first and last slot indices are valid", () => {
  const w = generateWorkout(library, BASE, mulberry32(1));
  assert.doesNotThrow(() => rerollSlot(library, w, 0, mulberry32(1)));
  assert.doesNotThrow(() => rerollSlot(library, w, w.slots.length - 1, mulberry32(1)));
});

// ---------------------------------------------------------------------------
// Which slots a re-roll replaces
// ---------------------------------------------------------------------------

test("a re-roll replaces exactly one move and leaves every block's id, kind, rounds and size alone", () => {
  for (const { c, idx, res } of changedRerolls()) {
    assertOnlyMoveReplaced(c.w, res.workout, idx);
  }
});

test("the old move no longer appears anywhere after a re-roll", () => {
  for (const { c, idx, res } of cleanRerolls().filter((r) => r.res.changed)) {
    const oldId = c.w.slots[idx].exerciseId;
    assert.ok(!usedIds(res.workout).has(oldId), `${oldId} still present`);
  }
});

test("re-rolling either side of a two-sided move replaces both sides with the same new move, left then right", () => {
  // Eight two-sided, equal-cost moves with no focus overlap: every swap is possible.
  const lib = seeds(8).map((i) => mk(`p${i}`, { perSide: true, pattern: PATTERNS[i % 3] }));
  for (const seed of seeds(4)) {
    const w = generateWorkout(lib, BASE, mulberry32(seed));
    assert.equal(w.slots.length, 12, "premise: six two-sided moves");
    for (let idx = 0; idx < w.slots.length; idx++) {
      const res = rerollSlot(lib, w, idx, mulberry32(seed + 10));
      assert.equal(res.changed, true, `slot ${idx}`);
      const newId = assertOnlyMoveReplaced(w, res.workout, idx);
      const pairStart = idx - (idx % 2);
      const [left, right] = res.workout.slots.slice(pairStart, pairStart + 2);
      assert.equal(left.exerciseId, newId);
      assert.equal(right.exerciseId, newId);
      assert.equal(left.side, "left");
      assert.equal(right.side, "right");
      assert.equal(res.workout.slots.length, 12);
      assertSane(res.workout, lib);
    }
  }
});

test("re-rolling a two-sided move in the real library never leaves a half pair", () => {
  let pairs = 0;
  for (const { c, idx, res } of changedRerolls()) {
    if (!c.w.slots[idx].side) continue;
    pairs++;
    assertSane(res.workout, library); // left/right pairing is checked inside
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    const rounds = locate(c.w, idx).block.rounds;
    assert.equal(
      res.workout.slots.filter((s) => s.exerciseId === newId).length,
      (byId[newId].perSide ? 2 : 1) * rounds
    );
  }
  assert.ok(pairs > 10, `only ${pairs} two-sided re-rolls seen`);
});

test("a circuit move is replaced in every round with the same new move at the same position", () => {
  // Plenty of equal-cost spare moves, so a circuit swap is always possible.
  const lib = seeds(9).map((i) => mk(`m${i}`, { pattern: PATTERNS[i % 3] }));
  for (const seed of seeds(5)) {
    const w = generateWorkout(lib, { ...BASE, circuit: { size: 3, rounds: 2 } }, mulberry32(seed));
    const circuit = w.blocks.find((b) => b.kind === "circuit");
    assert.ok(circuit && circuit.rounds === 2, "premise: a 3 x 2 circuit");
    for (let idx = circuit.firstSlot; idx <= circuit.lastSlot; idx++) {
      const res = rerollSlot(lib, w, idx, mulberry32(seed + 20));
      assert.equal(res.changed, true, `slot ${idx}`);
      const newId = assertOnlyMoveReplaced(w, res.workout, idx);
      const after = res.workout.blocks.find((b) => b.kind === "circuit");
      assert.equal(after.rounds, 2);
      assert.equal(after.lastSlot - after.firstSlot, circuit.lastSlot - circuit.firstSlot, "circuit size");
      const inCircuit = res.workout.slots.slice(after.firstSlot, after.lastSlot + 1);
      for (const round of [1, 2]) {
        const ids = inCircuit.filter((s) => s.round === round).map((s) => s.exerciseId);
        const oldRound = w.slots
          .slice(circuit.firstSlot, circuit.lastSlot + 1)
          .filter((s) => s.round === round)
          .map((s) => s.exerciseId);
        assert.deepEqual(
          ids,
          oldRound.map((id) => (id === w.slots[idx].exerciseId ? newId : id)),
          `round ${round}`
        );
      }
      assertSane(res.workout, lib);
    }
  }
});

test("circuit moves in the real library are replaced in every round too", () => {
  let seen = 0;
  for (const { c, idx, res } of changedRerolls()) {
    const { block } = locate(c.w, idx);
    if (block.kind !== "circuit") continue;
    seen++;
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    const after = res.workout.blocks.find((b) => b.kind === "circuit");
    const slots = res.workout.slots.slice(after.firstSlot, after.lastSlot + 1);
    for (let r = 1; r <= after.rounds; r++) {
      const count = slots.filter((s) => s.round === r && s.exerciseId === newId).length;
      assert.equal(count, byId[newId].perSide ? 2 : 1, `round ${r} should have the new move`);
    }
  }
  assert.ok(seen > 10, `only ${seen} circuit re-rolls seen`);
});

test("re-rolling one occurrence of a repeated move in a straight block replaces only that occurrence", () => {
  // Three moves cannot fill ten minutes without repeating. A fourth, unused move
  // is the only candidate, so the re-roll must pick it.
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const extra = mk("d", { pattern: "dynamic" });
  for (const seed of seeds(5)) {
    const w = generateWorkout(lib0, BASE, mulberry32(seed));
    const ids = groups(w)[0].ids;
    const dup = ids.find((id) => ids.indexOf(id) !== ids.lastIndexOf(id));
    assert.ok(dup, "premise: some move repeats");
    const pos = ids.indexOf(dup);
    const idx = w.slots.findIndex((s) => s.exerciseId === dup);
    const res = rerollSlot([...lib0, extra], w, idx, mulberry32(seed));
    assert.equal(res.changed, true);
    const afterIds = groups(res.workout)[0].ids;
    assert.equal(afterIds[pos], "d");
    assert.equal(afterIds.filter((id) => id === dup).length, ids.filter((id) => id === dup).length - 1);
    ids.forEach((id, j) => {
      if (j !== pos) assert.equal(afterIds[j], id, `position ${j}`);
    });
    for (const w0 of w.warnings) assert.ok(res.workout.warnings.includes(w0), "existing warnings are kept");
  }
});

// ---------------------------------------------------------------------------
// Replacement pool
// ---------------------------------------------------------------------------

test("no exercise appears twice outside circuit rounds after a re-roll of a rule-abiding workout", () => {
  let checked = 0;
  for (const { c, res } of cleanRerolls()) {
    if (!res.changed) continue;
    checked++;
    const all = groups(res.workout).flatMap((g) => g.ids);
    assert.equal(new Set(all).size, all.length, `repeated exercise in ${all} (config ${c.name})`);
  }
  assert.ok(checked > 100, `only ${checked} clean re-rolls changed`);
});

test("main replacements are never warm-up-only moves and respect maxDifficulty and the position and focus filters", () => {
  const only = new Set(library.filter((e) => e.warmup === "only").map((e) => e.id));
  let checked = 0;
  for (const { c, res, idx, section } of changedRerolls()) {
    if (section !== "main") continue;
    checked++;
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    assert.ok(!only.has(newId), `${newId} is warm-up-only`);
    assert.ok(mainPool(c.w, library).some((e) => e.id === newId), `${newId} not in the main pool of ${c.name}`);
    assert.ok(byId[newId].difficulty <= c.w.options.maxDifficulty);
  }
  assert.ok(checked > 100);
});

test("the filtered configs actually exercise the filters (re-rolls happen and stay inside the filter)", () => {
  for (const name of ["difficulty-1", "back-only", "no-obliques"]) {
    const rs = changedRerolls().filter((r) => r.c.name === name);
    assert.ok(rs.length > 10, `${name}: only ${rs.length} changed re-rolls`);
    for (const { c, res, idx } of rs) {
      const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
      if (name === "difficulty-1") assert.equal(byId[newId].difficulty, 1);
      if (name === "back-only") assert.equal(byId[newId].position, "back");
      if (name === "no-obliques") assert.ok(!byId[newId].focus.includes("obliques"));
    }
  }
});

test("a warm-up-only move in the library is never used as a main replacement", () => {
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  const res = rerollSlot([...lib0, mk("w", { warmup: "only" })], w, 0, mulberry32(1));
  assert.equal(res.changed, false);
  assert.equal(res.reason, "no-alternative");
  assert.equal(res.workout, w);
});

test("a candidate above maxDifficulty or outside the position and focus filters is not eligible", () => {
  const lib0 = [
    mk("a", { position: "back", focus: ["lower-abs"] }),
    mk("b", { position: "back", focus: ["upper-abs"], pattern: "dynamic" }),
    mk("c", { position: "back", focus: ["obliques"], pattern: "rotational" }),
  ];
  const opts = {
    ...SHORT,
    totalSeconds: 160,
    maxDifficulty: 2,
    position: { mode: "any", values: ["back"] },
    focus: { mode: "none", values: ["deep-core"] },
  };
  const w = generateWorkout(lib0, opts, mulberry32(1));
  const spares = [
    mk("hard", { position: "back", focus: ["upper-abs"], difficulty: 3 }),
    mk("wrong-position", { position: "face-down", focus: ["upper-abs"] }),
    mk("wrong-focus", { position: "back", focus: ["deep-core"] }),
  ];
  const res = rerollSlot([...lib0, ...spares], w, 1, mulberry32(1));
  assert.equal(res.changed, false);
  assert.equal(res.reason, "no-alternative");
  assert.equal(res.workout, w);
  // An eligible spare is then picked.
  const ok = mk("ok", { position: "back", focus: ["upper-abs"], difficulty: 2, pattern: "static" });
  const res2 = rerollSlot([...lib0, ...spares, ok], w, 1, mulberry32(1));
  assert.equal(res2.changed, true);
  assert.equal(res2.workout.slots[1].exerciseId, "ok");
});

test("empty filter values mean no filtering when choosing a replacement", () => {
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const opts = {
    ...SHORT,
    totalSeconds: 160,
    position: { mode: "any", values: [] },
    focus: { mode: "none", values: [] },
  };
  const w = generateWorkout(lib0, opts, mulberry32(1));
  const res = rerollSlot([...lib0, mk("d", { position: "face-down", focus: ["deep-core"] })], w, 0, mulberry32(1));
  assert.equal(res.changed, true);
  assert.equal(res.workout.slots[0].exerciseId, "d");
});

test("a re-roll happens exactly when some unused main-pool move fits the time rules", () => {
  let checked = 0;
  for (const { c, idx, res, section } of cleanRerolls()) {
    if (section !== "main") continue;
    checked++;
    const { block, oldId } = locate(c.w, idx);
    const lo = leftover(c.w, library);
    const used = usedIds(c.w);
    const fits = mainPool(c.w, library).filter((e) => {
      if (used.has(e.id)) return false;
      const delta = block.rounds * (moveCost(c.w, library, oldId) - moveCost(c.w, library, e.id));
      return lo + delta >= 0 && Math.abs(delta) <= c.w.options.workSeconds;
    });
    assert.equal(res.changed, fits.length > 0, `${c.name} seed ${c.seed} slot ${idx}`);
    if (res.changed) {
      const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
      assert.ok(fits.some((e) => e.id === newId), `${newId} does not fit the rules`);
    }
  }
  assert.ok(checked > 100);
});

// ---------------------------------------------------------------------------
// Warm-up slots
// ---------------------------------------------------------------------------

const warmRerolls = () => rerolls().filter((r) => r.section === "warmup" && r.c.w.warnings.length === 0);

test("a warm-up re-roll picks an unused warm-up eligible/only move at difficulty 1", () => {
  let changed = 0;
  for (const { c, idx, res } of warmRerolls()) {
    if (!res.changed) continue;
    changed++;
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    const e = byId[newId];
    assert.ok(isWarmCandidate(e), `${newId} is not warm-up eligible`);
    assert.equal(e.difficulty, 1, `${newId} is not difficulty 1`);
    assert.ok(!usedIds(c.w).has(newId), `${newId} was already in the workout`);
    assert.equal(groups(res.workout)[0].kind, "warmup");
  }
  assert.ok(changed > 20, `only ${changed} warm-up re-rolls changed`);
});

test("a warm-up re-roll ignores the position and focus filters", () => {
  const opts = {
    ...BASE,
    warmup: { enabled: true },
    position: { mode: "any", values: ["face-down"] },
    focus: { mode: "none", values: ["lower-abs"] },
  };
  let changed = 0;
  for (const seed of seeds(8)) {
    const w = generateWorkout(library, opts, mulberry32(seed));
    for (const idx of w.slots.filter((s) => s.section === "warmup").map((s) => s.index)) {
      const res = rerollSlot(library, w, idx, mulberry32(seed));
      if (!res.changed) continue;
      changed++;
      const newId = assertOnlyMoveReplaced(w, res.workout, idx);
      // No face-down or filter-matching move is warm-up eligible, so this only
      // works if the filters are ignored.
      assert.ok(isWarmCandidate(byId[newId]));
    }
  }
  assert.ok(changed > 0);
});

test("a warm-up re-roll prefers a replacement whose focus does not overlap the other warm-up move", () => {
  let constrained = 0;
  for (const { c, idx, res } of warmRerolls()) {
    const oldId = c.w.slots[idx].exerciseId;
    const old = byId[oldId];
    const warm = groups(c.w)[0].ids;
    assert.equal(groups(c.w)[0].kind, "warmup");
    const other = byId[warm.find((id) => id !== oldId)];
    const used = usedIds(c.w);
    // Same-cost candidates always fit the time rules, so they must be available.
    const sameCost = library.filter(
      (e) =>
        isWarmCandidate(e) &&
        e.difficulty === 1 &&
        !used.has(e.id) &&
        Boolean(e.perSide) === Boolean(old.perSide) &&
        e.workSeconds === old.workSeconds
    );
    const friendly = sameCost.filter((e) => !focusOverlap(e.focus, other.focus));
    if (friendly.length === 0) continue;
    constrained++;
    assert.equal(res.changed, true);
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    assert.ok(!focusOverlap(byId[newId].focus, other.focus), `${newId} overlaps ${other.id}`);
  }
  assert.ok(constrained > 10, `only ${constrained} cases where the preference applied`);
});

test("a warm-up re-roll picks a non-overlapping replacement over an overlapping one when both are available", () => {
  const lib0 = [
    mk("w1", { warmup: "eligible", focus: ["deep-core"] }),
    mk("w2", { warmup: "eligible", focus: ["lower-abs"], pattern: "dynamic" }),
    ...seeds(5).map((i) => mk(`m${i}`, { pattern: PATTERNS[i % 3] })),
  ];
  const w = generateWorkout(lib0, { ...SHORT, warmup: { enabled: true } }, mulberry32(1));
  const slotOf = (id) => w.slots.findIndex((s) => s.exerciseId === id);
  // Replacing w1: the other warm-up move is w2 (lower-abs). The candidate that
  // overlaps it loses to the one with full focus, which overlaps with nothing.
  const lib = [
    ...lib0,
    mk("overlaps", { warmup: "eligible", focus: ["lower-abs"], pattern: "rotational" }),
    mk("full-focus", { warmup: "eligible", focus: ["full"], pattern: "static" }),
  ];
  for (const seed of seeds(10)) {
    const res = rerollSlot(lib, w, slotOf("w1"), mulberry32(seed));
    assert.equal(res.changed, true);
    assert.equal(res.workout.slots[slotOf("w1")].exerciseId, "full-focus");
  }
});

test("a warm-up re-roll prefers a difficulty 1 move over a harder warm-up eligible one", () => {
  const lib0 = [
    mk("w1", { warmup: "eligible" }),
    mk("w2", { warmup: "eligible", pattern: "dynamic" }),
    ...seeds(5).map((i) => mk(`m${i}`, { pattern: PATTERNS[i % 3] })),
  ];
  const w = generateWorkout(lib0, { ...SHORT, warmup: { enabled: true } }, mulberry32(1));
  const lib = [
    ...lib0,
    mk("hard", { warmup: "eligible", difficulty: 2, pattern: "rotational" }),
    mk("easy", { warmup: "only", difficulty: 1, pattern: "rotational" }),
  ];
  for (const seed of seeds(10)) {
    const res = rerollSlot(lib, w, 0, mulberry32(seed));
    assert.equal(res.changed, true);
    assert.equal(res.workout.slots[0].exerciseId, "easy");
  }
});

test("a warm-up re-roll never picks a move that is already in the main section, and does nothing when no warm-up move is left", () => {
  const w1 = mk("w1", { warmup: "eligible" });
  const w2 = mk("w2", { warmup: "eligible", pattern: "dynamic" });
  const mains = seeds(5).map((i) => mk(`m${i}`, { pattern: PATTERNS[i % 3] }));
  const lib0 = [w1, w2, ...mains];
  const w = generateWorkout(lib0, { ...SHORT, warmup: { enabled: true } }, mulberry32(1));
  assert.equal(w.slots[0].section, "warmup");
  // A warm-up eligible move that the main section already uses is not available.
  const inMain = w.slots.find((s) => s.section === "main").exerciseId;
  const lib = lib0.map((e) => (e.id === inMain ? { ...e, warmup: "eligible" } : e));
  const res = rerollSlot(lib, w, 0, mulberry32(1));
  assert.equal(res.changed, false);
  assert.equal(res.reason, "no-alternative");
  assert.equal(res.workout, w);
});

test("a warm-up re-roll leaves the main section unchanged, and the duration unchanged when the warm-up counts in the total", () => {
  let checked = 0;
  for (const { c, idx, res } of warmRerolls()) {
    if (!res.changed || c.opts.warmup.countsInTotal === false) continue;
    checked++;
    assert.equal(res.workout.durationSeconds, c.w.durationSeconds);
    assert.deepEqual(groups(res.workout).filter((g) => g.section === "main"), groups(c.w).filter((g) => g.section === "main"));
    assertSane(res.workout, library);
  }
  assert.ok(checked > 10, `only ${checked} counted warm-up re-rolls changed`);
});

test("with the warm-up outside the total, the duration changes by exactly the warm-up cost change and the main section is untouched", () => {
  let checked = 0;
  for (const { c, idx, res } of warmRerolls()) {
    if (!res.changed || c.opts.warmup.countsInTotal !== false) continue;
    checked++;
    const delta = warmCost(res.workout, library) - warmCost(c.w, library);
    assert.equal(res.workout.durationSeconds - c.w.durationSeconds, delta);
    assert.deepEqual(mainSlotKeys(res.workout), mainSlotKeys(c.w));
    assertSane(res.workout, library);
  }
  assert.ok(checked > 5, `only ${checked} uncounted warm-up re-rolls changed`);
});

test("swapping a normal warm-up move for a two-sided one outside the total adds exactly one work interval, and the reverse removes it", () => {
  const warmOut = { ...SHORT, warmup: { enabled: true, countsInTotal: false } };
  const mains = seeds(5).map((i) => mk(`m${i}`, { pattern: PATTERNS[i % 3] }));

  // normal -> two-sided
  const lib0 = [mk("w1", { warmup: "eligible" }), mk("w2", { warmup: "eligible", pattern: "dynamic" }), ...mains];
  const w = generateWorkout(lib0, warmOut, mulberry32(1));
  const lib = [...lib0, mk("wp", { warmup: "eligible", perSide: true, pattern: "rotational" })];
  for (const idx of [0, 1]) {
    const res = rerollSlot(lib, w, idx, mulberry32(2));
    assert.equal(res.changed, true);
    assert.equal(res.workout.durationSeconds, w.durationSeconds + 40);
    assert.equal(res.workout.slots.length, w.slots.length + 1);
    assert.deepEqual(mainSlotKeys(res.workout), mainSlotKeys(w));
    assertSane(res.workout, lib);
  }

  // two-sided -> normal
  const libP0 = [mk("w1", { warmup: "eligible", perSide: true }), mk("w2", { warmup: "eligible", pattern: "dynamic" }), ...mains];
  const wp = generateWorkout(libP0, warmOut, mulberry32(1));
  const libP = [...libP0, mk("wn", { warmup: "eligible", pattern: "rotational" })];
  const idx = wp.slots.findIndex((s) => s.exerciseId === "w1");
  const res = rerollSlot(libP, wp, idx, mulberry32(2));
  assert.equal(res.changed, true);
  assert.equal(res.workout.durationSeconds, wp.durationSeconds - 40);
  assert.equal(res.workout.slots.length, wp.slots.length - 1);
  assert.deepEqual(mainSlotKeys(res.workout), mainSlotKeys(wp));
  assertSane(res.workout, libP);
});

// ---------------------------------------------------------------------------
// Duration, timeline and blocks
// ---------------------------------------------------------------------------

test("a main-section re-roll keeps durationSeconds exactly the same", () => {
  let checked = 0;
  for (const { c, res, section } of cleanRerolls()) {
    if (!res.changed || section !== "main") continue;
    checked++;
    assert.equal(res.workout.durationSeconds, c.w.durationSeconds);
  }
  assert.ok(checked > 100);
});

test("slot indices, start and end times, rests and blocks are consistent after every re-roll", () => {
  for (const { c, res } of changedRerolls()) {
    assertSane(res.workout, library);
  }
});

test("the real-library input workouts satisfy the same invariants (sanity check of the helpers)", () => {
  for (const c of cases()) assertSane(c.w, library);
});

test("slot count changes by one when a normal move is swapped for a two-sided one, with indices, timeline and blocks rebuilt", () => {
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const lib = [...lib0, mk("p", { perSide: true, pattern: "dynamic" })];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 210 }, mulberry32(1));
  assert.equal(w.slots.length, 3);
  for (let idx = 0; idx < 3; idx++) {
    const res = rerollSlot(lib, w, idx, mulberry32(1));
    assert.equal(res.changed, true, `slot ${idx}`);
    assert.equal(res.workout.slots.length, 4);
    assert.equal(res.workout.durationSeconds, 210);
    assert.deepEqual(res.workout.blocks, [{ id: "straight-1", kind: "straight", rounds: 1, firstSlot: 0, lastSlot: 3 }]);
    assert.deepEqual(res.workout.slots.map((s) => s.index), [0, 1, 2, 3]);
    assertSane(res.workout, lib);
  }
});

test("slot count changes by one when a two-sided move is swapped for a normal one, with indices, timeline and blocks rebuilt", () => {
  const lib0 = [mk("p", { perSide: true }), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const lib = [...lib0, mk("d", { pattern: "static" })];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 210 }, mulberry32(1));
  assert.equal(w.slots.length, 4);
  for (const idx of w.slots.filter((s) => s.exerciseId === "p").map((s) => s.index)) {
    const res = rerollSlot(lib, w, idx, mulberry32(1));
    assert.equal(res.changed, true, `slot ${idx}`);
    assert.equal(res.workout.slots.length, 3);
    assert.equal(res.workout.durationSeconds, 210);
    assert.deepEqual(res.workout.blocks, [{ id: "straight-1", kind: "straight", rounds: 1, firstSlot: 0, lastSlot: 2 }]);
    assertSane(res.workout, lib);
  }
});

test("a per-exercise workSeconds override on the replacement is used for its slot", () => {
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const lib = [...lib0, mk("quick", { workSeconds: 25, pattern: "dynamic" })];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  const res = rerollSlot(lib, w, 0, mulberry32(1));
  assert.equal(res.changed, true);
  const [first, second] = res.workout.slots;
  assert.equal(first.exerciseId, "quick");
  assert.equal(first.workSeconds, 25);
  assert.equal(first.endSec, 25);
  assert.equal(second.startSec, 45);
  assert.equal(res.workout.durationSeconds, 160);
  assert.equal(leftover(res.workout, lib), 15);
  assertSane(res.workout, lib);
});

// ---------------------------------------------------------------------------
// Leftover handling in the final slot
// ---------------------------------------------------------------------------

test("all non-final slots keep base work lengths and the final slot is at least its base length after every re-roll", () => {
  for (const { c, res } of changedRerolls()) {
    const w = res.workout;
    w.slots.slice(0, -1).forEach((s) => assert.equal(s.workSeconds, baseWork(w, library, s.exerciseId)));
    const last = w.slots[w.slots.length - 1];
    assert.ok(last.workSeconds >= baseWork(w, library, last.exerciseId), `${c.name} seed ${c.seed}`);
  }
});

test("the final slot's leftover shifts by exactly the cost difference, never goes negative and moves by at most one work interval", () => {
  let checked = 0;
  for (const { c, idx, res } of cleanRerolls()) {
    if (!res.changed) continue;
    const { block, oldId, section } = locate(c.w, idx);
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    const before = leftover(c.w, library);
    const after = leftover(res.workout, library);
    assert.ok(after >= 0, "leftover must not go negative");
    if (section === "warmup" && c.opts.warmup.countsInTotal === false) {
      assert.equal(after, before, "main section is fixed when the warm-up is outside the total");
      continue;
    }
    checked++;
    const delta = block.rounds * (moveCost(c.w, library, oldId) - moveCost(res.workout, library, newId));
    assert.equal(after - before, delta);
    assert.ok(Math.abs(after - before) <= c.w.options.workSeconds, `leftover moved by ${after - before}`);
  }
  assert.ok(checked > 100);
});

test("a normal move is swapped for a two-sided one when the leftover is at least a work interval, and the final slot shrinks by it", () => {
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const lib = [...lib0, mk("p", { perSide: true, pattern: "dynamic" })];
  for (const [total, left] of [[210, 50], [200, 40]]) {
    const w = generateWorkout(lib0, { ...SHORT, totalSeconds: total }, mulberry32(1));
    assert.equal(leftover(w, lib), left, "premise");
    const res = rerollSlot(lib, w, 0, mulberry32(1));
    assert.equal(res.changed, true, `leftover ${left}`);
    assert.equal(leftover(res.workout, lib), left - 40);
    assert.equal(res.workout.durationSeconds, total);
    assert.deepEqual(res.workout.warnings, w.warnings);
  }
});

test("a normal move is not swapped for a two-sided one when the leftover is smaller than a work interval", () => {
  const lib0 = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const lib = [...lib0, mk("p", { perSide: true, pattern: "dynamic" })];
  for (const total of [160, 190, 199]) {
    const w = generateWorkout(lib0, { ...SHORT, totalSeconds: total }, mulberry32(1));
    assert.ok(leftover(w, lib) < 40, "premise");
    for (let idx = 0; idx < w.slots.length; idx++) {
      const res = rerollSlot(lib, w, idx, mulberry32(1));
      assert.equal(res.changed, false, `total ${total} slot ${idx}`);
      assert.equal(res.reason, "no-alternative");
      assert.equal(res.workout, w);
    }
  }
});

test("a two-sided move is swapped for a normal one, growing the final slot by one work interval", () => {
  const lib0 = [mk("p", { perSide: true }), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const lib = [...lib0, mk("d", { pattern: "static" })];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 210 }, mulberry32(1));
  assert.equal(leftover(w, lib), 10, "premise");
  const res = rerollSlot(lib, w, w.slots.findIndex((s) => s.exerciseId === "p"), mulberry32(1));
  assert.equal(res.changed, true);
  assert.equal(leftover(res.workout, lib), 50);
  assert.equal(res.workout.durationSeconds, 210);
});

test("a swap that would grow the leftover by more than one work interval is not allowed, but exactly one interval is", () => {
  // A two-sided move costs 100. A replacement with a work override of W costs
  // W + 20, so the leftover grows by 80 - W: 51 (W 29) and 41 (W 39) are too
  // much, 40 (W 40) is exactly one work interval and allowed.
  const lib0 = [mk("p", { perSide: true }), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 210 }, mulberry32(1));
  const idx = w.slots.findIndex((s) => s.exerciseId === "p");
  for (const override of [10, 29, 39]) {
    const res = rerollSlot([...lib0, mk("spare", { workSeconds: override, pattern: "static" })], w, idx, mulberry32(1));
    assert.equal(res.changed, false, `override ${override}`);
    assert.equal(res.reason, "no-alternative");
    assert.equal(res.workout, w);
  }
  const ok = rerollSlot([...lib0, mk("spare", { workSeconds: 40, pattern: "static" })], w, idx, mulberry32(1));
  assert.equal(ok.changed, true);
  assert.equal(leftover(ok.workout, [...lib0, mk("spare", { workSeconds: 40, pattern: "static" })]), 50);
});

test("a normal move is only swapped for a two-sided one when the warm-up swap leaves enough leftover, with the warm-up inside the total", () => {
  const mains = seeds(5).map((i) => mk(`m${i}`, { pattern: PATTERNS[i % 3] }));
  const lib0 = [mk("w1", { warmup: "eligible" }), mk("w2", { warmup: "eligible", pattern: "dynamic" }), ...mains];
  const lib = [...lib0, mk("wp", { warmup: "eligible", perSide: true, pattern: "rotational" })];
  // warm-up 120s + four 60s moves minus the last rest = 340; leftover = total - 340.
  const enough = generateWorkout(lib0, { ...BASE, totalSeconds: 390, warmup: { enabled: true } }, mulberry32(1));
  assert.equal(leftover(enough, lib), 50, "premise");
  const res = rerollSlot(lib, enough, 0, mulberry32(1));
  assert.equal(res.changed, true);
  assert.equal(res.workout.durationSeconds, 390);
  assert.equal(leftover(res.workout, lib), 10);

  const short = generateWorkout(lib0, { ...BASE, totalSeconds: 375, warmup: { enabled: true } }, mulberry32(1));
  assert.ok(leftover(short, lib) < 40, "premise");
  const no = rerollSlot(lib, short, 0, mulberry32(1));
  assert.equal(no.changed, false);
  assert.equal(no.workout, short);
});

// ---------------------------------------------------------------------------
// Neighbor rules
// ---------------------------------------------------------------------------

test("whenever a replacement that satisfies the focus and pattern rules fits, it is chosen and the main sequence stays rule-abiding", () => {
  let preferred = 0;
  for (const { c, idx, res, section } of cleanRerolls()) {
    if (section !== "main") continue;
    const { block, pos, oldId } = locate(c.w, idx);
    const seq = mainSequence(c.w);
    assert.equal(violationCount(seq, byId), 0, "premise: warning-free input has no violations");
    // Position of the target move in the main sequence.
    let offset = 0;
    for (const g of groups(c.w).filter((x) => x.section === "main")) {
      if (g.id === block.id) break;
      offset += g.ids.length;
    }
    const at = offset + pos;
    assert.equal(seq[at], oldId);
    const lo = leftover(c.w, library);
    const used = usedIds(c.w);
    const good = mainPool(c.w, library).filter((e) => {
      if (used.has(e.id)) return false;
      const delta = block.rounds * (moveCost(c.w, library, oldId) - moveCost(c.w, library, e.id));
      if (lo + delta < 0 || Math.abs(delta) > c.w.options.workSeconds) return false;
      const next = seq.slice();
      next[at] = e.id;
      return violationCount(next, byId) === 0;
    });
    if (good.length === 0) continue;
    preferred++;
    assert.equal(res.changed, true);
    const newId = assertOnlyMoveReplaced(c.w, res.workout, idx);
    assert.ok(good.some((e) => e.id === newId), `${newId} breaks a neighbor rule although ${good.map((e) => e.id)} would not`);
    assert.equal(violationCount(mainSequence(res.workout), byId), 0);
    assert.deepEqual(res.workout.warnings, c.w.warnings, "no warning when the rules were met");
  }
  assert.ok(preferred > 100, `only ${preferred} cases had a rule-abiding replacement`);
});

test("a move is chosen over a focus-overlapping one even when the overlapping one is also available", () => {
  const lib0 = [
    mk("a", { focus: ["upper-abs"], pattern: "static" }),
    mk("b", { focus: ["lower-abs"], pattern: "dynamic" }),
    mk("c", { focus: ["obliques"], pattern: "rotational" }),
  ];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  assert.deepEqual(w.warnings, []);
  const lib = [
    ...lib0,
    mk("bad", { focus: ["upper-abs", "lower-abs", "obliques"], pattern: "dynamic" }),
    mk("good", { focus: ["full"], pattern: "dynamic" }),
  ];
  for (let idx = 0; idx < 3; idx++) {
    for (const seed of seeds(10)) {
      const res = rerollSlot(lib, w, idx, mulberry32(seed));
      assert.equal(res.changed, true);
      assert.equal(res.workout.slots[idx].exerciseId, "good", `slot ${idx} seed ${seed}`);
      assert.deepEqual(res.workout.warnings, []);
    }
  }
});

test("a move is chosen over one that would put the same pattern three times in a row", () => {
  // Two static moves and one dynamic: swapping the dynamic move for another
  // static one would make three statics in a row, whatever the order.
  const lib0 = [
    mk("x1", { pattern: "static" }),
    mk("x2", { pattern: "static" }),
    mk("y", { pattern: "dynamic" }),
  ];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  const idx = w.slots.findIndex((s) => s.exerciseId === "y");
  const lib = [...lib0, mk("s", { pattern: "static" }), mk("r", { pattern: "rotational" })];
  for (const seed of seeds(10)) {
    const res = rerollSlot(lib, w, idx, mulberry32(seed));
    assert.equal(res.changed, true);
    assert.equal(res.workout.slots[idx].exerciseId, "r", `seed ${seed}`);
    assert.deepEqual(res.workout.warnings, []);
  }
});

test("when every replacement overlaps a neighbor's focus the rules are loosened: the move still changes and a new warning is added", () => {
  const lib0 = [
    mk("a", { focus: ["upper-abs"], pattern: "static" }),
    mk("b", { focus: ["lower-abs"], pattern: "dynamic" }),
    mk("c", { focus: ["obliques"], pattern: "rotational" }),
  ];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  assert.deepEqual(w.warnings, []);
  const lib = [...lib0, mk("d", { focus: ["upper-abs", "lower-abs", "obliques"], pattern: "dynamic" })];
  for (let idx = 0; idx < 3; idx++) {
    const res = rerollSlot(lib, w, idx, mulberry32(1));
    assert.equal(res.changed, true, `slot ${idx}`);
    assert.equal(res.reason == null, true);
    assert.equal(res.workout.slots[idx].exerciseId, "d");
    assert.equal(res.workout.warnings.length, 1);
    assert.equal(typeof res.workout.warnings[0], "string");
    assert.ok(res.workout.warnings[0].length > 0);
    assertSane(res.workout, lib);
  }
});

test("when every replacement makes a pattern three in a row the rules are loosened with a new warning", () => {
  const lib0 = [
    mk("x1", { pattern: "static" }),
    mk("x2", { pattern: "static" }),
    mk("y", { pattern: "dynamic" }),
  ];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  const idx = w.slots.findIndex((s) => s.exerciseId === "y");
  const res = rerollSlot([...lib0, mk("s", { pattern: "static" })], w, idx, mulberry32(1));
  assert.equal(res.changed, true);
  assert.equal(res.workout.slots[idx].exerciseId, "s");
  assert.equal(res.workout.warnings.length, w.warnings.length + 1);
});

test("loosening keeps every existing warning and adds a new one without removing anything", () => {
  const lib0 = [
    mk("a", { focus: ["upper-abs"], pattern: "static" }),
    mk("b", { focus: ["lower-abs"], pattern: "dynamic" }),
    mk("c", { focus: ["obliques"], pattern: "rotational" }),
  ];
  const w = generateWorkout(lib0, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  const withNote = { ...w, warnings: ["existing note", "another note"] };
  const lib = [...lib0, mk("d", { focus: ["upper-abs", "lower-abs", "obliques"], pattern: "dynamic" })];
  const res = rerollSlot(lib, withNote, 1, mulberry32(1));
  assert.equal(res.changed, true);
  assert.deepEqual(res.workout.warnings.slice(0, 2), ["existing note", "another note"]);
  assert.equal(res.workout.warnings.length, 3);
  assert.ok(!["existing note", "another note"].includes(res.workout.warnings[2]));
  assert.deepEqual(withNote.warnings, ["existing note", "another note"], "input warnings are not mutated");
});

test("in the real library existing warnings are never dropped, and a new warning appears whenever a re-roll adds an ordering violation", () => {
  for (const { c, idx, res, section } of changedRerolls()) {
    if (section !== "main") continue;
    const before = c.w.warnings;
    const after = res.workout.warnings;
    for (const w of before) assert.ok(after.includes(w), "existing warning dropped");
    const seqBefore = violationCount(mainSequence(c.w), byId);
    const seqAfter = violationCount(mainSequence(res.workout), byId);
    if (seqAfter > seqBefore) {
      assert.ok(after.length > before.length, "a rule was loosened without a new warning");
    }
  }
});

// ---------------------------------------------------------------------------
// No alternative, and carried-over fields
// ---------------------------------------------------------------------------

test("a library with only the moves already in the workout has no alternative: changed false and the same object back", () => {
  const lib = [mk("a"), mk("b", { pattern: "dynamic" }), mk("c", { pattern: "rotational" })];
  const w = generateWorkout(lib, { ...SHORT, totalSeconds: 160 }, mulberry32(1));
  assert.equal(new Set(w.slots.map((s) => s.exerciseId)).size, 3, "premise");
  for (let idx = 0; idx < w.slots.length; idx++) {
    const res = rerollSlot(lib, w, idx, mulberry32(1));
    assert.equal(res.changed, false);
    assert.equal(res.reason, "no-alternative");
    assert.equal(res.workout, w);
  }
});

test("options and randomized are carried over unchanged, and warnings are carried over", () => {
  let checked = 0;
  for (const { c, res } of changedRerolls()) {
    checked++;
    assert.deepEqual(res.workout.options, c.w.options);
    assert.deepEqual(res.workout.randomized, c.w.randomized);
    for (const w of c.w.warnings) assert.ok(res.workout.warnings.includes(w));
  }
  assert.ok(checked > 100);
  assert.ok(changedRerolls().some((r) => r.c.w.randomized.length > 0), "premise: some workouts have randomized options");
});

test("re-rolling does not change the original workout object", () => {
  const w = generateWorkout(library, CIRCUIT, mulberry32(2));
  const snapshot = structuredClone(w);
  for (let idx = 0; idx < w.slots.length; idx++) rerollSlot(library, w, idx, mulberry32(idx + 1));
  assert.deepEqual(w, snapshot);
});

test("the result can be re-rolled again (a re-rolled workout is a valid input)", () => {
  let w = generateWorkout(library, { ...BASE, warmup: { enabled: true } }, mulberry32(4));
  for (let step = 0; step < 20; step++) {
    const idx = step % w.slots.length;
    const res = rerollSlot(library, w, idx, mulberry32(step + 1));
    assertSane(res.workout, library);
    assert.equal(res.workout.durationSeconds, 600);
    w = res.workout;
  }
});
