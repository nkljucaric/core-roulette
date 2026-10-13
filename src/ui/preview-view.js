// Shell layer: the preview screen (#20). Draws the model from src/preview.js;
// it makes no decisions about the workout itself.

import { h, formatClock } from "./dom.js";
import { buildPreview } from "../preview.js";

function moveDetail(move) {
  const work = `${move.workSeconds} s`;
  if (move.sides === "each") return `${work} each side`;
  if (move.sides === "alternate") return `${work}, alternate sides`;
  return `${work} work`;
}

function moveRow(move) {
  return h("li", { class: "slot" },
    h("span", { class: "slot-time" }, `${formatClock(move.startSec)} to ${formatClock(move.endSec)}`),
    h("span", { class: "slot-name" }, move.name),
    h("span", { class: "slot-detail hint" },
      moveDetail(move),
      move.longSeconds && h("span", { class: "tag" },
        move.sides === "each" ? `right side runs ${formatClock(move.longSeconds)}` : `runs ${formatClock(move.longSeconds)}`)
    )
  );
}

// Every move is followed by the same quiet rest line, so the list reads the
// same whatever the rest length (and still works if rest becomes optional).
function restRow(rest) {
  return h("li", { class: "rest", "aria-label": `Rest ${rest.seconds} seconds` },
    h("span", { class: "slot-time" }, formatClock(rest.startSec)),
    h("span", { class: "rest-line" }, `Rest ${rest.seconds} s`)
  );
}

function itemRows(items) {
  return h("ol", { class: "slots" }, items.map((it) => (it.type === "move" ? moveRow(it) : restRow(it))));
}

function circuitSection(section) {
  const footer = [`Repeats ${section.rounds} times, ends ${formatClock(section.endSec)}`];
  if (section.finalLong) {
    footer.push(`The very last move (${section.finalLong.name}) runs ${formatClock(section.finalLong.longSeconds)}`);
  }
  return h("section", { class: "block" },
    h("div", { class: "circuit" },
      h("div", { class: "circuit-head" },
        h("h2", {}, "Circuit"),
        h("span", { class: "badge", "aria-label": `${section.rounds} rounds` }, `x${section.rounds}`)
      ),
      itemRows(section.items),
      h("p", { class: "circuit-foot hint" }, footer.join(". "))
    )
  );
}

function plainSection(section) {
  return h("section", { class: "block" },
    section.heading && h("h2", {}, section.heading),
    itemRows(section.items)
  );
}

export function renderPreview({ workout, onStart, onReroll, onBack }) {
  const p = buildPreview(workout);

  return h("main", { class: "screen tall-bar" },
    h("header", { class: "top" },
      h("h1", {}, "Your workout"),
      h("p", { class: "summary" },
        h("span", { class: "hero-value" }, formatClock(p.totalSec)),
        h("span", { class: "hint" }, `${p.moveCount} moves`)
      ),
      h("p", { class: "hint" }, `${p.workSeconds} s work, ${p.restSeconds} s rest`)
    ),
    p.warnings.length > 0 &&
      h("div", { class: "notice", role: "status" }, p.warnings.map((w) => h("p", {}, w))),
    h("div", { class: "panel" }, p.sections.map((s) => (s.kind === "circuit" ? circuitSection(s) : plainSection(s)))),
    h("div", { class: "bar" },
      h("button", { type: "button", class: "btn primary", onClick: onStart }, "Start"),
      h("div", { class: "bar-row" },
        h("button", { type: "button", class: "btn secondary", onClick: onBack }, "Settings"),
        h("button", { type: "button", class: "btn secondary", onClick: onReroll }, "Re-roll")
      )
    )
  );
}
