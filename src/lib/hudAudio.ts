"use client";

export const AUDIO_MUTED_STORAGE_KEY = "hunt-audio-muted-v1";

function readPersistedMute(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem(AUDIO_MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Interface sound hooks. Every cue is silent by design, so no AudioContext is
 * ever opened: a live context would hold an audio output for nothing.
 */
class HudSoundEngine {
  private _muted: boolean | null = null;

  get muted(): boolean {
    if (this._muted === null) {
      this._muted = readPersistedMute();
    }
    return this._muted;
  }

  set muted(value: boolean) {
    this._muted = Boolean(value);
    if (typeof window !== "undefined") {
      try {
        window.localStorage?.setItem(
          AUDIO_MUTED_STORAGE_KEY,
          this._muted ? "1" : "0"
        );
      } catch {
        // Storage unavailable or full: in-memory state still updates.
      }
    }
  }

  /** Re-reads persisted state (useful after storage changes or in tests). */
  syncFromStorage(): boolean {
    this._muted = readPersistedMute();
    return this._muted;
  }

  playLockOn() {
    // Silent by design: taps and focus transitions have no synthetic click/chime audio.
  }

  playClick() {
    // Silent by design: navigation and button taps have no click audio.
  }

  playComplete() {
    // Silent by design: completion feedback is purely visual.
  }
}

export const hudAudio = new HudSoundEngine();
