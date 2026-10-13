// Logic layer (see CLAUDE.md): pure functions only. No DOM, no audio.
//
// Turns a generated workout into the rows the preview screen draws (#20).
//
//   buildPreview(workout) -> { totalSec, moveCount, workSeconds, restSeconds,
//                              warnings, sections }
//
// A section is one block of the workout (warm-up, main set, circuit). Its
// `items` are move rows and rest rows in order:
//   move: { type: "move", exerciseId, name, startSec, endSec, workSeconds,
//           sides, longSeconds }
//   rest: { type: "rest", seconds, startSec, endSec }
//
// A "move" is the consecutive slots of one exercise in one block and round, so
// a two-sided move (left + right) is a single row. Circuits are collapsed:
// only round 1 is listed, and `rounds` says how many times it repeats.
// `sides` is "each" (left then right), "alternate" (warm-up), or null.
// `longSeconds` is set only on the workout's last move, when it absorbed
// leftover time and now runs at least LONG_MARGIN_SEC over the work length.
// When the last move sits in a collapsed circuit (its final round is not
// listed), the circuit section carries `finalLong: { name, longSeconds }`
// instead; it is null everywhere else.

export const LONG_MARGIN_SEC = 10;

const SECTION_KIND = { warmup: "warmup", straight: "main", circuit: "circuit" };

function groupMoves(slots) {
  const groups = [];
  for (const slot of slots) {
    const g = groups[groups.length - 1];
    const first = g?.[0];
    if (first && first.blockId === slot.blockId && first.round === slot.round && first.exerciseId === slot.exerciseId) {
      g.push(slot);
    } else {
      groups.push([slot]);
    }
  }
  return groups;
}

function sidesOf(group) {
  if (group[0].side === "alternate") return "alternate";
  return group.length > 1 ? "each" : null;
}

export function buildPreview(workout) {
  const slots = workout?.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new RangeError("The workout has no slots to preview.");
  }
  const lastSlot = slots[slots.length - 1];
  const baseWork = workout.options?.workSeconds;

  const sections = workout.blocks.map((block, i) => {
    const kind = SECTION_KIND[block.kind];
    const inBlock = slots.slice(block.firstSlot, block.lastSlot + 1);
    const shown = block.kind === "circuit" ? inBlock.filter((s) => s.round === 1) : inBlock;

    const items = [];
    for (const group of groupMoves(shown)) {
      const first = group[0];
      const last = group[group.length - 1];
      const isFinal = last === lastSlot;
      items.push({
        type: "move",
        exerciseId: first.exerciseId,
        name: first.name,
        startSec: first.startSec,
        endSec: last.endSec,
        workSeconds: first.workSeconds,
        sides: sidesOf(group),
        longSeconds: isFinal && last.workSeconds - baseWork >= LONG_MARGIN_SEC ? last.workSeconds : null,
      });
      if (last.restAfter > 0) {
        items.push({ type: "rest", seconds: last.restAfter, startSec: last.endSec, endSec: last.endSec + last.restAfter });
      }
    }

    const holdsFinal = block.kind === "circuit" && block.lastSlot === slots.length - 1;
    const finalLong =
      holdsFinal && lastSlot.workSeconds - baseWork >= LONG_MARGIN_SEC
        ? { name: lastSlot.name, longSeconds: lastSlot.workSeconds }
        : null;

    const prev = i > 0 ? SECTION_KIND[workout.blocks[i - 1].kind] : null;
    const heading =
      kind === "warmup" ? "Warm-up"
      : kind === "circuit" ? "Circuit"
      : i > 0 && prev !== "main" ? "Main set"
      : null;

    return {
      kind,
      heading,
      rounds: block.kind === "circuit" ? block.rounds : 1,
      startSec: inBlock[0].startSec,
      endSec: inBlock[inBlock.length - 1].endSec,
      items,
      finalLong,
    };
  });

  return {
    totalSec: lastSlot.endSec,
    moveCount: new Set(slots.map((s) => s.exerciseId)).size,
    workSeconds: workout.options?.workSeconds,
    restSeconds: workout.options?.restSeconds,
    warnings: [...(workout.warnings ?? [])],
    sections,
  };
}
