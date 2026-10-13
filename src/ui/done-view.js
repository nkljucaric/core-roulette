// Shell layer: the screen shown when a workout finishes (#10).

import { h, formatClock } from "./dom.js";

export function renderDone({ workout, onNew, onSettings }) {
  const total = workout.slots[workout.slots.length - 1].endSec;
  const moves = new Set(workout.slots.map((s) => s.exerciseId)).size;

  return h("main", { class: "screen" },
    h("header", { class: "top" },
      h("h1", {}, "Done"),
      h("p", { class: "summary" },
        h("span", { class: "hero-value" }, formatClock(total)),
        h("span", { class: "hint" }, `${moves} moves`)
      )
    ),
    h("div", { class: "bar" },
      h("button", { type: "button", class: "btn primary", onClick: onNew }, "New workout"),
      h("button", { type: "button", class: "btn secondary", onClick: onSettings }, "Back to settings")
    )
  );
}
