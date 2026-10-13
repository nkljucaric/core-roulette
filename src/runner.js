// Logic layer (see CLAUDE.md): pure functions only. No DOM, no audio, no clock.
//
// Turns a timer view (src/timer.js) into the labels the runner screen shows
// (#10), so the Shell only draws and never decides.
//
//   describeRunner(view, workout, library) ->
//     { phase, phaseLabel, paused, phaseRemainingSec, totalRemainingSec,
//       progress, title, sideLabel, sectionLabel, formCue, upNext }
//
// The "shown" move is the one the title, side, section and form cue describe:
// the current move while working, and the upcoming move during get-ready and
// rest, so the user can get into position. Nothing is shown when done.
// `upNext` exists only while working; during rest the shown move already is
// the next one, so repeating it would be noise.

const PHASE_LABEL = { ready: "GET READY", work: "WORK", rest: "REST", done: "DONE" };
const SIDE_LABEL = { left: "Left side", right: "Right side", alternate: "Alternate sides" };

function shownSlot(view) {
  if (view.phase === "work") return view.slot ?? null;
  if (view.phase === "ready" || view.phase === "rest") return view.next ?? null;
  return null;
}

function sectionLabelOf(slot, workout) {
  if (!slot) return null;
  if (slot.section === "warmup") return "Warm-up";
  const block = workout.blocks?.find((b) => b.id === slot.blockId);
  if (block && block.kind === "circuit") return `Circuit, round ${slot.round} of ${block.rounds}`;
  return null;
}

function upNextOf(view) {
  if (view.phase !== "work") return null;
  if (view.nextIsSideSwap) return { kind: "side-swap", text: "Switch to right side" };
  if (view.next) return { kind: "move", text: view.next.name };
  return { kind: "last", text: "Last move" };
}

export function describeRunner(view, workout, library) {
  const slot = shownSlot(view);
  const total = workout.slots[workout.slots.length - 1].endSec;
  const progress = view.phase === "done" ? 1 : Math.min(1, Math.max(0, view.elapsedSec / total));
  const cue = slot ? library?.find((e) => e.id === slot.exerciseId)?.formCue : null;

  return {
    phase: view.phase,
    phaseLabel: PHASE_LABEL[view.phase],
    paused: view.status === "paused",
    phaseRemainingSec: view.phaseRemainingSec,
    totalRemainingSec: view.totalRemainingSec,
    progress,
    title: slot ? slot.name : null,
    sideLabel: slot ? SIDE_LABEL[slot.side] ?? null : null,
    sectionLabel: sectionLabelOf(slot, workout),
    formCue: cue ? cue : null,
    upNext: upNextOf(view),
  };
}
