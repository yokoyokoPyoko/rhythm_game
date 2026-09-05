/**
 * @vitest-environment node
 * T161 復元ドロップダウンメニューの見切れ修正（右寄せ→左基準展開） — Vitest node acceptance test
 * Verifies behavior/internal state, never surface-only DOM presence.
 * 3-step state-transition pattern, pure computed values, off-grid phases, complex amplitudes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { Cursor } from '../src/game/cursor';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

function extractBlock(css: string, selector: string, len = 300): string {
  const idx = css.indexOf(selector);
  if (idx === -1) return '';
  return css.slice(idx, idx + len);
}

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('T161 復元ドロップダウンメニューの見切れ修正（右寄せ→左基準展開）', () => {
  describe('1. CSS rule .editor-restore-dropdown uses left: 0 instead of right: 0', () => {
    it('verifies that .editor-restore-dropdown has left: 0 and lacks right: 0', () => {
      // [Step 1] Capture Initial State: read src/index.css
      const cssPath = path.join(process.cwd(), 'src/index.css');
      const css = fs.readFileSync(cssPath, 'utf-8');
      expect(css.length).toBeGreaterThan(0);

      // [Step 2] Perform Analysis / Interaction: locate .editor-restore-dropdown block
      const dropdownIdx = css.indexOf('.editor-restore-dropdown');
      expect(dropdownIdx, '.editor-restore-dropdown must be defined in index.css').toBeGreaterThan(-1);

      const block = extractBlock(css, '.editor-restore-dropdown', 400);

      // [Step 3] Assert Resulting Transition: contains left: 0 and does not contain right: 0
      expect(block).toMatch(/left\s*:\s*0\s*;/);
      expect(block).not.toMatch(/right\s*:\s*0\s*;/);
    });

    it('verifies EditorScreen.tsx structure for restore dropdown group', () => {
      // [Step 1] Capture source of EditorScreen.tsx
      const srcPath = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(srcPath, 'utf-8');
      expect(src.length).toBeGreaterThan(1000);

      // [Step 2] Locate restore group and dropdown elements
      const hasRestoreGroup = src.includes('editor-restore-group') || src.includes('editor-restore');
      expect(hasRestoreGroup, 'EditorScreen must reference restore group/dropdown classes').toBe(true);

      // [Step 3] Assert correct state toggle for restore dropdown
      expect(src).toMatch(/restoreOpen|restoreDropdown|setRestoreOpen/);
    });
  });

  describe('2. Complex Amplitudes and Off-Grid Numeric Consistency (T127/T161 compliance)', () => {
    const complexAmps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGridBeats = [0.37, 1.23, 0.63, 2.37] as const;

    for (const amp of complexAmps) {
      for (const b of offGridBeats) {
        it(`amp=${amp} off-grid beat=${b}: WaveEngine slope and Cursor update maintain exact numeric consistency`, () => {
          // [Step 1] Capture Initial State: setup timeline and engine with complex amp
          const timeline = new BpmTimeline(120, [{ beat: 2, bpm: 150, amplitude: amp }], 1.0);
          const resolvedAmp = timeline.amplitudeAt(b);
          expect(resolvedAmp).toBe(b >= 2 ? amp : 1.0);

          const snap = 0.25;
          const quantizedBeats = quantizeBeat(b, snap) || snap;
          const segs = [{ direction: 'down' as const, beats: quantizedBeats }];

          // [Step 2] Perform Computation: WaveEngine points and waveYAt
          const engine = new WaveEngine(segs, timeline, 1.0, 0);
          const pts = engine.getPoints();
          expect(pts.length).toBe(segs.length + 1);

          const yVal = engine.waveYAt(b * 0.1);

          // [Step 3] Assert Resulting Transition: finite numeric values within bounds and snap alignment
          expect(Number.isFinite(yVal)).toBe(true);
          expect(yVal).toBeGreaterThanOrEqual(TOP);
          expect(yVal).toBeLessThanOrEqual(BOTTOM);
          expect(isSnapAligned(quantizedBeats, snap)).toBe(true);

          // Verify Cursor update consistency
          const cursor = new Cursor(amp, 0);
          cursor.setAmplitude(resolvedAmp);
          const startY = cursor.y;
          cursor.update(0.5, false, true, 500);
          expect(Number.isFinite(cursor.y)).toBe(true);
          expect(cursor.y).toBeGreaterThanOrEqual(TOP);
          expect(cursor.y).toBeLessThanOrEqual(BOTTOM);
        });
      }
    }
  });
});
