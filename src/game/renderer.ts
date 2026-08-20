import type { BpmTimeline } from '../audio/bpmTimeline';
import type { HitResult, RingState } from '../types';
import type { Cursor } from './cursor';
import type { ScoreManager } from './score';
import type { WaveEngine } from './waveEngine';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const TW_JUDGE_X = Math.round(800 * 0.26);
const TW_SCROLL = 110;
const FONT = "'Inter', system-ui, sans-serif";

const COLORS = {
  bg: '#0a0a0a',
  text: '#ededed',
  muted: '#71717a',
  border: 'rgba(255,255,255,0.08)',
  accent: '#6366f1',
  accentSub: '#22d3ee',
  positive: '#4ade80',
  warning: '#fbbf24',
  danger: '#f87171',
};

const TIER_COLORS = [COLORS.accent, COLORS.accentSub, COLORS.positive, COLORS.warning];

export interface JudgementEvent {
  result: HitResult;
  y: number;
  at: number;
}

export interface RenderParams {
  waveEngine: WaveEngine;
  cursor: Cursor;
  rings: RingState[];
  score: ScoreManager;
  songTimeMs: number;
  bpmTimeline: BpmTimeline;
  judgementEvents?: JudgementEvent[];
}

function safe(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function comboTier(combo: number): number {
  if (combo < 10) return 0;
  if (combo < 25) return 1;
  if (combo < 50) return 2;
  return 3;
}

function resultColor(result: HitResult): string {
  switch (result) {
    case 'perfect':
      return COLORS.positive;
    case 'good':
      return COLORS.accentSub;
    default:
      return COLORS.danger;
  }
}

export class Renderer {
  render(ctx: CanvasRenderingContext2D, params: RenderParams): void {
    const { waveEngine, cursor, rings, score, songTimeMs, bpmTimeline: _bpmTimeline } = params;

    this.drawBackground(ctx);
    this.drawJudgeLine(ctx);
    this.drawWave(ctx, waveEngine, songTimeMs);
    this.drawRings(ctx, rings, songTimeMs);
    this.drawCursor(ctx, cursor, score);
    this.drawHud(ctx, score);
    this.drawJudgements(ctx, params.judgementEvents ?? [], songTimeMs);
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  private drawJudgeLine(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(TW_JUDGE_X, 0);
    ctx.lineTo(TW_JUDGE_X, CANVAS_HEIGHT);
    ctx.stroke();
  }

  private drawWave(ctx: CanvasRenderingContext2D, waveEngine: WaveEngine, songTimeMs: number): void {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let x = 0; x <= CANVAS_WIDTH; x += 4) {
      const timeMs = songTimeMs + ((x - TW_JUDGE_X) / TW_SCROLL) * 1000;
      const y = safe(waveEngine.waveYAtMs(timeMs), CANVAS_HEIGHT / 2);
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    const judgeY = safe(waveEngine.waveYAtMs(songTimeMs), CANVAS_HEIGHT / 2);
    ctx.fillStyle = COLORS.muted;
    ctx.beginPath();
    ctx.arc(TW_JUDGE_X, judgeY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawRings(ctx: CanvasRenderingContext2D, rings: RingState[], songTimeMs: number): void {
    for (const ring of rings) {
      const x = TW_JUDGE_X + ((ring.hitTime - songTimeMs) / 1000) * TW_SCROLL;
      if (x < -80 || x > CANVAS_WIDTH + 80) {
        continue;
      }
      const leadMs = safe(ring.hitTime - ring.spawnTime, 1);
      const progress = Math.max(0, Math.min(1, (ring.hitTime - songTimeMs) / leadMs));
      const radius = 14 + 50 * progress;

      ctx.strokeStyle = ring.hit ? COLORS.positive : COLORS.text;
      ctx.globalAlpha = ring.resolved && !ring.hit ? 0.25 : 1;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, safe(ring.targetY, CANVAS_HEIGHT / 2), radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D, cursor: Cursor, score: ScoreManager): void {
    const y = safe(cursor.y, CANVAS_HEIGHT / 2);
    const color = TIER_COLORS[comboTier(score.getStats().combo)];

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(TW_JUDGE_X, y, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(TW_JUDGE_X - 24, y);
    ctx.lineTo(TW_JUDGE_X + 24, y);
    ctx.stroke();
  }

  private drawHud(ctx: CanvasRenderingContext2D, score: ScoreManager): void {
    const stats = score.getStats();

    ctx.fillStyle = COLORS.text;
    ctx.font = `600 28px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(stats.score), 16, 16);

    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText('SCORE', 16, 48);

    if (stats.combo > 1) {
      ctx.fillStyle = COLORS.text;
      ctx.font = `700 48px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${stats.combo}`, TW_JUDGE_X, 60);
      ctx.fillStyle = COLORS.muted;
      ctx.font = `500 14px ${FONT}`;
      ctx.fillText('COMBO', TW_JUDGE_X, 92);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  private drawJudgements(
    ctx: CanvasRenderingContext2D,
    events: JudgementEvent[],
    songTimeMs: number,
  ): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 22px ${FONT}`;
    for (const e of events) {
      const age = songTimeMs - e.at;
      if (age < 0) continue;
      const alpha = Math.max(0, 1 - age / 700);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = resultColor(e.result);
      const label =
        e.result === 'perfect' ? 'PERFECT!' : e.result === 'good' ? 'GOOD' : 'MISS';
      ctx.fillText(label, TW_JUDGE_X, safe(e.y, CANVAS_HEIGHT / 2) - 40 - age * 0.03);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}
