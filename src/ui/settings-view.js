// Shell layer: the settings screen (Quick Start and Advanced). It edits the
// settings object in place and tells the app when something changed; turning
// those settings into workout options is src/settings.js, not this file.

import { h, uid, formatClock } from "./dom.js";
import { LIMITS, POSITIONS, FOCUSES } from "../settings.js";

const POSITION_LABELS = { back: "Back", "face-down": "Face down", side: "Side", standing: "Standing" };
const FOCUS_LABELS = {
  "upper-abs": "Upper abs",
  "lower-abs": "Lower abs",
  obliques: "Obliques",
  "deep-core": "Deep core",
  full: "Full core",
};

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function segmented({ label, options, get, set }) {
  const buttons = options.map((opt) =>
    h("button", {
      type: "button",
      class: "seg-btn",
      "aria-pressed": String(get() === opt.value),
      onClick: () => {
        set(opt.value);
        for (const [i, b] of buttons.entries()) b.setAttribute("aria-pressed", String(options[i].value === get()));
      },
    }, opt.label)
  );
  return h("div", { class: "seg", role: "group", "aria-label": label }, buttons);
}

function slider({ label, limits, get, set, format, hero = false, onChange }) {
  const id = uid("slider");
  const valueEl = h("output", { class: hero ? "hero-value" : "row-value", for: id }, format(get()));
  const input = h("input", { id, type: "range", min: limits.min, max: limits.max, step: limits.step });
  input.value = get();
  input.addEventListener("input", () => {
    set(Number(input.value));
    valueEl.textContent = format(get());
    onChange();
  });
  return h("div", { class: hero ? "control hero" : "control" },
    hero
      ? [h("label", { class: "hero-label", for: id }, label), valueEl]
      : h("div", { class: "row" }, h("label", { for: id }, label), valueEl),
    input
  );
}

function switchRow({ label, hint, get, set, onToggle }) {
  const knob = h("span", { class: "knob", "aria-hidden": "true" });
  const btn = h("button", { type: "button", class: "switch-row", role: "switch", "aria-checked": String(get()) },
    h("span", { class: "switch-text" }, h("span", { class: "switch-label" }, label), hint && h("span", { class: "hint" }, hint)),
    knob
  );
  btn.addEventListener("click", () => {
    set(!get());
    btn.setAttribute("aria-checked", String(get()));
    onToggle();
  });
  return btn;
}

function filterGroup({ title, values, labels, filter, onChange }) {
  const summary = h("p", { class: "hint filter-summary" });
  const describe = () => {
    const names = filter.values.map((v) => labels[v]);
    summary.textContent = names.length === 0
      ? "No filter. Every move is in play."
      : filter.mode === "none" ? `Everything except: ${names.join(", ")}` : `Only: ${names.join(", ")}`;
  };
  const chips = values.map((v) =>
    h("button", {
      type: "button",
      class: "chip",
      "aria-pressed": String(filter.values.includes(v)),
      onClick: (e) => {
        const i = filter.values.indexOf(v);
        if (i >= 0) filter.values.splice(i, 1);
        else filter.values.push(v);
        e.currentTarget.setAttribute("aria-pressed", String(i < 0));
        describe();
        onChange();
      },
    }, labels[v])
  );
  describe();
  const mode = segmented({
    label: `${title} filter mode`,
    options: [{ value: "any", label: "Only these" }, { value: "none", label: "All except" }],
    get: () => filter.mode,
    set: (v) => { filter.mode = v; describe(); onChange(); },
  });
  return h("section", { class: "group" },
    h("div", { class: "row" }, h("h2", {}, title), mode),
    h("div", { class: "chips" }, chips),
    summary
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const seconds = (n) => `${n} s`;

function quickPanel(q, onChange) {
  return h("div", { class: "panel" },
    slider({ label: "Workout length", limits: LIMITS.totalSeconds, get: () => q.totalSeconds, set: (v) => (q.totalSeconds = v), format: formatClock, hero: true, onChange }),
    h("section", { class: "group" },
      h("h2", {}, "Difficulty"),
      segmented({
        label: "Difficulty",
        options: [{ value: "easy", label: "Easy" }, { value: "medium", label: "Medium" }, { value: "hard", label: "Hard" }],
        get: () => q.difficulty,
        set: (v) => { q.difficulty = v; onChange(); },
      }),
      h("p", { class: "hint" }, "Hard can include any move, easy ones too.")
    ),
    switchRow({ label: "Warm-up", hint: "Two easy moves, counted in your time.", get: () => q.warmup, set: (v) => (q.warmup = v), onToggle: onChange }),
    h("p", { class: "note" }, "Work time, rest time and circuits are picked for you.")
  );
}

function advancedPanel(a, { onChange, onRandomize }) {
  const countsRow = switchRow({
    label: "Count warm-up in total time",
    get: () => a.warmup.countsInTotal,
    set: (v) => (a.warmup.countsInTotal = v),
    onToggle: onChange,
  });
  countsRow.hidden = !a.warmup.enabled;

  return h("div", { class: "panel" },
    h("button", { type: "button", class: "btn secondary", onClick: onRandomize }, "Randomize"),
    slider({ label: "Workout length", limits: LIMITS.totalSeconds, get: () => a.totalSeconds, set: (v) => (a.totalSeconds = v), format: formatClock, hero: true, onChange }),
    slider({ label: "Work", limits: LIMITS.workSeconds, get: () => a.workSeconds, set: (v) => (a.workSeconds = v), format: seconds, onChange }),
    slider({ label: "Rest", limits: LIMITS.restSeconds, get: () => a.restSeconds, set: (v) => (a.restSeconds = v), format: seconds, onChange }),
    switchRow({
      label: "Warm-up",
      hint: "Two easy moves before the workout.",
      get: () => a.warmup.enabled,
      set: (v) => (a.warmup.enabled = v),
      onToggle: () => { countsRow.hidden = !a.warmup.enabled; onChange(); },
    }),
    countsRow,
    filterGroup({ title: "Body position", values: POSITIONS, labels: POSITION_LABELS, filter: a.position, onChange }),
    filterGroup({ title: "Focus", values: FOCUSES, labels: FOCUS_LABELS, filter: a.focus, onChange }),
    switchRow({ label: "Include a circuit", hint: "A few moves repeated for a few rounds.", get: () => a.circuit, set: (v) => (a.circuit = v), onToggle: onChange })
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

// settings is edited in place. onChange() saves; onModeChange(), onRandomize()
// and onGenerate() ask the app to re-render or move on. `sound` is { isOn(), setOn(v) }:
// the audio preference lives outside the workout settings.
export function renderSettings({ settings, sound, error, onChange, onModeChange, onRandomize, onGenerate }) {
  const mode = segmented({
    label: "Workout type",
    options: [{ value: "quick", label: "Quick Start" }, { value: "advanced", label: "Advanced" }],
    get: () => settings.mode,
    set: (v) => { settings.mode = v; onChange(); onModeChange(); },
  });
  mode.classList.add("mode");

  const panel = settings.mode === "quick"
    ? quickPanel(settings.quick, onChange)
    : advancedPanel(settings.advanced, { onChange, onRandomize });

  panel.append(switchRow({
    label: "Sound",
    hint: "Beeps during the workout.",
    get: () => sound.isOn(),
    set: (v) => sound.setOn(v),
    onToggle: () => {},
  }));

  return h("main", { class: "screen" },
    h("header", { class: "top" }, h("h1", {}, "Core Roulette"), mode),
    panel,
    h("div", { class: "bar" },
      error && h("p", { class: "error", role: "alert" }, error),
      h("button", { type: "button", class: "btn primary", onClick: onGenerate }, "Generate workout")
    )
  );
}
