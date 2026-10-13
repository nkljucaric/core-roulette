// Shell layer: app state and screen switching. All workout logic lives in
// src/generator.js and src/settings.js; this file only wires them to the screens.

import { h } from "./dom.js";
import { loadStoredSettings, saveStoredSettings } from "./storage.js";
import { renderSettings } from "./settings-view.js";
import { renderPreview } from "./preview-view.js";
import { generateWorkout } from "../generator.js";
import { sanitize, buildOptions, randomizeAdvanced } from "../settings.js";

const root = document.getElementById("app");

const state = {
  library: null,
  settings: sanitize(loadStoredSettings()),
  workout: null,
  error: null,
};

function show(el) {
  root.replaceChildren(el);
  window.scrollTo(0, 0);
}

function save() {
  saveStoredSettings(state.settings);
}

// Always built from the user's settings, never from a previous workout's
// resolved options, so unset values (Quick Start) re-randomize on every call.
function generate() {
  try {
    state.workout = generateWorkout(state.library, buildOptions(state.settings), Math.random);
    state.error = null;
    return true;
  } catch (err) {
    state.workout = null;
    state.error = err instanceof Error && err.message.startsWith("No exercises match")
      ? "No moves match those filters. Remove a filter or lower the difficulty."
      : "Couldn't build a workout. Change a setting and try again.";
    return false;
  }
}

function showSettings() {
  show(renderSettings({
    settings: state.settings,
    error: state.error,
    onChange: save,
    onModeChange: () => { state.error = null; showSettings(); },
    onRandomize: () => {
      state.settings.advanced = randomizeAdvanced(state.settings.advanced, Math.random);
      state.error = null;
      save();
      showSettings();
    },
    onGenerate: () => (generate() ? showPreview() : showSettings()),
  }));
}

function showPreview() {
  show(renderPreview({
    workout: state.workout,
    onReroll: () => (generate() ? showPreview() : showSettings()),
    onBack: showSettings,
  }));
}

async function start() {
  try {
    const res = await fetch("./exercises.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.library = await res.json();
  } catch {
    show(h("main", { class: "screen" },
      h("h1", {}, "Core Roulette"),
      h("p", { class: "error" }, "Couldn't load the exercise list. Check your connection and reload."),
      h("div", { class: "bar" }, h("button", { type: "button", class: "btn primary", onClick: () => location.reload() }, "Reload"))
    ));
    return;
  }
  showSettings();
}

start();
