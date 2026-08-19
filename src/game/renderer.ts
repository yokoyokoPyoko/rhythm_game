import type { BpmTimeline } from '../audio/bpmTimeline';
import type { RingState } from '../types';
import type { Cursor } from './cursor';
import type { ScoreManager } from './score';
import type { WaveEngine } from './waveEngine';

const TW_JUDGE_X = Math.round(800 * 0.26);
const TW_SCROLL = 110;

const BG = '#0a0a0a';
const ACCENT = '#6366f1';
const ACCENT_SUB = '#22d3ee';
const POSITIVE = '#4ade80';
const WARNING = '#fbbf24';
const TEXT = '#ededed';
const TEXT_MUTED = '#71717a';
const BORDER = 'rgba(255,255,255,0.08)';

const CURSOR_COLORS = [ACCENT, ACCENT_SUB, POSITIVE, WARNING];

const WAVE_MIN_X = 0;
const WAVE_MAX_X = 800;
const WAVE_SAMPLE_STEP = 4;

const RING_MAX_RADIUS = 64;
const RING_MIN_RADIUS = 14;
const RING_LINE_WIDTH = 2;

const CURSOR_RADIUS = 8;

const FONT_FAMILY = "'Inter', system-ui, sans-serif";

export interface RenderState {
  waveEngine: WaveEngine;
  cursor: Cursor;
  rings: RingState[];
  score: ScoreManager;
  songTimeMs: number;
  bpmTimeline: BpmTimeline;
}

export class Renderer {
  render(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const { waveEngine, cursor, rings, score, songTimeMs, bpmTimeline } = state;
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;

    this.drawBackground(ctx, width, height);
    this.drawJudgeLine(ctx, height);
    this.drawWave(ctx, waveEngine, songTimeMs, width);
    this.drawRings(ctx, rings, songTimeMs);
    this.drawCursor(ctx, cursor, score);
    this.drawHud(ctx, score, width, height, bpmTimeline, songTimeMs);
  }

  private drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
  }

  private drawJudgeLine(ctx: CanvasRenderingContext2D, height: number): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(TW_JUDGE_X, 0);
    ctx.lineTo(TW_JUDGE_X, height);
    ctx.stroke();
  }

  private drawWave(
    ctx: CanvasRenderingContext2D,
    waveEngine: WaveEngine,
    songTimeMs: number,
    width: number,
  ): void {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let x = WAVE_MIN_X; x <= Math.min(WAVE_MAX_X, width); x += WAVE_SAMPLE_STEP) {
      const t = songTimeMs + ((x - TW_JUDGE_X) / TW_SCROLL) * 1000;
      const y = waveEngine.waveYAtMs(t);
      if (x === WAVE_MIN_X) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  private drawRings(
    ctx: CanvasRenderingContext2D,
    rings: RingState[],
    songTimeMs: number,
  ): void {
    ctx.lineWidth = RING_LINE_WIDTH;
    for (const ring of rings) {
      if (ring.resolved) {
        continue;
      }
      const x = TW_JUDGE_X + ((ring.hitTime - songTimeMs) / 1000) * TW_SCROLL;
      const leadMs = ring.hitTime - ring.spawnTime;
      const progress = leadMs > 0 ? 1 - (ring.hitTime - songTimeMs) / leadMs : 1;
      const radius = Math.max(
        RING_MIN_RADIUS,
        RING_MAX_RADIUS - (RING_MAX_RADIUS - RING_MIN_RADIUS) * progress,
      );
      ctx.strokeStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(x, ring.targetY, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawCursor(
    ctx: CanvasRenderingContext2D,
    cursor: Cursor,
    score: ScoreManager,
  ): void {
    const tier = Math.min(3, Math.floor(score.getStats().combo / 10));
    const color = CURSOR_COLORS[tier];

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cursor.y);
    ctx.lineTo(ctx.canvas.width, cursor.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(TW_JUDGE_X, cursor.y, CURSOR_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = BG;
    ctx.beginPath();
    ctx.arc(TW_JUDGE_X, cursor.y, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(TW_JUDGE_X - CURSOR_RADIUS - 1, Math.max(0, cursor.y - 30), 2, 60);
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    score: ScoreManager,
    width: number,
    height: number,
    bpmTimeline: BpmTimeline,
    songTimeMs: number,
  ): void {
    const stats = score.getStats();

    ctx.textBaseline = 'top';

    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillText('SCORE', 16, 12);
    ctx.fillStyle = TEXT;
    ctx.font = `600 22px ${FONT_FAMILY}`;
    ctx.fillText(String(stats.score), 16, 28);

    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT;
    ctx.font = `600 28px ${FONT_FAMILY}`;
    ctx.fillText(String(stats.combo), width - 16, 14);
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillText('COMBO', width - 16, 46);

    const beat = bpmTimeline.msToBeat(songTimeMs);
    const beatLabel = Math.floor(beat) + 1;
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillText(`BEAT ${beatLabel}`, width - 16, height - 16);
  }
}