// Logic layer (see CLAUDE.md): pure functions only. No DOM, no audio, no I/O.
//
// generateWorkout(library, options = {}, rng = Math.random)
//
// Builds a timed workout from the exercise library. Any option left undefined
// is randomized ("true roulette"). `rng` returns a number in [0, 1) so tests
// can inject a seeded one.
//
// Options:
//   totalSeconds, workSeconds, restSeconds   numbers (unset => random in RANGES)
//   warmup      { enabled, countsInTotal }   unset => off; countsInTotal defaults true
//   position    { mode: "any"|"none", values: [] }   empty/unset => no filtering
//   focus       { mode: "any"|"none", values: [] }   empty/unset => no filtering
//   circuit     { size, rounds } | null      unset => roulette may pick one
//   maxDifficulty                            1-3, unset => any
//
// Returns { options, randomized, durationSeconds, slots, blocks, warnings }.
//   options     the fully resolved options (shows what was rolled)
//   randomized  names of the options the generator filled in
//   slots       one flat, expanded list of timed work periods: two-sided moves
//               are two consecutive slots (side "left" then "right"), circuit
//               rounds are separate entries
//   blocks      warm-up / straight / circuit groupings of the slots
//   warnings    human-readable notes (repeats, relaxed rules, dropped circuit)
//
// Throws if no exercise matches the filters.

export const RANGES = {
  totalSeconds: { min: 480, max: 720, step: 60 },
  workSeconds: { min: 30, max: 50, step: 5 },
  restSeconds: { min: 10, max: 30, step: 5 },
};
export const CIRCUIT_CHANCE = 0.3; // chance the roulette adds a circuit when unset
export const CIRCUIT_SIZE = { min: 2, max: 5 };
export const CIRCUIT_ROUNDS = { min: 2, max: 4 };

const WARMUP_MOVES = 2;
const AUTO_CIRCUIT_SHARE = 0.6; // an unrequested circuit may use at most this share of the main time
const STRICT_ATTEMPTS = 200;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const randInt = (rng, n) => Math.floor(rng() * n);
const pickOne = (rng, arr) => arr[randInt(rng, arr.length)];
const randStep = (rng, { min, max, step }) => min + step * randInt(rng, (max - min) / step + 1);
const randRange = (rng, { min, max }) => min + randInt(rng, max - min + 1);

function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const workOf = (ex, work) => ex.workSeconds ?? work;
const sidesOf = (ex) => (ex.perSide ? 2 : 1);
// Time a move takes including the rest after it (and after both sides, if any).
export const costOf = (ex, work, rest) => workOf(ex, work) * sidesOf(ex) + rest;

// "full" focus overlaps with nothing, so it can sit next to any move.
export function focusOverlap(a, b) {
  if (a.includes("full") || b.includes("full")) return false;
  return a.some((f) => b.includes(f));
}

function patternOk(ex, history) {
  const n = history.length;
  return !(n >= 2 && history[n - 1].pattern === ex.pattern && history[n - 2].pattern === ex.pattern);
}

export function countViolations(seq) {
  let v = 0;
  for (let i = 1; i < seq.length; i++) {
    if (focusOverlap(seq[i - 1].focus, seq[i].focus)) v++;
    if (i >= 2 && seq[i].pattern === seq[i - 1].pattern && seq[i].pattern === seq[i - 2].pattern) v++;
  }
  return v;
}

function positiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

function resolveFilter(name, filter) {
  if (filter == null) return { mode: "any", values: [] };
  const mode = filter.mode ?? "any";
  if (mode !== "any" && mode !== "none") {
    throw new RangeError(`${name}.mode must be "any" or "none"`);
  }
  return { mode, values: Array.isArray(filter.values) ? [...filter.values] : [] };
}

function matchesFilter(values, filter) {
  if (filter.values.length === 0) return true;
  const hit = values.some((v) => filter.values.includes(v));
  return filter.mode === "any" ? hit : !hit;
}

// Moves eligible for the main section given resolved options (maxDifficulty,
// position, focus). Warm-up-only moves never appear in the main section.
export function mainPool(library, { maxDifficulty, position, focus }) {
  return library.filter(
    (ex) =>
      ex.warmup !== "only" &&
      ex.difficulty <= maxDifficulty &&
      matchesFilter([ex.position], position) &&
      matchesFilter(ex.focus, focus)
  );
}

// Moves a warm-up may draw from: easy ones, ignoring the position and focus
// filters (falls back to harder warm-up moves only if fewer than two are easy).
export function warmupPool(library) {
  const candidates = library.filter((ex) => ex.warmup === "eligible" || ex.warmup === "only");
  const easy = candidates.filter((ex) => ex.difficulty === 1);
  const harder = candidates.filter((ex) => ex.difficulty !== 1).sort((a, b) => a.difficulty - b.difficulty);
  return easy.length >= WARMUP_MOVES ? easy : [...easy, ...harder];
}

// Expands block specs ({ id, kind, section, rounds, moves }) into the flat slot
// list and block list. The last slot has no rest after it and absorbs leftover
// time up to `target`; if the specs already exceed `target`, `overflow` is true
// and nothing is added.
export function buildTimeline(specs, { work, rest, target }) {
  const slots = [];
  const blocks = [];
  for (const spec of specs) {
    const firstSlot = slots.length;
    for (let round = 1; round <= spec.rounds; round++) {
      for (const ex of spec.moves) {
        const sides = ex.perSide ? ["left", "right"] : [null];
        sides.forEach((side, i) => {
          slots.push({
            index: 0,
            exerciseId: ex.id,
            name: ex.name,
            section: spec.section,
            blockId: spec.id,
            round,
            side,
            workSeconds: workOf(ex, work),
            restAfter: i === sides.length - 1 ? rest : 0,
            startSec: 0,
            endSec: 0,
          });
        });
      }
    }
    blocks.push({ id: spec.id, kind: spec.kind, rounds: spec.rounds, firstSlot, lastSlot: slots.length - 1 });
  }

  const last = slots[slots.length - 1];
  last.restAfter = 0;
  const planned = slots.reduce((sum, s) => sum + s.workSeconds + s.restAfter, 0);
  const overflow = planned > target;
  if (!overflow) last.workSeconds += target - planned;

  let t = 0;
  slots.forEach((s, i) => {
    s.index = i;
    s.startSec = t;
    s.endSec = t + s.workSeconds;
    t = s.endSec + s.restAfter;
  });
  return { slots, blocks, durationSeconds: last.endSec, overflow };
}

// ---------------------------------------------------------------------------
// Picking moves
// ---------------------------------------------------------------------------

// Picks the next move for a sequence. `used` maps exercise id -> times used,
// `history` is the moves already placed in this run, `budget` is the time left
// (including the rest allowance, see tryBuild).
//   { done: true }   no move in the pool fits the remaining time
//   { fail: true }   strict mode only: a move fits but none obeys the rules
//   { ex, tier, repeat }
// Relaxation tiers, in order: 0 all rules, 1 pattern mixing relaxed,
// 2 back-to-back focus relaxed, 3 repeats allowed (never the same move twice
// in a row unless it is the only one that fits).
function pickNext({ pool, used, history, budget, work, rest, rng, strict }) {
  const prev = history.length ? history[history.length - 1] : null;
  const fitting = pool.filter((ex) => costOf(ex, work, rest) <= budget);
  if (fitting.length === 0) return { done: true };

  const count = (ex) => used.get(ex.id) ?? 0;
  const unused = fitting.filter((ex) => count(ex) === 0);
  const okFocus = (ex) => !prev || !focusOverlap(prev.focus, ex.focus);
  const okPattern = (ex) => patternOk(ex, history);
  const tiers = [
    unused.filter((ex) => okFocus(ex) && okPattern(ex)),
    unused.filter(okFocus),
    unused,
  ];
  for (let t = 0; t < tiers.length; t++) {
    if (strict && t > 0) break;
    if (tiers[t].length) return { ex: pickOne(rng, tiers[t]), tier: t, repeat: false };
  }
  if (strict) return { fail: true };

  // Repeats: prefer a different move, one that respects focus, and the least used.
  const different = fitting.filter((ex) => !prev || ex.id !== prev.id);
  const base = different.length ? different : fitting;
  const focusFriendly = base.filter(okFocus);
  const candidates = focusFriendly.length ? focusFriendly : base;
  const minUse = Math.min(...candidates.map(count));
  const least = candidates.filter((ex) => count(ex) === minUse);
  return { ex: pickOne(rng, least), tier: 3, repeat: true };
}

// Plans a circuit: picks `size` distinct moves, then shrinks rounds (down to 2)
// and then size (down to 2) until it fits. Returns { fail }, { dropped } or
// { picks, rounds, cost, tier, shrunk }.
function planCircuit(ctx, request, explicit) {
  const { pool, work, rest, M, rng, strict } = ctx;
  const wanted = Math.min(request.size, pool.length);
  if (wanted < 2) return { dropped: true };

  const tmpUsed = new Map();
  const picks = [];
  let tier = 0;
  for (let i = 0; i < wanted; i++) {
    const r = pickNext({ pool, used: tmpUsed, history: picks, budget: Infinity, work, rest, rng, strict });
    if (r.fail) return { fail: true };
    picks.push(r.ex);
    tmpUsed.set(r.ex.id, 1);
    tier = Math.max(tier, r.tier);
  }

  const roundCost = (k) => picks.slice(0, k).reduce((s, ex) => s + costOf(ex, work, rest), 0);
  const cap = explicit ? M + rest : AUTO_CIRCUIT_SHARE * M;
  let size = picks.length;
  let rounds = request.rounds;
  while (rounds * roundCost(size) > cap) {
    if (rounds > 2) rounds--;
    else if (size > 2) size--;
    else return { dropped: true };
  }
  return {
    picks: picks.slice(0, size),
    rounds,
    cost: rounds * roundCost(size),
    tier,
    shrunk: size < request.size || rounds < request.rounds,
  };
}

// One attempt at building the main section. Strict attempts fail (return
// { ok: false }) rather than break a rule; the relaxed attempt always succeeds.
function tryBuild(ctx, strict) {
  const { pool, work, rest, M, rng, circuitRequest, explicitCircuit } = ctx;
  const used = new Map();
  let tierMax = 0;
  let repeated = false;
  let circuit = null;
  let droppedCircuit = false;

  if (circuitRequest) {
    const planned = planCircuit({ pool, work, rest, M, rng, strict }, circuitRequest, explicitCircuit);
    if (planned.fail) return { ok: false };
    if (planned.dropped) {
      droppedCircuit = true;
    } else {
      circuit = planned;
      for (const ex of circuit.picks) used.set(ex.id, 1);
      tierMax = Math.max(tierMax, planned.tier);
    }
  }

  // Each move is costed with its trailing rest, so the budget is the main time
  // plus one rest: the last move in the timeline never has a rest after it.
  let budget = M + rest - (circuit ? circuit.cost : 0);
  const straight = [];
  for (;;) {
    const r = pickNext({ pool, used, history: straight, budget, work, rest, rng, strict });
    if (r.done) break;
    if (r.fail) return { ok: false };
    straight.push(r.ex);
    used.set(r.ex.id, (used.get(r.ex.id) ?? 0) + 1);
    budget -= costOf(r.ex, work, rest);
    tierMax = Math.max(tierMax, r.tier);
    repeated = repeated || r.repeat;
  }

  let circuitAt = -1;
  let violations = countViolations(straight);
  if (circuit) {
    let best = null;
    for (const idx of shuffle(rng, Array.from({ length: straight.length + 1 }, (_, i) => i))) {
      const seq = [...straight.slice(0, idx), ...circuit.picks, ...straight.slice(idx)];
      const v = countViolations(seq);
      if (!best || v < best.v) best = { idx, v };
      if (v === 0) break;
    }
    if (strict && best.v > 0) return { ok: false };
    circuitAt = best.idx;
    violations = best.v;
  }

  return { ok: true, straight, circuit, circuitAt, tierMax, repeated, violations, droppedCircuit };
}

// ---------------------------------------------------------------------------
// generateWorkout
// ---------------------------------------------------------------------------

export function generateWorkout(library, options = {}, rng = Math.random) {
  if (!Array.isArray(library)) throw new TypeError("library must be an array of exercises");
  const opts = options ?? {};
  const randomized = [];
  const warnings = new Set();

  const resolveTime = (key) => {
    if (opts[key] === undefined) {
      randomized.push(key);
      return randStep(rng, RANGES[key]);
    }
    return positiveNumber(key, opts[key]);
  };
  const totalSeconds = resolveTime("totalSeconds");
  const workSeconds = resolveTime("workSeconds");
  const restSeconds = resolveTime("restSeconds");

  const maxDifficulty = opts.maxDifficulty ?? 3;
  if (![1, 2, 3].includes(maxDifficulty)) throw new RangeError("maxDifficulty must be 1, 2 or 3");

  const warmup = {
    enabled: Boolean(opts.warmup?.enabled),
    countsInTotal: opts.warmup?.countsInTotal ?? true,
  };
  const position = resolveFilter("position", opts.position);
  const focus = resolveFilter("focus", opts.focus);

  let circuitRequest = null;
  let explicitCircuit = false;
  if (opts.circuit === undefined) {
    randomized.push("circuit");
    if (rng() < CIRCUIT_CHANCE) {
      circuitRequest = { size: randRange(rng, CIRCUIT_SIZE), rounds: randRange(rng, CIRCUIT_ROUNDS) };
    }
  } else if (opts.circuit !== null) {
    explicitCircuit = true;
    const size = Math.floor(opts.circuit.size);
    const rounds = Math.floor(opts.circuit.rounds);
    if (size >= 2 && rounds >= 2) circuitRequest = { size, rounds };
  }

  const eligible = mainPool(library, { maxDifficulty, position, focus });
  if (eligible.length === 0) {
    throw new Error("No exercises match the selected filters (position, focus, difficulty).");
  }

  // Warm-up: easy warm-up moves, ignoring the position and focus filters.
  const specs = [];
  let warmupCost = 0;
  const warmIds = new Set();
  if (warmup.enabled) {
    const warmPool = warmupPool(library);
    if (warmPool.length === 0) {
      warnings.add("No warm-up exercises are available in the library.");
    } else {
      const first = pickOne(rng, warmPool);
      const rest = warmPool.filter((ex) => ex.id !== first.id);
      const moves = [first];
      if (rest.length && WARMUP_MOVES > 1) {
        const friendly = rest.filter((ex) => !focusOverlap(first.focus, ex.focus));
        moves.push(pickOne(rng, friendly.length ? friendly : rest));
      }
      for (const ex of moves) {
        warmIds.add(ex.id);
        warmupCost += costOf(ex, workSeconds, restSeconds);
      }
      specs.push({ id: "warmup", kind: "warmup", section: "warmup", rounds: 1, moves });
    }
  }

  const pool = eligible.filter((ex) => !warmIds.has(ex.id));
  const M = warmup.countsInTotal ? totalSeconds - warmupCost : totalSeconds;
  const target = warmup.countsInTotal ? totalSeconds : totalSeconds + warmupCost;

  const ctx = {
    pool,
    work: workSeconds,
    rest: restSeconds,
    M,
    rng,
    circuitRequest,
    explicitCircuit,
  };
  let build = null;
  for (let attempt = 0; attempt < STRICT_ATTEMPTS && !build; attempt++) {
    const result = tryBuild(ctx, true);
    if (result.ok) build = result;
  }
  if (!build) build = tryBuild(ctx, false);

  if (build.repeated) {
    warnings.add("Not enough matching exercises to fill the time without repeating; some exercises repeat.");
  }
  if (build.tierMax > 0 || build.violations > 0) {
    warnings.add("Some ordering rules were relaxed because few exercises matched.");
  }
  if (explicitCircuit && circuitRequest) {
    if (build.droppedCircuit) {
      warnings.add("The requested circuit did not fit in the time and was left out.");
    } else if (build.circuit && build.circuit.shrunk) {
      warnings.add(
        `The circuit was reduced to ${build.circuit.picks.length} moves x ${build.circuit.rounds} rounds to fit the time.`
      );
    }
  }

  // Main section blocks: straight moves, with the circuit inserted if there is one.
  let straightCount = 0;
  const straightSpec = (moves) => ({
    id: `straight-${++straightCount}`,
    kind: "straight",
    section: "main",
    rounds: 1,
    moves,
  });
  if (build.circuit) {
    const before = build.straight.slice(0, build.circuitAt);
    const after = build.straight.slice(build.circuitAt);
    if (before.length) specs.push(straightSpec(before));
    specs.push({
      id: "circuit",
      kind: "circuit",
      section: "main",
      rounds: build.circuit.rounds,
      moves: build.circuit.picks,
    });
    if (after.length) specs.push(straightSpec(after));
  } else if (build.straight.length) {
    specs.push(straightSpec(build.straight));
  }
  if (specs.length === 0) throw new RangeError("The total time is too short for even one exercise.");

  const { slots, blocks, durationSeconds, overflow } = buildTimeline(specs, {
    work: workSeconds,
    rest: restSeconds,
    target,
  });
  if (overflow) warnings.add("The warm-up and exercises are longer than the total time.");

  return {
    options: {
      totalSeconds,
      workSeconds,
      restSeconds,
      warmup,
      position,
      focus,
      circuit: build.circuit ? { size: build.circuit.picks.length, rounds: build.circuit.rounds } : null,
      maxDifficulty,
    },
    randomized,
    durationSeconds,
    slots,
    blocks,
    warnings: [...warnings],
  };
}
