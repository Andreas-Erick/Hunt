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
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playLockOn() {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(1040, now + 0.09);
    osc.frequency.setValueAtTime(1380, now + 0.1);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  playClick() {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.045);

    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  playComplete() {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const freqs = [587.33, 880, 1174.66]; // D5, A5, D6 chord arpeggio
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      const start = now + idx * 0.055;
      osc.frequency.setValueAtTime(f, start);

      gain.gain.setValueAtTime(0.07, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.28);
    });
  }
}

export const hudAudio = new HudSoundEngine();
