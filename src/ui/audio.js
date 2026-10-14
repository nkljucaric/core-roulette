// Shell layer: plays the tones that src/cues.js asks for (#11). It decides
// nothing about which sound fits which moment.
//
// iPhone notes (the recipe that passed the M0 spike):
//  - navigator.audioSession.type = "ambient" lets the beeps layer over Spotify
//    instead of pausing it. Feature-detected and in try/catch.
//  - One AudioContext for the whole app, created inside the Start tap (iOS only
//    allows audio after a user gesture) and resumed if iOS suspends it.
//  - Nothing here may throw: no audio support means silence, and the on-screen
//    countdown and colors carry the workout.

import { toneFor } from "../cues.js";

let ctx = null;

function setAmbient() {
  try {
    if ("audioSession" in navigator) navigator.audioSession.type = "ambient";
  } catch {
    // Not supported; the beeps still play.
  }
}

// Call synchronously from a tap (the Start button).
export function unlock() {
  try {
    setAmbient();
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
    if (ctx.state !== "running") ctx.resume();
  } catch {
    ctx = null;
  }
}

// Call from a tap too (the Resume button): iOS may have suspended the context
// while the page was hidden.
export function resume() {
  try {
    setAmbient();
    if (ctx && ctx.state !== "running") ctx.resume();
  } catch {
    // Ignore; the next play() tries again.
  }
}

export function play(soundId) {
  try {
    const tone = toneFor(soundId);
    if (!tone || !ctx) return;
    if (ctx.state !== "running") ctx.resume();
    const t0 = ctx.currentTime;
    for (const note of tone.notes) {
      const start = t0 + note.startSec;
      const end = start + note.durSec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      // Quick attack, hold, quick release: no clicks, and long beeps stay level.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.01);
      gain.gain.setValueAtTime(note.gain, Math.max(start + 0.01, end - 0.04));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    // Silence is acceptable; never break the workout over a beep.
  }
}
