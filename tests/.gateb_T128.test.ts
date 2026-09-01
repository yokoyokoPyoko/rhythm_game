import { describe, it, expect, vi } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { segmentize } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const TIMELINE_120 = new BpmTimeline(120, []);
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;
const CENTER = TW_CENTER_Y;

function clampY(y: number): number {
  return Math.max(TOP, Math.min(BOTTOM, y));
}

// Expected waveYAt for single-segment from given startPosition using dY spec
function expectedClampedY(startPosition: number, amp: number, direction: 'up' | 'down' | 'stay', beat: number): number {
  const startY = TW_CENTER_Y - startPosition * TW_AMP;
  const dY = direction === 'up' ? -2 * TW_AMP * amp : direction === 'down' ? 2 * TW_AMP * amp : 0;
  if (direction === 'stay') return startY;
  return clampY(startY + dY * beat);
}

describe('T128 波形のクリップ時傾斜崩壊の修正 — acceptance (Red before fix)', () => {
  // ------------------------------------------------------------
  // 1) クランプ区間の途中拍で Y = cursor移動量 (amp=1.0 down beats=3)
  // ------------------------------------------------------------
  describe('1. clipped single segment tilt — amp=1.0 down beats=3 startPosition=0', () => {
    const amp = 1.0;
    const segments: Segment[] = [{ direction: 'down', beats: 3 }];
    // beats to sample — includes spec example 0.25/0.5/1.0/1.5/2.0 and off-grid 0.37/1.23
    const samples = [0.25, 0.37, 0.5, 1.0, 1.23, 1.5, 2.0, 2.5, 3.0];

    it.each(samples)('beat=%s waveYAt equals clamp(CENTER+2*TW_AMP*amp*beat)', (beat) => {
      const engine = new WaveEngine(segments, TIMELINE_120, amp, 0);
      const actual = engine.waveYAt(beat);
      const expected = expectedClampedY(0, amp, 'down', beat);
      // Strict: must reach bottom already at 0.5 (steep slope), NOT 43px/beat slow drift
      expect(actual).toBeCloseTo(expected, 1);
    });

    it('spec example: cursor speed reaches bottom at beat 0.5, waveYAt must match', () => {
      const engine = new WaveEngine(segments, TIMELINE_120, 1.0, 0);
      // cursor slope = 260px/beat -> 0.5 beat => 130px -> bottom
      expect(engine.waveYAt(0.5)).toBeCloseTo(BOTTOM, 1);
      // buggy would be center+21.7 at 0.5
      expect(engine.waveYAt(0.5)).not.toBeCloseTo(CENTER + (BOTTOM - CENTER) * (0.5 / 3), 0);
      // after reaching border, stays flat
      expect(engine.waveYAt(1.0)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(2.0)).toBeCloseTo(BOTTOM, 1);
    });

    it('slope in clipped interval must be 2*TW_AMP*amp, not diluted to (realDelta/fullBeats)', () => {
      const engine = new WaveEngine(segments, TIMELINE_120, amp, 0);
      // slope between 0 and 0.25 should be 260, not 43.3
      const dy = engine.waveYAt(0.25) - engine.waveYAt(0);
      const slope = dy / 0.25;
      expect(slope).toBeCloseTo(2 * TW_AMP * amp, 0);
      // slope after border (0.5->1.0) must be 0 (horizontal stay), not continued drift
      const dy2 = engine.waveYAt(1.0) - engine.waveYAt(0.5);
      expect(dy2).toBeCloseTo(0, 0);
    });
  });

  // ------------------------------------------------------------
  // 2) 複雑な振幅＋オフグリッド位相での数値一致
  // ------------------------------------------------------------
  describe('2. complex amplitudes + off-grid phases', () => {
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7, 3.4];
    const offGrid = [0.37, 1.23, 0.25, 0.5, 1.5, 2.0];
    const directions: Array<'up' | 'down'> = ['down', 'up'];

    for (const amp of amps) {
      for (const dir of directions) {
        it(`amp=${amp} dir=${dir} off-grid consistency (stay clip aware)`, () => {
          const segs: Segment[] = [{ direction: dir, beats: 5 }];
          const engine = new WaveEngine(segs, TIMELINE_120, amp, 0);
          for (const b of offGrid) {
            const actual = engine.waveYAt(b);
            const expected = expectedClampedY(0, amp, dir, b);
            expect(actual, `amp=${amp} dir=${dir} beat=${b}`).toBeCloseTo(expected, 1);
          }
        });
      }
    }

    it('amp=0.7 and amp=2.7 clipped points differ correctly (higher amp reaches border sooner)', () => {
      const segsDown3: Segment[] = [{ direction: 'down', beats: 3 }];
      const e07 = new WaveEngine(segsDown3, TIMELINE_120, 0.7, 0);
      const e27 = new WaveEngine(segsDown3, TIMELINE_120, 2.7, 0);
      // 0.7: slope 182 -> reach bottom at 130/182=0.714 beats, so at 0.37 not yet clipped, at 1.0 clipped
      expect(e07.waveYAt(0.37)).toBeCloseTo(clampY(CENTER + 2 * TW_AMP * 0.7 * 0.37), 1);
      expect(e07.waveYAt(1.0)).toBeCloseTo(BOTTOM, 1);
      // 2.7: slope 702 -> reach bottom at 0.185 beats, so even 0.37 already bottom
      expect(e27.waveYAt(0.37)).toBeCloseTo(BOTTOM, 1);
      expect(e27.waveYAt(0.25)).toBeCloseTo(BOTTOM, 1);
      // buggy would NOT be at bottom for 2.7 at 0.37 (would be ~center+ 260*2.7*0.37/5 etc)
    });
  });

  // ------------------------------------------------------------
  // 3) cursor と waveEngine の数値整合 (T127 注意: 複雑な振幅で直接比較)
  // ------------------------------------------------------------
  describe('3. Cursor vs WaveEngine numeric consistency (same 2*TW_AMP*amplitude)', () => {
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7];
    const beatMs = 500; // 120 BPM

    for (const amp of amps) {
      it(`amp=${amp} slope matches cursor physical speed`, () => {
        const segs: Segment[] = [{ direction: 'down', beats: 10 }];
        const engine = new WaveEngine(segs, TIMELINE_120, amp, 0);
        // wave slope before clipping: (waveYAt(delta)-waveYAt(0))/delta == 2*TW_AMP*amp
        // choose delta small enough to not clip: 0.1 beats -> 26*amp < 130 for amp<5
        const delta = 0.1;
        const dyWave = engine.waveYAt(delta) - engine.waveYAt(0);
        const slopeWave = dyWave / delta;
        expect(slopeWave).toBeCloseTo(2 * TW_AMP * amp, 0);

        // cursor displacement in same physical time: dt = delta * beatMs/1000
        const dt = (delta * beatMs) / 1000;
        const cursor = new Cursor(amp, 0);
        const y0 = cursor.y;
        cursor.update(dt, false, true, beatMs, 1);
        const dyCursor = cursor.y - y0;
        const slopeCursor = dyCursor / delta;
        // both slopes must be equal and must NOT be slow
        expect(slopeCursor).toBeCloseTo(2 * TW_AMP * amp, 0);
        expect(slopeWave).toBeCloseTo(slopeCursor, 0);
      });
    }

    it('up direction slope is negative but magnitude matches cursor', () => {
      const amp = 1.3;
      const engine = new WaveEngine([{ direction: 'up', beats: 10 }], TIMELINE_120, amp, 0);
      const delta = 0.37;
      // start at center, up goes toward TOP. For amp=1.3, 0.37 beats => delta 2*130*1.3*0.37=124.5 -> not clipped yet
      const dy = engine.waveYAt(delta) - engine.waveYAt(0);
      expect(dy).toBeCloseTo(-2 * TW_AMP * amp * delta, 0);
      // cursor up
      const beatMsLocal = 500;
      const cursor = new Cursor(amp, 0);
      const y0 = cursor.y;
      cursor.update((delta * beatMsLocal) / 1000, true, false, beatMsLocal, 1);
      expect(cursor.y - y0).toBeCloseTo(dy, 0);
    });

    it('off-grid phase 0.37 / 1.23 slope still matches cursor (off-grid verification principle)', () => {
      const amp = 2.7;
      // use stay+down to test multi? Use single long segment so 0.37 is before clip for this amp? For 2.7 it is after clip -> expect flat
      // Choose amp 0.5 where 0.37 and 1.23 are before/after clip boundaries respectively
      const engine05 = new WaveEngine([{ direction: 'down', beats: 10 }], TIMELINE_120, 0.5, 0);
      // before clip: slope 130 -> dy 0.37*130=48.1
      expect(engine05.waveYAt(0.37) - engine05.waveYAt(0)).toBeCloseTo(2 * TW_AMP * 0.5 * 0.37, 1);
      // 1.23 -> still before bottom? 1.23*130=159.9 -> clamped to 130, so at 1.0 already bottom, 1.23 is flat
      expect(engine05.waveYAt(1.23)).toBeCloseTo(BOTTOM, 1);
      expect(engine05.waveYAt(1.0)).toBeCloseTo(BOTTOM, 1);
      // between 1.0 and 1.23 slope 0
      expect(engine05.waveYAt(1.23) - engine05.waveYAt(1.0)).toBeCloseTo(0, 1);
    });

    it('maximum never faster than physical speed — slope never exceeds 2*TW_AMP*amp (slow-side bug only)', () => {
      // For any beat window, |slope| <= 2*TW_AMP*amp
      const amp = 1.0;
      const engine = new WaveEngine([{ direction: 'down', beats: 3 }], TIMELINE_120, amp, 0);
      const samples = [0, 0.1, 0.25, 0.37, 0.5, 1.0, 1.23, 2.0];
      for (let i = 1; i < samples.length; i++) {
        const b0 = samples[i - 1];
        const b1 = samples[i];
        const slope = Math.abs((engine.waveYAt(b1) - engine.waveYAt(b0)) / (b1 - b0));
        expect(slope).toBeLessThanOrEqual(2 * TW_AMP * amp + 1e-6);
        // also never slower than spec when not clipped: first interval must be exactly max
        if (b1 <= 0.5) {
          // before clip, must be exactly max (not 43 slow)
          expect(slope).toBeCloseTo(2 * TW_AMP * amp, 0);
        }
      }
    });
  });

  // ------------------------------------------------------------
  // 4) startPosition !=0 / stay / 方向反転・多セグメント
  // ------------------------------------------------------------
  describe('4. startPosition, stay, multi-segment reversal', () => {
    it('startPosition=0 waveYAt(0)=CENTER, 1.0=>TOP, -1.0=>BOTTOM', () => {
      const eCenter = new WaveEngine([{ direction: 'down', beats: 1 }], TIMELINE_120, 1.0, 0.0);
      expect(eCenter.waveYAt(0)).toBeCloseTo(CENTER, 1);
      const eTop = new WaveEngine([{ direction: 'down', beats: 1 }], TIMELINE_120, 1.0, 1.0);
      expect(eTop.waveYAt(0)).toBeCloseTo(TOP, 1);
      const eBottom = new WaveEngine([{ direction: 'up', beats: 1 }], TIMELINE_120, 1.0, -1.0);
      expect(eBottom.waveYAt(0)).toBeCloseTo(BOTTOM, 1);
    });

    it('startPosition=1.0 (top) down amp=1.0 clipped after 1.0 beat (full span)', () => {
      // top -> bottom needs 260px /260 =1 beat
      const engine = new WaveEngine([{ direction: 'down', beats: 3 }], TIMELINE_120, 1.0, 1.0);
      expect(engine.waveYAt(0)).toBeCloseTo(TOP, 1);
      expect(engine.waveYAt(0.5)).toBeCloseTo(TOP + 2 * TW_AMP * 1.0 * 0.5, 1); // 130
      expect(engine.waveYAt(1.0)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(1.5)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(3.0)).toBeCloseTo(BOTTOM, 1);
    });

    it('startPosition=-1.0 (bottom) up amp=1.0 symmetric', () => {
      const engine = new WaveEngine([{ direction: 'up', beats: 3 }], TIMELINE_120, 1.0, -1.0);
      expect(engine.waveYAt(0)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(0.5)).toBeCloseTo(BOTTOM - 2 * TW_AMP * 1.0 * 0.5, 1);
      expect(engine.waveYAt(1.0)).toBeCloseTo(TOP, 1);
      expect(engine.waveYAt(2.0)).toBeCloseTo(TOP, 1);
    });

    it('stay segment keeps Y flat regardless of amp', () => {
      const engine = new WaveEngine(
        [
          { direction: 'down', beats: 0.5 },
          { direction: 'stay', beats: 2 },
          { direction: 'up', beats: 0.5 },
        ],
        TIMELINE_120,
        1.3,
        0,
      );
      // after down 0.5 with amp 1.3: delta 2*130*1.3*0.5=169 -> clamped? center+169=469 > bottom 430 -> bottom
      expect(engine.waveYAt(0.5)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(1.5)).toBeCloseTo(BOTTOM, 1); // middle of stay
      expect(engine.waveYAt(2.5)).toBeCloseTo(BOTTOM, 1);
      // then up 0.5 from bottom: up delta -169 -> 430-169=261
      expect(engine.waveYAt(3.0)).toBeCloseTo(BOTTOM - 2 * TW_AMP * 1.3 * 0.5, 1);
    });

    it('multi-segment reversal: down 3 (clipped) then up 2 — climb after stay, off-grid checks', () => {
      const amp = 1.0;
      const segs: Segment[] = [
        { direction: 'down', beats: 3 },
        { direction: 'up', beats: 2 },
      ];
      const engine = new WaveEngine(segs, TIMELINE_120, amp, 0);
      // first segment already bottom at 0.5 and stay till 3
      expect(engine.waveYAt(0.37)).toBeCloseTo(clampY(CENTER + 2 * TW_AMP * amp * 0.37), 1);
      expect(engine.waveYAt(0.5)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(2.0)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(3.0)).toBeCloseTo(BOTTOM, 1);
      // second segment up from bottom: at 3.37 (0.37 into up) -> bottom -260*0.37
      expect(engine.waveYAt(3.37)).toBeCloseTo(clampY(BOTTOM - 2 * TW_AMP * amp * 0.37), 1);
      expect(engine.waveYAt(3.5)).toBeCloseTo(clampY(BOTTOM - 2 * TW_AMP * amp * 0.5), 1);
      expect(engine.waveYAt(4.0)).toBeCloseTo(clampY(BOTTOM - 2 * TW_AMP * amp * 1.0), 1); // 170
      expect(engine.waveYAt(5.0)).toBeCloseTo(TOP + 0, 5); // after 1 beat already top (260 needed), so at 4.0 is top, stay
      // off-grid 1.23 inside first clipped stay must be bottom (not slope)
      expect(engine.waveYAt(1.23)).toBeCloseTo(BOTTOM, 1);
    });

    it('up then down multi with amp=0.7 off-grid', () => {
      const amp = 0.7;
      const segs: Segment[] = [
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 2 },
      ];
      const engine = new WaveEngine(segs, TIMELINE_120, amp, 0);
      // up from center: center -260*0.7*1 = center-182=118 -> not clipped (top 170? Wait center 300 top 170 -> 300-182=118 <top? Actually TOP=170, so 118 would be clamped to 170. So check.)
      // TOP=170, center 300, up 182 -> 300-182=118 -> clamp to 170
      expect(engine.waveYAt(1)).toBeCloseTo(TOP, 1);
      // even 0.37 up: 300-67.3=232.7 not clamped
      expect(engine.waveYAt(0.37)).toBeCloseTo(CENTER - 2 * TW_AMP * amp * 0.37, 1);
      // at 1.23 (0.23 into down from top): top + 2*130*0.7*0.23
      expect(engine.waveYAt(1.23)).toBeCloseTo(TOP + 2 * TW_AMP * amp * 0.23, 1);
    });
  });

  // ------------------------------------------------------------
  // 5) 回帰: getPoints 不変性 / T127不変量
  // ------------------------------------------------------------
  describe('5. regression: getPoints length and structure invariant', () => {
    it('getPoints length = segments.length+1 (editor 1:1 mapping)', () => {
      const cases: Segment[][] = [
        [],
        [{ direction: 'down', beats: 1 }],
        [
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
        ],
        [
          { direction: 'down', beats: 0.5 },
          { direction: 'stay', beats: 1 },
          { direction: 'up', beats: 0.5 },
        ],
        [
          { direction: 'down', beats: 3 },
          { direction: 'up', beats: 2 },
          { direction: 'stay', beats: 1 },
          { direction: 'down', beats: 0.25 },
        ],
      ];
      for (const segs of cases) {
        const engine = new WaveEngine(segs, TIMELINE_120, 1.0, 0);
        const pts = engine.getPoints();
        // empty case pushes dummy point => length 2 per impl
        const expectedLen = segs.length === 0 ? 2 : segs.length + 1;
        expect(pts.length, `segs ${JSON.stringify(segs)}`).toBe(expectedLen);
        // structure must be {beat, y} only — no dY leakage into public getPoints
        for (const p of pts) {
          expect(typeof p.beat).toBe('number');
          expect(typeof p.y).toBe('number');
          expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
        }
      }
    });

    it('endpoint min(TW_AMP, 2*TW_AMP*amp*beats) invariant — T127', () => {
      // For single segment from center, endpoint displacement = min(TW_AMP, 2*TW_AMP*amp*beats)
      const tests: Array<{ amp: number; beats: number; dir: 'up' | 'down' }> = [
        { amp: 0.5, beats: 0.5, dir: 'down' },
        { amp: 1.0, beats: 0.5, dir: 'down' },
        { amp: 1.3, beats: 0.5, dir: 'down' },
        { amp: 2.7, beats: 0.3, dir: 'down' },
        { amp: 0.7, beats: 1, dir: 'up' },
      ];
      for (const t of tests) {
        const engine = new WaveEngine([{ direction: t.dir, beats: t.beats }], TIMELINE_120, t.amp, 0);
        const pts = engine.getPoints();
        const endY = pts[pts.length - 1].y;
        const expectedDisp = Math.min(TW_AMP, 2 * TW_AMP * t.amp * t.beats);
        const expectedY = t.dir === 'down' ? CENTER + expectedDisp : CENTER - expectedDisp;
        expect(endY, `amp=${t.amp} beats=${t.beats} dir=${t.dir}`).toBeCloseTo(expectedY, 1);
      }
    });

    it('physical height TW_AMP=130 invariant — maxY-minY never exceeds 2*TW_AMP', () => {
      const amps = [0.5, 1.0, 2.0, 5.0, 0.7, 3.4];
      for (const amp of amps) {
        const engine = new WaveEngine(
          [
            { direction: 'down', beats: 10 },
            { direction: 'up', beats: 10 },
          ],
          TIMELINE_120,
          amp,
          0,
        );
        const pts = engine.getPoints();
        const ys = pts.map((p) => p.y);
        expect(Math.max(...ys)).toBeLessThanOrEqual(BOTTOM + 1e-6);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(TOP - 1e-6);
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(2 * TW_AMP + 1e-6);
      }
    });

    it('waveYAt beyond last beat stays at last endpoint (no extrapolation beyond clamp)', () => {
      const engine = new WaveEngine([{ direction: 'down', beats: 1 }], TIMELINE_120, 0.5, 0);
      const last = engine.getPoints().slice(-1)[0];
      expect(engine.waveYAt(5)).toBeCloseTo(last.y, 1);
      expect(engine.waveYAt(100)).toBeCloseTo(last.y, 1);
    });
  });

  // ------------------------------------------------------------
  // 6) segmentize 物理整合性が回帰しない (T126/T127)
  // ------------------------------------------------------------
  describe('6. segmentize still snap+physical aligned (no regression)', () => {
    it('every segment beats is snap-aligned (off-grid input)', () => {
      const snaps = [0.125, 0.25, 0.5, 1];
      const amps = [0.7, 1.0, 1.3, 2.7];
      for (const snap of snaps) {
        for (const amp of amps) {
          const traj = [
            { beat: 0, y: CENTER, down: true },
            { beat: 0.37, y: CENTER + 50, down: true },
            { beat: 1.23, y: CENTER + 130, down: true },
            { beat: 1.24, y: CENTER + 130, down: false },
          ];
          const segs = segmentize(traj, snap, amp);
          expect(segs.length).toBeGreaterThan(0);
          for (const s of segs) {
            const rem = ((s.beats % snap) + snap) % snap;
            const aligned = rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
            expect(aligned, `amp=${amp} snap=${snap} beats=${s.beats}`).toBeTruthy();
          }
        }
      }
    });

    it('segmentize off-grid release beats are physically snapped (amp=1 snap=0.5)', () => {
      // raw 0.37 not snap, must be quantized to physicalSnap
      const snap = 0.5;
      const amp = 1.0;
      const traj = [
        { beat: 0, y: 0, down: true },
        { beat: 0.18, y: -10, down: true },
        { beat: 0.37, y: -20, down: true },
        { beat: 0.38, y: -20, down: false },
      ];
      const segs = segmentize(traj, snap, amp);
      expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        const rem = ((s.beats % snap) + snap) % snap;
        expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
      }
    });
  });

  // ------------------------------------------------------------
  // 7) waveYAtMs consistency & never faster than cursor
  // ------------------------------------------------------------
  describe('7. waveYAtMs via BpmTimeline + absolute border checks', () => {
    it('waveYAtMs equals waveYAt(msToBeat) with BpmTimeline', () => {
      const timeline = new BpmTimeline(120, []);
      const engine = new WaveEngine([{ direction: 'down', beats: 3 }], timeline, 1.0, 0);
      const ms = timeline.beatToMs(0.37);
      expect(engine.waveYAtMs(ms)).toBeCloseTo(engine.waveYAt(0.37), 1);
      const ms2 = timeline.beatToMs(1.23);
      expect(engine.waveYAtMs(ms2)).toBeCloseTo(engine.waveYAt(1.23), 1);
    });

    it('clampY invariant: all waveYAt values within [TOP,BOTTOM] even for clipped', () => {
      const amps = [0.5, 1.3, 2.7];
      for (const amp of amps) {
        const engine = new WaveEngine([{ direction: 'down', beats: 5 }], TIMELINE_120, amp, 0);
        for (let b = 0; b <= 5; b += 0.37) {
          const y = engine.waveYAt(b);
          expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
          expect(y).toBeLessThanOrEqual(BOTTOM + 1e-6);
        }
      }
    });
  });
});
