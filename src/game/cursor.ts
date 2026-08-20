const TW_CENTER_Y = 600 / 2;
const TW_AMP = 80;

const WAVE_TOP = TW_CENTER_Y - TW_AMP;
const WAVE_BOTTOM = TW_CENTER_Y + TW_AMP;

export class Cursor {
  y: number;

  constructor() {
    this.y = WAVE_TOP;
  }

  update(dt: number, upPressed: boolean, downPressed: boolean, beatMs: number, segmentBeats = 1): void {
    const beats = segmentBeats > 0 ? segmentBeats : 1;
    const speed = (2 * TW_AMP) / (beats * (beatMs / 1000));
    let delta = 0;
    if (upPressed) delta -= speed;
    if (downPressed) delta += speed;
    this.y = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, this.y + delta * dt));
  }
}