// Logic layer (see CLAUDE.md): pure functions only. No DOM, no audio, no clock.
//
// Decides WHICH sound a batch of timer events earns and WHAT that sound is, so
// the Shell (src/ui/audio.js) only plays notes (#11).
//
//   cuesFor(events, { positionSec, prefs }) -> { sound, dropped }
//   toneFor(soundId)                        -> { notes, totalSec } | null
//   sanitizeAudioPrefs(stored)              -> { muted }
//
// Sound plan (Nick's spec): in a work interval, two quick beeps ("double") at
// 10 s to go, a "short" beep at 3 and at 2, and a "long" beep at 1. Rest and
// get-ready get only the "long" beep at 1. Nothing sounds on the transition
// itself. "finish" is a rising four-note jingle on the `done` event. "chirp" is
// played by the Shell on the Start tap, never from events.

export const STALE_AFTER_SEC = 1.5;
export const DEFAULT_AUDIO_PREFS = Object.freeze({ muted: false });

export function sanitizeAudioPrefs(stored) {
  const muted = stored !== null && typeof stored === "object" && !Array.isArray(stored) && typeof stored.muted === "boolean"
    ? stored.muted
    : DEFAULT_AUDIO_PREFS.muted;
  return { muted };
}

// Higher wins when one tick returns several fresh sounds.
const PRIORITY = { finish: 4, long: 3, double: 2, short: 1 };

function soundOf(event) {
  if (event.type === "done") return "finish";
  if (event.type === "warning") return "double";
  if (event.type === "countdown") {
    if (event.n === 1) return "long";
    if ((event.n === 2 || event.n === 3) && event.phase === "work") return "short";
  }
  return null;
}

export function cuesFor(events, { positionSec, prefs } = {}) {
  if (!events || events.length === 0 || prefs?.muted) return { sound: null, dropped: 0 };

  let best = null;
  let fresh = 0;
  let dropped = 0;
  for (const event of events) {
    const sound = soundOf(event);
    if (sound === null) continue;
    if (positionSec - event.at > STALE_AFTER_SEC) {
      dropped++;
      continue;
    }
    fresh++;
    if (!best || PRIORITY[sound] > PRIORITY[best.sound] || (PRIORITY[sound] === PRIORITY[best.sound] && event.at >= best.at)) {
      best = { sound, at: event.at };
    }
  }
  // Fresh sounds that lost to the winner are dropped too.
  if (best) dropped += fresh - 1;
  return { sound: best ? best.sound : null, dropped };
}

const BEEP = 880;
const HEADS_UP = 660;
const TONES = {
  short: [{ freq: BEEP, startSec: 0, durSec: 0.15, gain: 0.45 }],
  long: [{ freq: BEEP, startSec: 0, durSec: 0.5, gain: 0.45 }],
  double: [
    { freq: HEADS_UP, startSec: 0, durSec: 0.1, gain: 0.45 },
    { freq: HEADS_UP, startSec: 0.18, durSec: 0.1, gain: 0.45 },
  ],
  // C major arpeggio, C5 E5 G5 C6; the last note rings out (`decay`).
  finish: [
    { freq: 523.25, startSec: 0, durSec: 0.16, gain: 0.4 },
    { freq: 659.25, startSec: 0.16, durSec: 0.16, gain: 0.4 },
    { freq: 783.99, startSec: 0.32, durSec: 0.16, gain: 0.4 },
    { freq: 1046.5, startSec: 0.48, durSec: 0.7, gain: 0.4, decay: true },
  ],
  chirp: [
    { freq: 523, startSec: 0, durSec: 0.1, gain: 0.4 },
    { freq: 784, startSec: 0.12, durSec: 0.12, gain: 0.4 },
  ],
};

export function toneFor(soundId) {
  if (!Object.hasOwn(TONES, soundId)) return null;
  const notes = TONES[soundId].map((n) => ({ ...n }));
  return { notes, totalSec: Math.max(...notes.map((n) => n.startSec + n.durSec)) };
}
