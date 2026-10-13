// Logic layer (see CLAUDE.md): pure functions only. No DOM, no audio, no I/O.
//
// rerollSlot(library, workout, slotIndex, rng = Math.random)
//   -> { workout, changed, reason }
//
// Replaces one move in a workout produced by generateWorkout, for the preview
// screen (#8). Whole-workout re-roll needs no function here: the Shell keeps the
// user's original options and calls generateWorkout again.
//
// - Any slot index resolves to its whole move: both sides of a two-sided move
//   are replaced, a circuit move is replaced in every round.
// - The replacement is a move that is eligible for that section (main: the
//   generator's main pool; warm-up: the generator's warm-up pool) and not
//   already anywhere in the workout.
// - The workout is rebuilt from base work times, so the total stays exact: the
//   last move absorbs the leftover. A replacement is only allowed if the leftover
//   stays non-negative and changes by at most one work interval.
// - Prefers a replacement that keeps neighbors' focus and pattern rules. If none
//   does, those two rules are loosened (fewest violations wins) and a warning is
//   added. If nothing fits at all, nothing changes (reason "no-alternative").
//
// Never mutates its inputs. Slot indices are not stable across a re-roll (a
// two-sided move is two slots), so callers should re-render from the result.

import { buildTimeline, costOf, focusOverlap, mainPool, warmupPool } from "./generator.js";

const LOOSENED_WARNING =
  "A re-rolled move may overlap its neighbors' focus or repeat their pattern because no other move fit.";

const pickOne = (rng, arr) => arr[Math.floor(rng() * arr.length)];

export function rerollSlot(library, workout, slotIndex, rng = Math.random) {
  const { slots, blocks, options } = workout;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slots.length) {
    throw new RangeError(`slotIndex must be an integer from 0 to ${slots.length - 1}`);
  }

  const byId = new Map(library.map((ex) => [ex.id, ex]));
  const exercise = (id) => {
    const ex = byId.get(id);
    if (!ex) throw new Error(`Unknown exercise "${id}": the library does not match the workout.`);
    return ex;
  };

  // Rebuild the block specs (one entry per move, not per slot or round).
  const specs = blocks.map((block) => {
    const inBlock = slots.slice(block.firstSlot, block.lastSlot + 1);
    const moves = [];
    for (const s of inBlock) {
      if (s.round === 1 && s.side !== "right") moves.push(exercise(s.exerciseId));
    }
    return { id: block.id, kind: block.kind, section: inBlock[0].section, rounds: block.rounds, moves };
  });

  // Which move is this slot? Count moves in its round up to the slot.
  const slot = slots[slotIndex];
  const specIdx = blocks.findIndex((b) => slotIndex >= b.firstSlot && slotIndex <= b.lastSlot);
  let moveIdx = -1;
  for (let i = blocks[specIdx].firstSlot; i <= slotIndex; i++) {
    if (slots[i].round === slot.round && slots[i].side !== "right") moveIdx++;
  }

  const spec = specs[specIdx];
  const isWarmup = spec.section === "warmup";

  // Sequence used for neighbor checks: this section's distinct moves in order
  // (circuit round 1 only).
  let pos = moveIdx;
  const sequence = [];
  for (const sp of specs) {
    if (sp.section !== spec.section) continue;
    if (sp === spec) pos = sequence.length + moveIdx;
    sequence.push(...sp.moves);
  }

  const used = new Set(slots.map((s) => s.exerciseId));
  const pool = (isWarmup ? warmupPool(library) : mainPool(library, options)).filter((ex) => !used.has(ex.id));

  // Time bookkeeping. leftover = time the last move absorbs.
  const work = options.workSeconds;
  const rest = options.restSeconds;
  const specCost = (sp) => sp.rounds * sp.moves.reduce((sum, ex) => sum + costOf(ex, work, rest, sp.section), 0);
  const leftoverOf = (all) => {
    const warmupCost = all.filter((sp) => sp.section === "warmup").reduce((sum, sp) => sum + specCost(sp), 0);
    const target = options.warmup.countsInTotal ? options.totalSeconds : options.totalSeconds + warmupCost;
    return target - (all.reduce((sum, sp) => sum + specCost(sp), 0) - rest);
  };
  const withMove = (candidate) =>
    specs.map((sp, i) =>
      i === specIdx ? { ...sp, moves: sp.moves.map((m, j) => (j === moveIdx ? candidate : m)) } : sp
    );
  const oldLeftover = leftoverOf(specs);

  // Violations a candidate would create next to its neighbors.
  const violationsFor = (candidate) => {
    const seq = sequence.map((m, i) => (i === pos ? candidate : m));
    let v = 0;
    if (pos > 0 && focusOverlap(seq[pos - 1].focus, seq[pos].focus)) v++;
    if (pos < seq.length - 1 && focusOverlap(seq[pos].focus, seq[pos + 1].focus)) v++;
    if (!isWarmup) {
      for (let s = Math.max(0, pos - 2); s <= pos && s + 2 < seq.length; s++) {
        if (seq[s].pattern === seq[s + 1].pattern && seq[s + 1].pattern === seq[s + 2].pattern) v++;
      }
    }
    return v;
  };

  const viable = [];
  for (const candidate of pool) {
    const leftover = leftoverOf(withMove(candidate));
    const fitsTime = (leftover >= 0 || leftover >= oldLeftover) && Math.abs(leftover - oldLeftover) <= work;
    if (fitsTime) viable.push({ candidate, violations: violationsFor(candidate) });
  }
  if (viable.length === 0) return { workout, changed: false, reason: "no-alternative" };

  const best = Math.min(...viable.map((o) => o.violations));
  const chosen = pickOne(rng, viable.filter((o) => o.violations === best));

  const newSpecs = withMove(chosen.candidate);
  const warmupCost = newSpecs.filter((sp) => sp.section === "warmup").reduce((sum, sp) => sum + specCost(sp), 0);
  const timeline = buildTimeline(newSpecs, {
    work,
    rest,
    target: options.warmup.countsInTotal ? options.totalSeconds : options.totalSeconds + warmupCost,
  });

  const warnings = [...(workout.warnings ?? [])];
  if (chosen.violations > 0 && !warnings.includes(LOOSENED_WARNING)) warnings.push(LOOSENED_WARNING);

  return {
    workout: {
      options: structuredClone(options),
      randomized: [...(workout.randomized ?? [])],
      durationSeconds: timeline.durationSeconds,
      slots: timeline.slots,
      blocks: timeline.blocks,
      warnings,
    },
    changed: true,
    reason: null,
  };
}
