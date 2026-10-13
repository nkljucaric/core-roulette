// Logic layer (see CLAUDE.md): pure functions only. No DOM, no audio, and no
// clock reads: the current time (`nowMs`) is always passed in.
//
// Timestamp-based timer engine for a workout produced by generateWorkout (#9).
// Nothing counts ticks: elapsed time is always computed from `nowMs` minus a
// stored anchor, so the result is correct however the page was throttled.
//
//   plan  = buildPlan(workout, { leadInSec })
//   state = start(plan, nowMs)
//   { state, view, events } = tick(plan, state, nowMs)   // call as often as you like
//   state = pause(state, nowMs) / resume(state, nowMs)
//
// Workout time is in seconds and 0 is the instant the first move starts. The
// lead-in ("get ready") is negative time, so it does not count in the total.
// Internally the state uses integer milliseconds so ceil() never meets
// floating-point fuzz; treat `state` as opaque apart from `state.status`.
//
// Events are reported exactly once: the state stores a cursor (the latest time
// already reported) and each tick returns the events in (cursor, elapsed]. After
// a long throttle a tick returns every missed event; the Shell decides which are
// still worth sounding (see #11).
//
// Event types: ready, work-start, side-swap (replaces work-start at the
// left-to-right boundary of a two-sided move), rest-start, countdown (n = 3, 2, 1
// for the phase that is ending), done.

const MS = 1000;
const toMs = (sec) => Math.round(sec * MS);

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const EVENT_RANK = { ready: 0, "work-start": 0, "side-swap": 0, "rest-start": 0, countdown: 1, done: 2 };

function buildEvents(slots, segments, durationSec) {
  const events = [];
  for (const seg of segments) {
    if (seg.phase === "ready") {
      events.push({ type: "ready", at: seg.startSec, slotIndex: null, nextSlotIndex: 0 });
    } else if (seg.phase === "work") {
      const slot = slots[seg.slotIndex];
      events.push({
        type: slot.side === "right" ? "side-swap" : "work-start",
        at: seg.startSec,
        slotIndex: seg.slotIndex,
        side: slot.side,
      });
    } else {
      events.push({
        type: "rest-start",
        at: seg.startSec,
        slotIndex: seg.slotIndex,
        nextSlotIndex: seg.slotIndex + 1,
      });
    }
    // Countdown events fire when the displayed number flips to n, and only
    // strictly inside the phase so a short phase never beeps on its own start.
    for (const n of [3, 2, 1]) {
      const at = seg.endSec - n;
      if (at > seg.startSec) {
        events.push({ type: "countdown", at, n, phase: seg.phase, slotIndex: seg.slotIndex });
      }
    }
  }
  events.push({ type: "done", at: durationSec, slotIndex: slots.length - 1 });

  // Ordered by time; on a tie start events, then countdowns, then done.
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || EVENT_RANK[a.e.type] - EVENT_RANK[b.e.type] || a.i - b.i)
    .map((x) => x.e);
}

export function buildPlan(workout, { leadInSec = 5 } = {}) {
  const slots = workout?.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new RangeError("The workout has no slots to time.");
  }
  if (!Number.isFinite(leadInSec) || leadInSec < 0) {
    throw new RangeError("leadInSec must be a non-negative number.");
  }

  const segments = [];
  if (leadInSec > 0) segments.push({ phase: "ready", startSec: -leadInSec, endSec: 0, slotIndex: null });
  slots.forEach((slot, i) => {
    segments.push({ phase: "work", startSec: slot.startSec, endSec: slot.endSec, slotIndex: i });
    const next = slots[i + 1];
    // A rest runs to the next slot's start, so zero-length rests (between the
    // two sides of a move, and after the last slot) produce no segment.
    if (next && next.startSec > slot.endSec) {
      segments.push({ phase: "rest", startSec: slot.endSec, endSec: next.startSec, slotIndex: i });
    }
  });

  const durationSec = slots[slots.length - 1].endSec;
  return { leadInSec, durationSec, slots, segments, events: buildEvents(slots, segments, durationSec) };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function elapsedMsOf(state, nowMs) {
  if (state.status === "paused") return state.baseMs;
  return state.baseMs + Math.max(0, nowMs - state.anchorMs);
}

export function start(plan, nowMs) {
  return { status: "running", baseMs: -toMs(plan.leadInSec), anchorMs: nowMs, cursorMs: null };
}

export function pause(state, nowMs) {
  if (state.status === "paused") return { ...state };
  return { ...state, status: "paused", baseMs: elapsedMsOf(state, nowMs), anchorMs: nowMs };
}

export function resume(state, nowMs) {
  if (state.status === "running") return { ...state };
  return { ...state, status: "running", anchorMs: nowMs };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function eventsInMs(plan, fromMs, toMsValue) {
  return plan.events.filter((e) => {
    const atMs = toMs(e.at);
    return atMs > fromMs && atMs <= toMsValue;
  });
}

// Events with fromSec < at <= toSec, in order. Use -Infinity for an open start.
export function eventsBetween(plan, fromSec, toSec) {
  if (!(toSec > fromSec)) return [];
  const from = fromSec === -Infinity ? -Infinity : toMs(fromSec);
  const to = toSec === Infinity ? Infinity : toMs(toSec);
  return eventsInMs(plan, from, to);
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function buildView(plan, state, elapsedMs) {
  const { slots, segments, durationSec } = plan;
  const endMs = toMs(durationSec);
  const last = slots[slots.length - 1];

  if (elapsedMs >= endMs) {
    return {
      status: "done",
      phase: "done",
      slotIndex: slots.length - 1,
      slot: last,
      side: last.side,
      phaseRemainingSec: 0,
      phaseDurationSec: 0,
      totalRemainingSec: 0,
      elapsedSec: durationSec,
      next: null,
      nextIsSideSwap: false,
    };
  }

  // Segments are half-open [start, end): the next segment applies at the boundary.
  let seg = segments[0];
  for (const s of segments) {
    if (toMs(s.startSec) <= elapsedMs) seg = s;
    else break;
  }

  const slot = seg.slotIndex === null ? null : slots[seg.slotIndex];
  const next = seg.phase === "ready" ? slots[0] : slots[seg.slotIndex + 1] ?? null;
  return {
    status: state.status,
    phase: seg.phase,
    slotIndex: seg.slotIndex,
    slot,
    side: slot ? slot.side : null,
    phaseRemainingSec: Math.ceil((toMs(seg.endSec) - elapsedMs) / MS),
    phaseDurationSec: seg.endSec - seg.startSec,
    totalRemainingSec: Math.ceil((endMs - Math.max(0, elapsedMs)) / MS),
    elapsedSec: Math.min(durationSec, Math.max(0, elapsedMs / MS)),
    next,
    nextIsSideSwap: Boolean(slot && next && next.side === "right" && next.exerciseId === slot.exerciseId),
  };
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export function tick(plan, state, nowMs) {
  const startMs = -toMs(plan.leadInSec);
  const endMs = toMs(plan.durationSec);
  const elapsedMs = Math.min(endMs, Math.max(startMs, elapsedMsOf(state, nowMs)));

  const cursorMs = state.cursorMs ?? -Infinity;
  const events = elapsedMs > cursorMs ? eventsInMs(plan, cursorMs, elapsedMs) : [];

  return {
    state: { ...state, cursorMs: Math.max(cursorMs, elapsedMs) },
    view: buildView(plan, state, elapsedMs),
    events,
  };
}
