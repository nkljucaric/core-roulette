// Logic layer (see CLAUDE.md): pure functions only. No DOM, no localStorage, and
// no hidden randomness: anything random takes an `rng` argument.
//
// Turns what the settings screen holds into options for generateWorkout (#19).
//
//   settings = { mode: "quick" | "advanced", quick: {...}, advanced: {...} }
//
// Quick Start: total time, difficulty, warm-up. Work, rest and circuit are left
// out of the options on purpose, so the generator randomizes them on every
// generate and every whole-workout re-roll.
//
// Advanced: every control holds a concrete value. A circuit switch that is on
// becomes an explicit circuit whose size and rounds are drawn here, from the
// rng, each time options are built, from the sizes that fit the chosen times.
//
// sanitize() turns untrusted stored settings (parsed localStorage JSON) back
// into a complete, valid settings object.

import { RANGES, CIRCUIT_SIZE, CIRCUIT_ROUNDS } from "./generator.js";

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const LIMITS = deepFreeze({
  totalSeconds: { min: 300, max: 1200, step: 60 },
  workSeconds: { min: 20, max: 60, step: 5 },
  restSeconds: { min: 5, max: 10, step: 5 },
});

export const DIFFICULTIES = deepFreeze({ easy: 1, medium: 2, hard: 3 });
export const POSITIONS = deepFreeze(["back", "face-down", "side", "standing"]);
export const FOCUSES = deepFreeze(["upper-abs", "lower-abs", "obliques", "deep-core", "full"]);

export const DEFAULTS = deepFreeze({
  mode: "quick",
  quick: { totalSeconds: 600, difficulty: "medium", warmup: false },
  advanced: {
    totalSeconds: 600,
    workSeconds: 40,
    restSeconds: 10,
    warmup: { enabled: false, countsInTotal: true },
    position: { mode: "any", values: [] },
    focus: { mode: "any", values: [] },
    circuit: false,
  },
});

const fresh = (o) => structuredClone(o);

// Uniform integer from min to max inclusive. Guards against an rng that returns 1.
const randInt = (rng, min, max) => min + Math.min(max - min, Math.floor(rng() * (max - min + 1)));

// Uniform pick from a { min, max, step } grid.
const randGrid = (rng, { min, max, step }) => min + step * randInt(rng, 0, Math.round((max - min) / step));

// ---------------------------------------------------------------------------
// Options for the generator
// ---------------------------------------------------------------------------

export function quickOptions(quick) {
  const maxDifficulty = DIFFICULTIES[quick.difficulty];
  if (maxDifficulty === undefined) throw new RangeError(`Unknown difficulty "${quick.difficulty}"`);
  return {
    totalSeconds: quick.totalSeconds,
    maxDifficulty,
    warmup: { enabled: Boolean(quick.warmup), countsInTotal: true },
  };
}

// Share of the total time a circuit may take. Mirrors the generator's own limit
// for circuits it picks itself; an explicit circuit would be allowed to take far
// more, but then most random picks would not fit and come back shrunk, with a
// warning on the preview.
const CIRCUIT_SHARE = 0.6;

// A random circuit size and rounds that fit the time. If none fits, the smallest
// circuit (the generator then drops it with a warning if it still cannot fit).
function pickCircuit({ totalSeconds, workSeconds, restSeconds }, rng) {
  const perMove = workSeconds + restSeconds;
  const budget = CIRCUIT_SHARE * totalSeconds;
  const fits = [];
  for (let size = CIRCUIT_SIZE.min; size <= CIRCUIT_SIZE.max; size++) {
    for (let rounds = CIRCUIT_ROUNDS.min; rounds <= CIRCUIT_ROUNDS.max; rounds++) {
      if (size * rounds * perMove <= budget) fits.push({ size, rounds });
    }
  }
  if (fits.length === 0) return { size: CIRCUIT_SIZE.min, rounds: CIRCUIT_ROUNDS.min };
  return fits[Math.min(fits.length - 1, Math.floor(rng() * fits.length))];
}

export function advancedOptions(advanced, rng = Math.random) {
  const circuit = advanced.circuit ? pickCircuit(advanced, rng) : null;
  return {
    totalSeconds: advanced.totalSeconds,
    workSeconds: advanced.workSeconds,
    restSeconds: advanced.restSeconds,
    warmup: { enabled: advanced.warmup.enabled, countsInTotal: advanced.warmup.countsInTotal },
    position: { mode: advanced.position.mode, values: [...advanced.position.values] },
    focus: { mode: advanced.focus.mode, values: [...advanced.focus.values] },
    circuit,
  };
}

export function buildOptions(settings, rng = Math.random) {
  if (settings?.mode === "quick") return quickOptions(settings.quick);
  if (settings?.mode === "advanced") return advancedOptions(settings.advanced, rng);
  throw new RangeError(`Unknown mode "${settings?.mode}"`);
}

// ---------------------------------------------------------------------------
// Randomize (Advanced)
// ---------------------------------------------------------------------------

// A new Advanced state with random times, warm-up and circuit. Filters are
// cleared: no filter is the most random workout there is.
export function randomizeAdvanced(_current, rng = Math.random) {
  return {
    totalSeconds: randGrid(rng, RANGES.totalSeconds),
    workSeconds: randGrid(rng, RANGES.workSeconds),
    restSeconds: randGrid(rng, RANGES.restSeconds),
    warmup: { enabled: rng() < 0.5, countsInTotal: true },
    position: { mode: "any", values: [] },
    focus: { mode: "any", values: [] },
    circuit: rng() < 0.5,
  };
}

// ---------------------------------------------------------------------------
// Sanitizing stored settings
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);

function number(v, { min, max, step }, fallback) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const clamped = Math.min(max, Math.max(min, v));
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

function filter(v, allowed) {
  if (!isObject(v)) return { mode: "any", values: [] };
  const values = [];
  if (Array.isArray(v.values)) {
    for (const x of v.values) {
      if (typeof x === "string" && allowed.includes(x) && !values.includes(x)) values.push(x);
    }
  }
  return { mode: v.mode === "none" ? "none" : "any", values };
}

export function sanitize(stored) {
  if (!isObject(stored)) return fresh(DEFAULTS);
  const q = isObject(stored.quick) ? stored.quick : {};
  const a = isObject(stored.advanced) ? stored.advanced : {};
  const w = isObject(a.warmup) ? a.warmup : {};
  const dq = DEFAULTS.quick;
  const da = DEFAULTS.advanced;
  return {
    mode: stored.mode === "advanced" ? "advanced" : "quick",
    quick: {
      totalSeconds: number(q.totalSeconds, LIMITS.totalSeconds, dq.totalSeconds),
      difficulty: typeof q.difficulty === "string" && Object.hasOwn(DIFFICULTIES, q.difficulty) ? q.difficulty : dq.difficulty,
      warmup: bool(q.warmup, dq.warmup),
    },
    advanced: {
      totalSeconds: number(a.totalSeconds, LIMITS.totalSeconds, da.totalSeconds),
      workSeconds: number(a.workSeconds, LIMITS.workSeconds, da.workSeconds),
      restSeconds: number(a.restSeconds, LIMITS.restSeconds, da.restSeconds),
      warmup: {
        enabled: bool(w.enabled, da.warmup.enabled),
        countsInTotal: bool(w.countsInTotal, da.warmup.countsInTotal),
      },
      position: filter(a.position, POSITIONS),
      focus: filter(a.focus, FOCUSES),
      circuit: bool(a.circuit, da.circuit),
    },
  };
}
