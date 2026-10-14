// Shell layer: app state and screen switching. All workout logic lives in
// src/generator.js and src/settings.js; this file only wires them to the screens.

import { h } from "./dom.js";
import { loadStoredSettings, saveStoredSettings, loadStoredAudioPrefs, saveStoredAudioPrefs } from "./storage.js";
import * as audio from "./audio.js";
import { cuesFor, sanitizeAudioPrefs } from "../cues.js";
import { renderSettings } from "./settings-view.js";
import { renderPreview } from "./preview-view.js";
import { renderRunner } from "./runner-view.js";
import { renderDone } from "./done-view.js";
import { generateWorkout } from "../generator.js";
import { sanitize, buildOptions, randomizeAdvanced } from "../settings.js";

const root = document.getElementById("app");

const state = {
  library: null,
  settings: sanitize(loadStoredSettings()),
  audioPrefs: sanitizeAudioPrefs(loadStoredAudioPrefs()),
  workout: null,
  error: null,
  runner: null,
};

function show(el) {
  // The runner owns a timer and a listener, so it is torn down before any swap.
  state.runner?.destroy();
  state.runner = null;
  root.replaceChildren(el);
  window.scrollTo(0, 0);
}

function save() {
  saveStoredSettings(state.settings);
}

// Sound on/off, shared by the settings screen and the paused screen.
const sound = {
  isOn: () => !state.audioPrefs.muted,
  setOn: (on) => {
    state.audioPrefs = { ...state.audioPrefs, muted: !on };
    saveStoredAudioPrefs(state.audioPrefs);
  },
};

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
    sound,
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
    onStart: showRunner,
    onReroll: () => (generate() ? showPreview() : showSettings()),
    onBack: showSettings,
  }));
}

// Beeps (#11). src/cues.js decides which sound a tick's events earn; audio.js
// plays it. Wake lock (#13) will attach to these hooks too.
const runnerHooks = {
  onEvents(events, view) {
    const { sound: id } = cuesFor(events, { positionSec: view.positionSec, prefs: state.audioPrefs });
    if (id) audio.play(id);
  },
  onResume() {
    audio.resume(); // the Resume tap is a gesture, so iOS lets a suspended context restart
  },
};

function showRunner() {
  // Audio may only start inside a tap, and showRunner runs synchronously from
  // the Start tap, so the context is unlocked here and the start chirp confirms it.
  audio.unlock();
  if (!state.audioPrefs.muted) audio.play("chirp");
  const runner = renderRunner({
    workout: state.workout,
    library: state.library,
    hooks: runnerHooks,
    sound,
    onDone: showDone,
    onExit: showPreview,
  });
  show(runner.el);
  state.runner = runner;
}

function showDone() {
  show(renderDone({
    workout: state.workout,
    onNew: () => (generate() ? showPreview() : showSettings()),
    onSettings: showSettings,
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
