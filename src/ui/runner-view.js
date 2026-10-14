// Shell layer: the runner screen (#10). Draws what src/runner.js describes and
// drives src/timer.js. It counts nothing itself: every tick asks the timer for
// the view at Date.now(), so a throttled page just catches up on the next tick.
//
// Hooks for later issues (all optional):
//   onEvents(events, view)  timer events from each tick (beeps, #11)
//   onPause() / onResume()  wake lock, audio (#11, #13)
//   onFinish(reason)        "done" or "exited"
//
// renderRunner returns { el, destroy }. The caller must call destroy() before
// swapping the screen away, which clears the interval and the listener.

import { h, formatClock } from "./dom.js";
import { buildPlan, start, pause, resume, tick } from "../timer.js";
import { describeRunner } from "../runner.js";

const TICK_MS = 100;

export function renderRunner({ workout, library, hooks = {}, onDone, onExit, now = () => Date.now() }) {
  const plan = buildPlan(workout);
  let state = start(plan, now());
  let timerId = null;
  let finished = false;
  let confirming = false;
  let last = null;

  // --- DOM (built once; ticks only change text and attributes) ---
  const clockEl = h("div", { class: "r-clock", "aria-hidden": "true" });
  const fillEl = h("div", { class: "r-fill" });
  const barEl = h("div", { class: "r-bar", role: "progressbar", "aria-label": "Workout progress", "aria-valuemin": 0, "aria-valuemax": 100 }, fillEl);
  const totalEl = h("span", { class: "r-total" });
  const sideEl = h("span", { class: "r-side" });
  const titleEl = h("h1", { class: "r-title" });
  const cueEl = h("p", { class: "r-cue" });
  const nextCaptionEl = h("span", { class: "r-next-caption" }, "Up next");
  const nextTextEl = h("span", { class: "r-next-text" });
  const nextEl = h("div", { class: "r-next" }, nextCaptionEl, nextTextEl);
  const liveEl = h("p", { class: "sr-only", role: "status" });

  const pauseBtn = h("button", { type: "button", class: "btn r-pause", onClick: doPause }, "Pause");

  const resumeBtn = h("button", { type: "button", class: "btn primary", onClick: doResume }, "Resume");
  const endBtn = h("button", { type: "button", class: "btn secondary", onClick: () => { confirming = true; renderOverlay(); } }, "End workout");
  const confirmText = h("p", { class: "r-confirm-text" }, "End this workout?");
  const yesBtn = h("button", { type: "button", class: "btn primary", onClick: doExit }, "Yes, end it");
  const keepBtn = h("button", { type: "button", class: "btn secondary", onClick: () => { confirming = false; renderOverlay(); } }, "Keep going");
  const overlayBody = h("div", { class: "r-overlay-body" });
  const overlay = h("div", { class: "r-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Paused", hidden: true },
    h("p", { class: "r-paused-label" }, "Paused"),
    overlayBody
  );

  const el = h("main", { class: "runner", "data-phase": "ready" },
    h("div", { class: "r-move" }, sideEl, titleEl, cueEl),
    clockEl,
    h("div", { class: "r-progress" }, barEl, totalEl),
    nextEl,
    h("div", { class: "r-actions" }, pauseBtn),
    overlay,
    liveEl
  );

  // --- Rendering ---
  function setText(node, text) {
    const t = text ?? "";
    if (node.textContent !== t) node.textContent = t;
  }

  function render(d) {
    el.dataset.phase = d.phase;
    el.classList.toggle("is-paused", d.paused);
    setText(clockEl, formatClock(d.phaseRemainingSec));
    fillEl.style.transform = `scaleX(${d.progress.toFixed(4)})`;
    barEl.setAttribute("aria-valuenow", String(Math.round(d.progress * 100)));
    setText(totalEl, `${formatClock(d.totalRemainingSec)} left`);
    setText(sideEl, d.sideLabel);
    sideEl.hidden = !d.sideLabel;
    setText(titleEl, d.title);
    setText(cueEl, d.formCue);
    cueEl.hidden = !d.formCue;
    nextEl.style.visibility = d.upNext ? "visible" : "hidden"; // keeps its space so the clock does not jump between phases
    if (d.upNext) {
      setText(nextTextEl, d.upNext.text);
      nextCaptionEl.hidden = d.upNext.kind !== "move";
    }
    pauseBtn.disabled = d.paused;
    // Announce phase changes only (not every second) for screen readers.
    const announce = `${d.phaseLabel}${d.title ? `: ${d.title}` : ""}`;
    if (!last || last.phase !== d.phase || last.title !== d.title) setText(liveEl, announce);
  }

  function renderOverlay() {
    overlayBody.replaceChildren(
      ...(confirming ? [confirmText, yesBtn, keepBtn] : [resumeBtn, endBtn])
    );
  }

  // --- Loop ---
  function step() {
    const result = tick(plan, state, now());
    state = result.state;
    if (result.events.length > 0) hooks.onEvents?.(result.events, result.view);
    const d = describeRunner(result.view, workout, library);
    render(d);
    last = d;
    if (result.view.status === "done" && !finished) {
      finished = true;
      stop();
      hooks.onFinish?.("done");
      onDone?.();
    }
  }

  function stop() {
    if (timerId !== null) clearInterval(timerId);
    timerId = null;
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function doPause() {
    if (finished || state.status === "paused") return;
    state = pause(state, now());
    confirming = false;
    renderOverlay();
    overlay.hidden = false;
    step();
    hooks.onPause?.();
    resumeBtn.focus();
  }

  function doResume() {
    if (finished || state.status !== "paused") return;
    state = resume(state, now());
    overlay.hidden = true;
    confirming = false;
    step();
    hooks.onResume?.();
  }

  function doExit() {
    if (finished) return;
    finished = true;
    stop();
    hooks.onFinish?.("exited");
    onExit?.();
  }

  // The page going hidden pauses; the user taps Resume when they're back.
  function onVisibility() {
    if (document.hidden) doPause();
  }

  document.addEventListener("visibilitychange", onVisibility);
  step();
  timerId = setInterval(step, TICK_MS);

  return {
    el,
    destroy() {
      finished = true;
      stop();
    },
  };
}
