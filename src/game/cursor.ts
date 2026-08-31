import { TW_AMP, TW_CENTER_Y } from './waveEngine';

function sanitizeStartPosition(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

export class Cursor {
  y: number;
  private readonly amplitude: number;

  constructor(amplitude = 1.0, startPosition = 0) {
    this.amplitude = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0;
    const sp = sanitizeStartPosition(startPosition);
    this.y = TW_CENTER_Y - sp * TW_AMP;
  }

  update(dt: number, upPressed: boolean, downPressed: boolean, beatMs: number, _segmentBeats = 1): void {
    const waveTop = TW_CENTER_Y - TW_AMP;
    const waveBottom = TW_CENTER_Y + TW_AMP;
    // T123/T124: amplitude is speed coefficient (inverse of required beats for full traverse)
    // Physical height fixed at TW_AMP; speed scales with amplitude — height invariant.
    const speed = (2 * TW_AMP * this.amplitude) / (beatMs / 1000);
    let delta = 0;
    if (upPressed) delta -= speed;
    if (downPressed) delta += speed;
    this.y = Math.max(waveTop, Math.min(waveBottom, this.y + delta * dt));
  }

  /**
   * T119: Wave attraction assist — called at 1-beat boundary crossing.
   * Pulls cursor toward wave target Y by factor (0.0-1.0).
   */
  pullTowards(targetY: number, factor = 0.28): void {
    if (!Number.isFinite(targetY) || !Number.isFinite(factor)) return;
    const f = Math.max(0, Math.min(1, factor));
    if (f === 0) return;
    const waveTop = TW_CENTER_Y - TW_AMP;
    const waveBottom = TW_CENTER_Y + TW_AMP;
    const clampedTarget = Math.max(waveTop, Math.min(waveBottom, targetY));
    this.y = Math.max(waveTop, Math.min(waveBottom, this.y + (clampedTarget - this.y) * f));
  }
}