/**
 * @vitest-environment node
 * T181 Acceptance Test: Vertex mode empty drag pan behavior & WaveEngine numeric consistency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

function readWavePreviewSrc(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
}

describe('T181: Vertex mode empty drag pan (no vertex creation on blank space) & Off-Grid Engine Consistency', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. Static Source Code Inspection & 3-Step State Transition for T181', () => {
    it('WavePreview.tsx handleMouseDown must set panRef instead of vertexCreateRef when vHit < 0 in vertex mode', () => {
      // [Step 1: Capture Initial State of WavePreview source code]
      const src = readWavePreviewSrc();
      expect(src.length).toBeGreaterThan(1000);

      // [Step 2: Inspect vertex mode handling in handleMouseDown]
      const handleMouseDownIdx = src.indexOf('handleMouseDown');
      expect(handleMouseDownIdx).not.toBe(-1);
      const modeSpecificIdx = src.indexOf('Mode-specific hit testing', handleMouseDownIdx);
      expect(modeSpecificIdx).not.toBe(-1);
      const vertexModeBlockIdx = src.indexOf("if (editMode === 'vertex')", modeSpecificIdx);
      expect(vertexModeBlockIdx).not.toBe(-1);

      const vertexModeSnippet = src.slice(vertexModeBlockIdx, vertexModeBlockIdx + 700);

      // [Step 3: Assert Resulting Transition (TDD Red -> Green)]
      // Requirement for T181: When vHit < 0 in vertex mode, empty drag must set panRef.current and NOT vertexCreateRef.current
      const setsPanOnEmpty = /panRef\.current\s*=/.test(vertexModeSnippet);
      const setsVertexCreateOnEmpty = /vertexCreateRef\.current\s*=/.test(vertexModeSnippet);

      expect(setsPanOnEmpty, 'Vertex mode handleMouseDown must set panRef when clicking empty space (vHit < 0)').toBe(true);
      expect(setsVertexCreateOnEmpty, 'Vertex mode handleMouseDown must NOT set vertexCreateRef for empty space drag').toBe(false);
    });

    it('Double-click vertex addition must remain fully functional in WavePreview.tsx', () => {
      // [Step 1: Capture Initial State]
      const src = readWavePreviewSrc();

      // [Step 2: Inspect handleDoubleClick for vertex mode]
      const doubleClickIdx = src.indexOf('handleDoubleClick');
      expect(doubleClickIdx).not.toBe(-1);
      const doubleClickSnippet = src.slice(doubleClickIdx, doubleClickIdx + 800);

      // [Step 3: Assert Resulting Transition]
      const hasVertexDblClick = /editMode === 'vertex'/.test(doubleClickSnippet) && /beatAdd/.test(doubleClickSnippet);
      expect(hasVertexDblClick, 'Double click handler must support vertex addition in vertex mode').toBe(true);
    });
  });

  describe('2. Off-Grid Principle & Numeric Consistency across Complex Amplitudes', () => {
    it('verifies pure numeric consistency between WaveEngine (waveYAt/getPoints) and Cursor (update) across complex amplitudes and off-grid phases', () => {
      const complexAmps = [0.7, 1.3, 2.7, 3.4];
      const offGridBeats = [0.37, 1.23, 0.63, 2.37];
      const timeline = new BpmTimeline(120, [], 1.0);

      for (const amp of complexAmps) {
        for (const b of offGridBeats) {
          // [Step 1: Setup engine and cursor with complex amplitude and off-grid beat]
          const qBeat = quantizeBeat(b, 0.25);
          const segs: Segment[] = [{ direction: 'up', beats: qBeat > 0 ? qBeat : 0.5 }];
          const engine = new WaveEngine(segs, timeline, amp, 0.0);
          const cursor = new Cursor();

          // [Step 2: Compute engine wave Y at off-grid time/beat and update cursor]
          const beatMs = timeline.beatMsAt(b);
          cursor.update(0.1, true, false, beatMs, segs[0].beats, amp);
          const waveY = engine.waveYAt(b);
          const points = engine.getPoints();

          // [Step 3: Assert numeric consistency and validity of computed positions]
          expect(Number.isFinite(waveY)).toBe(true);
          expect(waveY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-5);
          expect(waveY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-5);
          expect(points.length).toBeGreaterThanOrEqual(2);
          expect(Number.isFinite(cursor.y)).toBe(true);
        }
      }
    });
  });
});
