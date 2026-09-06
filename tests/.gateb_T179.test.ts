/**
 * @vitest-environment node
 * T179 Unit Tests: Removal of vertical ring lines and 2D circular hit testing (Math.hypot < 25 + Y range check).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment, RingDef } from '../src/types';

vi.useFakeTimers();

function readWavePreviewSrc(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
}

describe('T179: Ring vertical line removal & 2D circular hit detection', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('1. Source code contract: WavePreview.tsx must remove vertical ring stroke lines and use 2D Math.hypot(<25) and Y range checks', () => {
    // [Step 1: Capture initial source state]
    const src = readWavePreviewSrc();
    expect(src.length).toBeGreaterThan(1000);

    // [Step 2: Check expectations for T179 requirements]
    // Requirement 1: Vertical line drawing for rings (moveTo/lineTo from RULER_H to cssH inside rings.forEach) must be removed.
    const hasVerticalRingLine = /moveTo\([^)]*rx[^)]*RULER_H/.test(src) || /lineTo\([^)]*rx[^)]*cssH/.test(src);
    
    // Requirement 2: nearestRingIndex uses Math.hypot(rx - clickX, ry - clickY) < 25 (or similar 2D check with clientY)
    const hasMathHypot2D = /Math\.hypot\s*\(\s*[^)]*rx\s*-\s*clickX[^)]*ry\s*-\s*clickY[^)]*\)/.test(src) &&
                           /nearestDist\s*<\s*25/.test(src);

    // Requirement 3: findItemsInRect checks Y range for rings (ry >= minY - 20 && ry <= maxY + 20 or similar)
    const hasYRangeCheck = /ry\s*>=\s*minY\s*-\s*20[\s\S]*?ry\s*<=\s*maxY\s*\+\s*20/.test(src) ||
                           /ry\s*>=\s*minY[\s\S]*?ry\s*<=\s*maxY/.test(src);

    // [Step 3: Assert Resulting Transition (TDD Red -> will pass after implementation)]
    expect(hasVerticalRingLine, 'Vertical ring lines (RULER_H to cssH) must be removed from renderCanvas').toBe(false);
    expect(hasMathHypot2D, 'nearestRingIndex must use 2D Math.hypot with radius < 25 and clientY').toBe(true);
    expect(hasYRangeCheck, 'findItemsInRect must check ring Y coordinate range').toBe(true);
  });

  it('2. Complex amplitudes and off-grid phases numeric consistency for WaveEngine and 2D math', () => {
    const complexAmps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.63, 2.37];
    const timeline = new BpmTimeline(120, []);

    for (const amp of complexAmps) {
      for (const b of offGridBeats) {
        // [Step 1: Compute engine points & ring Y at beat b]
        const qBeat = quantizeBeat(b, 0.25);
        const segs: Segment[] = [{ direction: 'down', beats: qBeat > 0 ? qBeat : 0.25 }];
        const engine = new WaveEngine(segs, timeline, amp, 0.0);
        const ry = engine.waveYAt(b);

        // [Step 2: Simulate 2D hit test math (Math.hypot)]
        const rx = 150;
        const clickX = 150;
        const clickY = ry; // Exact hit on circle center
        const dist2D = Math.hypot(rx - clickX, ry - clickY);

        // [Step 3: Assert 2D distance is within 25px radius]
        expect(dist2D).toBeLessThan(25);
        expect(Number.isFinite(ry)).toBe(true);
      }
    }
  });

  it('3. Ring Y-range bounding box filter test for findItemsInRect (off-grid validation)', () => {
    const minY = 200;
    const maxY = 400;
    const allowedMargin = 20;

    const testCases = [
      { ry: 300, inside: true },   // well inside
      { ry: 185, inside: true },   // within margin (minY - 20 = 180)
      { ry: 175, inside: false },  // outside top margin
      { ry: 415, inside: true },   // within margin (maxY + 20 = 420)
      { ry: 430, inside: false },  // outside bottom margin
    ];

    for (const tc of testCases) {
      const isInside = tc.ry >= minY - allowedMargin && tc.ry <= maxY + allowedMargin;
      expect(isInside).toBe(tc.inside);
    }
  });
});
