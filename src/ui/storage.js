// Shell layer: localStorage, always inside try/catch (private windows, blocked
// storage and quota errors must never break the app).

const KEY = "core-roulette.settings.v1";

export function loadStoredSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveStoredSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not saving is fine; the app works without it.
  }
}
