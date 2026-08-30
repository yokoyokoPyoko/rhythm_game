const TW_CENTER_Y = 600 / 2;
const NORM_TO_PX = 130;

import { WAVELENGTH_BEATS } from './waveEngine';

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
    this.y = TW_CENTER_Y - sp * this.amplitude * NORM_TO_PX;
  }

  update(dt: number, upPressed: boolean, downPressed: boolean, beatMs: number, _segmentBeats = 1): void {
    const waveTop = TW_CENTER_Y - this.amplitude * NORM_TO_PX;
    const waveBottom = TW_CENTER_Y + this.amplitude * NORM_TO_PX;
    const speedNorm = (2 * this.amplitude) / WAVELENGTH_BEATS;
    const speed = (speedNorm * NORM_TO_PX) / (beatMs / 1000);
    let delta = 0;
    if (upPressed) delta -= speed;
    if (downPressed) delta += speed;
    this.y = Math.max(waveTop, Math.min(waveBottom, this.y + delta * dt));
  }
}