// Shell layer: a bare preview of the generated workout. Issue #20 replaces this
// with time windows, circuit brackets and single-move re-roll.

import { h, formatClock } from "./dom.js";

function slotName(slot) {
  if (slot.side === "alternate") return `${slot.name}, alternate sides`;
  return slot.side ? `${slot.name}, ${slot.side}` : slot.name;
}

function slotDetail(slot) {
  return slot.restAfter > 0 ? `${slot.workSeconds} s work, ${slot.restAfter} s rest` : `${slot.workSeconds} s work`;
}

function slotRow(slot) {
  return h("li", { class: "slot" },
    h("span", { class: "slot-time" }, `${formatClock(slot.startSec)} to ${formatClock(slot.endSec)}`),
    h("span", { class: "slot-name" }, slotName(slot)),
    h("span", { class: "slot-detail hint" }, slotDetail(slot))
  );
}

function blockSections(workout) {
  const { slots, blocks } = workout;
  return blocks.map((block, i) => {
    const inBlock = slots.slice(block.firstSlot, block.lastSlot + 1);
    const prev = blocks[i - 1];
    const heading =
      block.kind === "warmup" ? "Warm-up"
      : block.kind === "circuit" ? `Circuit, ${block.rounds} rounds`
      : prev && prev.kind !== "straight" ? "Main set"
      : null;

    let body;
    if (block.kind === "circuit") {
      const rounds = [...new Set(inBlock.map((s) => s.round))];
      body = rounds.map((r) =>
        h("div", { class: "round" },
          h("h3", {}, `Round ${r}`),
          h("ol", { class: "slots" }, inBlock.filter((s) => s.round === r).map(slotRow))
        )
      );
    } else {
      body = h("ol", { class: "slots" }, inBlock.map(slotRow));
    }
    return h("section", { class: "block" }, heading && h("h2", {}, heading), body);
  });
}

export function renderPreview({ workout, onReroll, onBack }) {
  const moves = new Set(workout.slots.map((s) => s.exerciseId)).size;
  const total = workout.slots[workout.slots.length - 1].endSec;

  return h("main", { class: "screen" },
    h("header", { class: "top" },
      h("h1", {}, "Your workout"),
      h("p", { class: "summary" }, h("span", { class: "hero-value" }, formatClock(total)), h("span", { class: "hint" }, `${moves} moves`))
    ),
    workout.warnings.length > 0 &&
      h("div", { class: "notice", role: "status" }, workout.warnings.map((w) => h("p", {}, w))),
    h("div", { class: "panel" }, blockSections(workout)),
    h("p", { class: "note" }, "Starting a workout is the next piece to build."),
    h("div", { class: "bar two" },
      h("button", { type: "button", class: "btn secondary", onClick: onBack }, "Settings"),
      h("button", { type: "button", class: "btn primary", onClick: onReroll }, "Re-roll")
    )
  );
}
