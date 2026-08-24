const TW_CENTER_Y = 600 / 2;

import { WAVELENGTH_BEATS } from './waveEngine';

export class Cursor {
  y: number;
  private readonly amplitude: number;

  constructor(amplitude = 130) {
    this.amplitude = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 130;
    this.y = TW_CENTER_Y - this.amplitude;
  }

  update(dt: number, upPressed: boolean, downPressed: boolean, beatMs: number, _segmentBeats = 1): void {
    const waveTop = TW_CENTER_Y - this.amplitude;
    const waveBottom = TW_CENTER_Y + this.amplitude;
    const speed = (2 * this.amplitude) / (WAVELENGTH_BEATS * (beatMs / 1000));
    let delta = 0;
    if (upPressed) delta -= speed;
    if (downPressed) delta += speed;
    this.y = Math.max(waveTop, Math.min(waveBottom, this.y + delta * dt));
  }
}