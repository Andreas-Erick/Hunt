"use client";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export const AUDIO_MUTED_STORAGE_KEY = "hunt-audio-muted-v1";

function readPersistedMute(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem(AUDIO_MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

class HudSoundEngine {
  private ctx: AudioContext | null = null;
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

  private getContext(): AudioContext | null {
    if (typeof window === "undefined" || this.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** Deterministically closes the underlying AudioContext when shutting down. */
  async dispose(): Promise<void> {
    const current = this.ctx;
    this.ctx = null;
    if (current && typeof current.close === "function") {
      try {
        await current.close();
      } catch {
        // Ignore already-closed context errors.
      }
    }
  }

  playLockOn() {
    // Silent by design: taps and focus transitions have no synthetic click/chime audio.
  }

  playClick() {
    // Keep lazy AudioContext lifecycle intact for deterministic dispose(), without audible tones.
    void this.getContext();
  }

  playComplete() {
    // Silent by design: completion feedback is purely visual.
  }
}

export const hudAudio = new HudSoundEngine();
