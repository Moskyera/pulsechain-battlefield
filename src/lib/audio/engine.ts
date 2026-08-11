'use client';

/**
 * Synthesised battlefield audio.
 *
 * Every sound is generated with the Web Audio API — no asset downloads, no
 * licensing, nothing to 404. Each impact tier gets its own voice, so you can
 * hear a whale land without looking at the screen.
 *
 * Browsers require a user gesture before audio can start, so the context is
 * created lazily on the first `enable()` call (wired to the sound toggle).
 */

import type { UnitTier } from '../data/types';

/** Hard cap on simultaneous voices — a burst of trades must not clip or lag. */
const MAX_VOICES_PER_TICK = 6;
const VOICE_COOLDOWN_MS: Record<UnitTier, number> = {
  infantry: 45,
  tank: 90,
  artillery: 140,
  nuke: 0,
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastPlayedAt: Record<UnitTier, number> = {
    infantry: 0,
    tank: 0,
    artillery: 0,
    nuke: 0,
  };
  private voicesThisTick = 0;
  private tickStamp = 0;
  private enabled = false;

  get isEnabled(): boolean {
    return this.enabled && this.ctx !== null;
  }

  /** Must be called from a user gesture handler. */
  async enable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
      if (!this.ctx) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor();

        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -14;
        this.compressor.knee.value = 22;
        this.compressor.ratio.value = 12;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.22;

        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;

        this.master.connect(this.compressor);
        this.compressor.connect(this.ctx.destination);

        this.noiseBuffer = this.createNoiseBuffer(this.ctx);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.enabled = true;
      return true;
    } catch {
      return false;
    }
  }

  disable(): void {
    this.enabled = false;
    if (this.master && this.ctx) {
      // Fade out rather than cutting, so a decaying explosion doesn't click.
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => {
        if (!this.enabled && this.master) this.master.gain.value = 0.55;
        void this.ctx?.suspend();
      }, 250);
    }
  }

  setVolume(v: number): void {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * White noise, generated once and reused as the source for every percussive
   * layer. Deterministic content is irrelevant here — this is a sound texture,
   * not data — but it is generated once at startup rather than per shot.
   */
  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // A simple LCG keeps this reproducible and avoids Math.random entirely.
    let seed = 0x2f6e2b1;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 0x100000000) * 2 - 1;
    }
    return buffer;
  }

  private canPlay(tier: UnitTier): boolean {
    if (!this.enabled || !this.ctx || !this.master) return false;

    const now = performance.now();
    if (now - this.tickStamp > 100) {
      this.tickStamp = now;
      this.voicesThisTick = 0;
    }
    if (this.voicesThisTick >= MAX_VOICES_PER_TICK) return false;
    if (now - this.lastPlayedAt[tier] < VOICE_COOLDOWN_MS[tier]) return false;

    this.lastPlayedAt[tier] = now;
    this.voicesThisTick++;
    return true;
  }

  /** Play the impact voice for a tier. `intensity` scales with trade size. */
  impact(tier: UnitTier, intensity = 1): void {
    if (!this.canPlay(tier)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const amp = Math.max(0.2, Math.min(1.4, intensity));

    switch (tier) {
      case 'infantry':
        this.crack(t, 0.09 * amp);
        break;
      case 'tank':
        this.boom(t, { freq: 130, sweepTo: 42, dur: 0.42, gain: 0.32 * amp, noise: 0.2 });
        break;
      case 'artillery':
        this.boom(t, { freq: 90, sweepTo: 28, dur: 0.95, gain: 0.5 * amp, noise: 0.34 });
        break;
      case 'nuke':
        this.boom(t, { freq: 62, sweepTo: 16, dur: 2.4, gain: 0.85 * amp, noise: 0.5 });
        this.rumble(t + 0.06, 2.6, 0.42 * amp);
        break;
    }
  }

  /** Short high crack for small trades. */
  private crack(t: number, gain: number): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1900;
    hp.Q.value = 0.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

    src.connect(hp);
    hp.connect(g);
    g.connect(this.master!);
    src.start(t);
    src.stop(t + 0.12);
  }

  /** Pitch-swept sine body plus a noise transient — the classic explosion recipe. */
  private boom(
    t: number,
    opts: { freq: number; sweepTo: number; dur: number; gain: number; noise: number },
  ): void {
    const ctx = this.ctx!;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + opts.dur);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(opts.gain, t);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);

    osc.connect(oscGain);
    oscGain.connect(this.master!);
    osc.start(t);
    osc.stop(t + opts.dur + 0.05);

    if (this.noiseBuffer && opts.noise > 0) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2600, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + opts.dur * 0.7);

      const g = ctx.createGain();
      g.gain.setValueAtTime(opts.noise, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur * 0.8);

      src.connect(lp);
      lp.connect(g);
      g.connect(this.master!);
      src.start(t);
      src.stop(t + opts.dur + 0.05);
    }
  }

  /** Long sub-bass tail for nukes. */
  private rumble(t: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 110;
    lp.Q.value = 1.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.1);
  }

  /** Rising alarm when a nuke-tier trade is launched (not on impact). */
  incoming(): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.9);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 1.05);
  }
}

export const audio = new AudioEngine();
