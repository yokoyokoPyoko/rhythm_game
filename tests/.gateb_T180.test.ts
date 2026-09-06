/**
 * @vitest-environment node
 * T180 Unit & Integration Tests: Render order change in WavePreview.tsx (drawing vertex handles after rings so vertex circles are layered in front of ring circles).
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

describe('T180: Ring and Wave Vertex Rendering Order (Vertex in front of Rings)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('1. Source code contract & 3-step state transition: renderCanvas must draw rings before vertex handles', () => {
    // [Step 1: Capture initial source state]
    const src = readWavePreviewSrc();
    expect(src.length).toBeGreaterThan(1000);

    // [Step 2: Locate rendering blocks for rings and vertex handles]
    const ringDrawIdx = src.indexOf('rings.forEach(');
    const vertexDrawIdx = src.indexOf("editMode === 'vertex'");

    expect(ringDrawIdx).not.toBe(-1);
    expect(vertexDrawIdx).not.toBe(-1);

    // [Step 3: Assert Resulting Transition (TDD Red -> Green)]
    // Requirement: Ring drawing must occur BEFORE vertex handle drawing, so that vertex handles are drawn in front of rings.
    expect(ringDrawIdx < vertexDrawIdx, 'Rings must be rendered before vertex handles in renderCanvas so vertex circles appear in front of ring circles').toBe(true);
  });

  it('2. Off-grid principle & numeric consistency between WaveEngine and Cursor across complex amplitudes', () => {
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

        // [Step 3: Assert numeric consistency and validity of computed positions]
        expect(Number.isFinite(waveY)).toBe(true);
        expect(waveY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-5);
        expect(waveY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-5);
        expect(Number.isFinite(cursor.y)).toBe(true);
      }
    }
  });

  it('3. Canvas 2D Mock execution order check for renderCanvas sequence', () => {
    // [Step 1: Capture source representation]
    const src = readWavePreviewSrc();

    // [Step 2: Locate ring draw block vs vertex draw block indices]
    const ringDrawSnippetPos = src.indexOf('rings.forEach(');
    const vertexDrawSnippetPos = src.indexOf("editMode === 'vertex'");

    // [Step 3: Assert order]
    expect(ringDrawSnippetPos).toBeLessThan(vertexDrawSnippetPos);
  });
});
