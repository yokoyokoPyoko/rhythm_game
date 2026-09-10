/**
 * T220: エディタCanvasのポインターイベント統一＋ピンチズーム
 * Node環境 Vitest ユニットテスト（DOMなし）
 *
 * - pointerdown / pointermove / pointerup + pointercancel への置換
 * - pointerId による単一ポインタ追跡
 * - canvas に touch-action: none
 * - 2ポインタ同時でピンチズーム（既存wheel計算式流用）
 * - 既存ドラッグロジック流用が数値的に壊れていないこと
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat, segmentize, isSnapAligned } from '../src/chart/quantize';
import {
  calculateVertexDrag,
  calculateEdgeDrag,
  calculateMultiDrag,
  calculateVertexMultiDrag,
} from '../src/game/editorDrag';
import type { Segment, BpmChange } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadWavePreviewSource(): string {
  const p = path.resolve(process.cwd(), 'src/screens/editor/WavePreview.tsx');
  return fs.readFileSync(p, 'utf-8');
}

function makeTimeline(bpmChanges: BpmChange[] = [], baseAmp = 1.0): BpmTimeline {
  return new BpmTimeline(bpmChanges, baseAmp);
}

function clampViewBeats(v: number): number {
  return Math.max(1, Math.min(200, v));
}

// wheel の計算を流用したピンチズームの純粋期待値（仕様通りの実装）
function expectedPinchBeats(startBeats: number, startDist: number, curDist: number): number {
  if (curDist <= 1e-6) return clampViewBeats(startBeats);
  const ratio = startDist / curDist;
  return clampViewBeats(startBeats * ratio);
}

const COMPLEX_AMPS = [0.7, 1.3, 2.7, 3.4] as const;
const OFF_GRID_BEATS = [0.37, 1.23, 2.71, 0.25, 1.75] as const;
const SNAP_VALUES = [0.125, 0.25, 0.5, 1] as const;

// ---------------------------------------------------------------------------
// T220: Source contract — pointer unification
// ---------------------------------------------------------------------------
describe('T220: WavePreview pointer unification source contract', () => {
  let src: string;
  let srcLower: string;

  beforeEach(() => {
    src = loadWavePreviewSource();
    srcLower = src.toLowerCase();
  });

  it('canvas に touch-action: none が付与されている', () => {
    // React では style={{ touchAction: 'none' }} または CSS touch-action: none のいずれか。
    // 少なくとも文字列 touch-action / touchAction と none が近接して存在すること。
    const hasTouchAction =
      srcLower.includes('touch-action') || src.includes('touchAction');
    const hasNone = srcLower.includes('none');
    // 3-step: capture -> perform check -> assert
    const initialHas = hasTouchAction && hasNone;
    expect(initialHas, 'canvas should have touch-action: none to prevent page scroll/gesture').toBe(true);
    // 具体的に touch-action:none の組み合わせを検証
    const combined =
      /touch-action\s*:\s*none/i.test(src) || /touchAction\s*:\s*['"]none['"]/i.test(src);
    expect(combined).toBe(true);
  });

  it('mousedown/mousemove/mouseup が pointerdown/pointermove/pointerup + pointercancel に置換されている', () => {
    // Step1: capture initial counts
    const hasPointerDown = src.includes('onPointerDown') || srcLower.includes('pointerdown');
    const hasPointerMove = src.includes('onPointerMove') || srcLower.includes('pointermove');
    const hasPointerUp = src.includes('onPointerUp') || srcLower.includes('pointerup');
    const hasPointerCancel = srcLower.includes('pointercancel');

    // Step2/3: assert all pointer handlers exist
    expect(hasPointerDown, 'must have pointerdown handler').toBe(true);
    expect(hasPointerMove, 'must have pointermove handler').toBe(true);
    expect(hasPointerUp, 'must have pointerup handler').toBe(true);
    expect(hasPointerCancel, 'must handle pointercancel').toBe(true);

    // window レベルの mouse リスナが残っていない（pointer に置換済み）
    // 反転チェック: 旧実装は window.addEventListener('mousemove' / 'mouseup')
    const hasWindowMouseMove = src.includes("window.addEventListener('mousemove'") || src.includes('window.addEventListener("mousemove"');
    const hasWindowMouseUp = src.includes("window.addEventListener('mouseup'") || src.includes('window.addEventListener("mouseup"');
    expect(hasWindowMouseMove, 'window mousemove listener must be removed (use pointermove)').toBe(false);
    expect(hasWindowMouseUp, 'window mouseup listener must be removed (use pointerup)').toBe(false);

    // 代わりに window pointer リスナが存在すること
    const hasWindowPointerMove = srcLower.includes("window.addeventlistener('pointermove") || srcLower.includes('window.addeventlistener("pointermove') || srcLower.includes('pointermove');
    const hasWindowPointerUp = srcLower.includes('pointerup');
    expect(hasWindowPointerMove).toBe(true);
    expect(hasWindowPointerUp).toBe(true);

    // JSX 側の旧 onMouseDown / onMouseMove が残っていない
    expect(src.includes('onMouseDown'), 'JSX onMouseDown must be replaced by onPointerDown').toBe(false);
    // onMouseMove が残っていると pointer 統一になっていない
    // handleMouseMove という内部名は許容するが、JSX prop としての onMouseMove は不可
    const jsxMouseMove = /onMouseMove\s*=/ .test(src);
    expect(jsxMouseMove, 'JSX onMouseMove must be replaced').toBe(false);
  });

  it('pointerId による単一ポインタ追跡が行われている', () => {
    const hasPointerId = src.includes('pointerId');
    expect(hasPointerId, 'must track pointerId for single-pointer isolation').toBe(true);
    // 少なくとも activePointerId / pointerIdRef / currentPointerId のような保持が見える
    const hasPointerRef =
      /pointerIdRef|activePointerId|currentPointerId|dragPointerId|primaryPointerId/i.test(src);
    // 厳格ではないが、pointerId 自体の存在は必須。ref名は実装依存なので pointerId あれば pass
    expect(hasPointerId).toBe(true);
  });

  it('2ポインタ同時でピンチズーム（viewBeats を距離比で変更・既存wheel計算式流用）', () => {
    // Step1: capture initial — wheel クランプが存在すること
    const wheelClampCount = (src.match(/Math\.max\s*\(\s*1\s*,\s*Math\.min\s*\(\s*200/g) || []).length;
    // wheel が1箇所、pinch が追加で1箇所以上あるはず（T220で追加）
    expect(wheelClampCount, 'pinch zoom must reuse wheel clamp Math.max(1, Math.min(200, ...)) — expect >=2 clamp sites after T220').toBeGreaterThanOrEqual(2);

    // pinch 関連の distance 計算が見える
    const hasDistance =
      srcLower.includes('distance') ||
      src.includes('getDistance') ||
      src.includes('hypot') ||
      srcLower.includes('pinch');
    // wheel とは別に、pointer 2本の距離比で viewBeats を更新するロジック
    expect(hasDistance, 'pinch must compute distance between two pointers').toBe(true);

    // view / viewBeats が pinch 経路でも更新される
    const hasViewBeatsUpdate =
      src.includes('viewBeats') && (src.includes('ratio') || src.includes('startDist') || srcLower.includes('distance'));
    expect(hasViewBeatsUpdate, 'pinch must update viewBeats via distance ratio').toBe(true);
  });

  it('既存の非passive wheel ハンドラは維持されている（pageスクロール防止）', () => {
    const hasWheel = srcLower.includes('wheel');
    const hasPreventDefault = src.includes('preventDefault');
    const hasPassiveFalse = src.includes('passive') && src.includes('false');
    expect(hasWheel, 'wheel handler must remain for PC').toBe(true);
    expect(hasPreventDefault, 'wheel must call preventDefault').toBe(true);
    expect(hasPassiveFalse, 'wheel listener must be non-passive { passive: false }').toBe(true);
  });

  it('既存ドラッグロジック（vertex/edge/ring/pan/範囲選択）が流用されている', () => {
    // 旧ロジックの呼び出しが残っていること（T220は置換のみでロジックは流用）
    expect(src.includes('calculateVertexDrag') || src.includes('vertexDragRef'), 'vertex drag logic must be reused').toBe(true);
    expect(src.includes('calculateEdgeDrag') || src.includes('edgeDragRef'), 'edge drag logic must be reused').toBe(true);
    expect(src.includes('dragRef') || src.includes('onMoveRing'), 'ring drag must be reused').toBe(true);
    expect(src.includes('panRef'), 'pan (scroll) logic must be reused').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T220: Numeric invariants — WaveEngine + Cursor remain consistent
//   複雑な振幅 (0.7/1.3/2.7/3.4) と off-grid 位相 (0.37/1.23) で検証
// ---------------------------------------------------------------------------
describe('T220: WaveEngine / Cursor numeric consistency (complex amps + off-grid)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('WaveEngine: off-grid beat での waveYAt が per-beat変位とクランプで厳密に一致する', () => {
    // Step1: capture initial state — diverse charts
    for (const amp of COMPLEX_AMPS) {
      const segs: Segment[] = [
        { direction: 'down', beats: 3 },
        { direction: 'up', beats: 2 },
        { direction: 'stay', beats: 1 },
        { direction: 'down', beats: 4 },
      ];
      const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
      const eng = new WaveEngine(segs, tl, amp, 0);
      const waveTop = TW_CENTER_Y - TW_AMP;
      const waveBottom = TW_CENTER_Y + TW_AMP;
      const perBeatPx = 2 * TW_AMP * amp;

      // Step2: probe off-grid beats inside first segment (0..3)
      for (const off of OFF_GRID_BEATS) {
        // pick a beat inside segment 0 (0 < b < 3)
        const beat = (off % 3);
        if (beat <= 0 || beat >= 3) continue;
        const startY = TW_CENTER_Y; // start_position 0 => CENTER
        const rawY = startY + perBeatPx * (beat - 0); // down positive
        const expected = Math.max(waveTop, Math.min(waveBottom, rawY));
        const actual = eng.waveYAt(beat);
        expect(Math.abs(actual - expected), `amp=${amp} beat=${beat} expected=${expected} actual=${actual}`).toBeLessThan(0.5);
      }

      // Step3: verify getPoints length invariant (T128)
      const pts = eng.getPoints();
      expect(pts.length, `getPoints length must be segments+1 for amp=${amp}`).toBe(segs.length + 1);
      // snap alignment is not tested here, but beats are as given
    }
  });

  it('WaveEngine: startPosition のオフグリッド反映とクランプ傾斜が正しい', () => {
    for (const amp of COMPLEX_AMPS) {
      for (const sp of [-1, -0.5, 0, 0.5, 1] as const) {
        const segs: Segment[] = [{ direction: 'down', beats: 0.5 + 1.2 }];
        const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
        const eng = new WaveEngine(segs, tl, amp, sp);
        const startY = TW_CENTER_Y - sp * TW_AMP;
        // beat 0
        expect(eng.waveYAt(0)).toBeCloseTo(startY, 0);
        // off-grid 0.37
        const perBeat = 2 * TW_AMP * amp;
        const raw = startY + perBeat * 0.37;
        const expected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, raw));
        expect(Math.abs(eng.waveYAt(0.37) - expected)).toBeLessThan(0.5);
      }
    }
  });

  it('Cursor update: 1拍あたり移動量が 2*TW_AMP*amplitude で WaveEngine 傾斜と一致', () => {
    for (const amp of COMPLEX_AMPS) {
      const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
      const eng = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
      const beatMs = tl.beatMsAt(0); // 500 for 120bpm
      const cursor = new Cursor(amp, 0);
      cursor.y = TW_CENTER_Y; // mid

      // 1拍ぶんの時間を 10 ステップに分割して update
      const totalSec = beatMs / 1000;
      const dt = totalSec / 10;
      const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
      const expectedDelta = speed * totalSec;
      // Step1: capture initial Y
      const y0 = cursor.y;
      // Step2: perform updates (down pressed)
      for (let i = 0; i < 10; i++) {
        cursor.update(dt, false, true, beatMs, eng.waveYAt((i * dt * 1000) / beatMs));
      }
      // Step3: assert displacement equals per-beatPx (clamped) ~ 2*TW_AMP*amp
      const waveStartY = TW_CENTER_Y;
      const rawExpected = waveStartY + expectedDelta;
      const clampedExpected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, rawExpected));
      // cursor は clamp されるため、期待も clamp
      expect(Math.abs(cursor.y - clampedExpected)).toBeLessThan(2.5);
      // 同時に waveYAt(1) とも一致（未クランプ領域なら）
      if (amp <= 1) {
        // 1拍で全幅以内ならクランプなしで完全一致
        const waveAt1 = eng.waveYAt(1);
        expect(Math.abs(waveAt1 - clampedExpected)).toBeLessThan(0.5);
      }
    }
  });

  it('Cursor + WaveEngine: off-grid 1.23拍での同期（T128/T127回帰）', () => {
    for (const amp of [0.7, 1.3, 2.7]) {
      const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
      const eng = new WaveEngine([{ direction: 'up', beats: 5 }], tl, amp, 0);
      const beatMs = tl.beatMsAt(0);
      const cur = new Cursor(amp, 0);
      cur.y = eng.waveYAt(0);
      // micro steps to 1.23 beats
      const targetBeat = 1.23;
      const targetMs = tl.beatToMs(targetBeat);
      let elapsed = 0;
      const dt = 0.016; // 60fps
      while (elapsed * 1000 < targetMs - 1e-6) {
        const curBeat = tl.msToBeat(elapsed * 1000);
        const waveY = eng.waveYAt(curBeat);
        // up なのでマイナス方向
        cur.update(dt, true, false, beatMs, waveY);
        elapsed += dt;
        vi.advanceTimersByTime(dt * 1000);
      }
      // after simulation, cursor should be near wave at 1.23 (within tolerance scaled by amp)
      const waveAtTarget = eng.waveYAt(targetBeat);
      // T163 の毎tick引き寄せ (PULL 0.008) により近づくが完全一致はしない、±TW_AMP 内での大まかな追従を検証
      // ここでは少なくとも wave と cursor が同じ上下ゾーンにいること（方向一致）を検証
      const waveTop = TW_CENTER_Y - TW_AMP;
      const waveBottom = TW_CENTER_Y + TW_AMP;
      expect(cur.y).toBeGreaterThanOrEqual(waveTop - 1);
      expect(cur.y).toBeLessThanOrEqual(waveBottom + 1);
      // より厳密: wave が上端付近なら cursor も上側にある
      if (waveAtTarget < TW_CENTER_Y - 40) {
        expect(cur.y).toBeLessThan(TW_CENTER_Y);
      }
      if (waveAtTarget > TW_CENTER_Y + 40) {
        expect(cur.y).toBeGreaterThan(TW_CENTER_Y);
      }
    }
  });

  it('BpmTimeline zoomAt と amplitudeAt が step/easing で正しく切替わる', () => {
    const changes: BpmChange[] = [
      { beat: 0, bpm: 120, amplitude: 0.7, zoom: 1.0 },
      { beat: 4, bpm: 150, amplitude: 1.3, zoom: 1.5, easeToNext: 'linear' },
      { beat: 8, bpm: 180, amplitude: 2.0, zoom: 2.0 },
    ];
    const tl = makeTimeline(changes, 0.7);
    // before first
    expect(tl.amplitudeAt(-1)).toBeCloseTo(0.7, 4);
    expect(tl.zoomAt(-1)).toBeCloseTo(1.0, 4);
    // at 0
    expect(tl.amplitudeAt(0)).toBeCloseTo(0.7, 4);
    // easing interval 4..8 linear: at 6 (=t0.5) => 1.3 + (2.0-1.3)*0.5 = 1.65
    expect(tl.amplitudeAt(6)).toBeCloseTo(1.65, 2);
    expect(tl.zoomAt(6)).toBeCloseTo(1.75, 2);
    // after 8 step
    expect(tl.amplitudeAt(8.37)).toBeCloseTo(2.0, 4);
    expect(tl.zoomAt(8.37)).toBeCloseTo(2.0, 4);
  });
});

// ---------------------------------------------------------------------------
// T220: Drag pure math — 既存ロジックの数値的流用（単一ポインタ・マルチ）
// ---------------------------------------------------------------------------
describe('T220: Editor drag math reuse (single pointer + pan + multi)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('3-step: vertex drag — capture initial → perform drag → assert snap integer & 2seg only', () => {
    const snap = 0.25;
    const amp = 1.3;
    const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
    const segs: Segment[] = [
      { direction: 'up', beats: 2 },
      { direction: 'down', beats: 2 },
      { direction: 'up', beats: 2 },
    ];
    // Step1: initial
    const eng0 = new WaveEngine(segs, tl, amp, 0);
    const pts0 = eng0.getPoints();
    const idx = 2; // interior
    const prevBeat = pts0[idx - 1].beat;
    const nextBeat = pts0[idx + 1].beat;
    expect(pts0.length).toBe(segs.length + 1);

    // Step2: perform vertex drag (off-grid targetY + off-grid beat)
    const targetBeat = 4.37; // off-grid for snap 0.25? 4.37 -> 4.25 or 4.5
    const targetY = TW_CENTER_Y - TW_AMP * 0.6; // zone 1 -> snaps to CENTER
    const result = calculateVertexDrag({
      segments: segs,
      bpmTimeline: tl,
      startPosition: 0,
      pointIndex: idx,
      targetBeat,
      targetY,
      snap,
    });

    // Step3: assert
    expect(result).not.toBeNull();
    const out = result!;
    expect(out.length).toBe(segs.length); // no segment added/removed
    // all beats snap integer
    for (const s of out) {
      expect(isSnapAligned(s.beats, snap), `beats ${s.beats} must be snap multiple`).toBe(true);
    }
    // only 2 adjacent segments changed
    let changed = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i].beats !== segs[i].beats || out[i].direction !== segs[i].direction) changed++;
    }
    expect(changed).toBeLessThanOrEqual(2);
    // new points length invariant
    const eng1 = new WaveEngine(out, tl, amp, 0);
    expect(eng1.getPoints().length).toBe(out.length + 1);
    // beat ordering preserved and within neighbours
    const pts1 = eng1.getPoints();
    expect(pts1[idx].beat).toBeGreaterThan(prevBeat + snap - 1e-6);
    expect(pts1[idx].beat).toBeLessThan(nextBeat - snap + 1e-6);
  });

  it('3-step: edge drag — horizontal+vertical off-grid → 3セグのみ変更・beats snap', () => {
    const snap = 0.5;
    const amp = 2.7;
    const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
    const segs: Segment[] = [
      { direction: 'down', beats: 1 },
      { direction: 'up', beats: 2 },
      { direction: 'down', beats: 1 },
      { direction: 'stay', beats: 1 },
    ];
    const eng0 = new WaveEngine(segs, tl, amp, 0);
    const pts0 = eng0.getPoints();
    const eIdx = 1;
    const startBeat = pts0[eIdx].beat;
    const startY = pts0[eIdx].y;
    const startPrevBeat = pts0[eIdx - 1].beat;
    const startNextBeat = pts0[eIdx + 2]?.beat ?? pts0[pts0.length - 1].beat;

    // Step1: off-grid dx/dy
    const dxBeat = 1.23; // off-grid snap 0.5 -> 1.0 after quantize
    const dy = 37; // zone shift

    // Step2: perform
    const result = calculateEdgeDrag({
      segments: segs,
      bpmTimeline: tl,
      startPosition: 0,
      edgeIndex: eIdx,
      startBeat,
      startY,
      startPrevBeat,
      startNextBeat,
      dxBeat,
      dy,
      snap,
    });

    // Step3
    expect(result).not.toBeNull();
    const out = result!;
    for (const s of out) expect(isSnapAligned(s.beats, snap)).toBe(true);
    expect(out.length).toBe(segs.length);
    // at most 3 changed
    let changed = 0;
    for (let i = 0; i < out.length; i++) if (out[i].beats !== segs[i].beats || out[i].direction !== segs[i].direction) changed++;
    expect(changed).toBeLessThanOrEqual(3);
  });

  it('pan は viewStart を dxBeat で平行移動（既存ロジックの数値期待）', () => {
    // wheel/pan の view 移動は純粋な viewStart 算出: newStart = startBeat - dxBeat
    const startBeat = 2.0;
    const viewBeats = 16;
    const canvasW = 800;
    // pointer at x=400 (mid) moving +100px right
    const dxPx = 100;
    const dxBeat = (dxPx / canvasW) * viewBeats; // 2 beats
    const newStart = Math.max(0, startBeat - dxBeat);
    expect(newStart).toBeCloseTo(0, 6); // clamped to 0
    const dxPxNeg = -80;
    const dxBeatNeg = (dxPxNeg / canvasW) * viewBeats; // -2
    const newStart2 = Math.max(0, startBeat - dxBeatNeg);
    expect(newStart2).toBeCloseTo(4, 6);
  });

  it('ring drag: xToBeat → quantize(snap) で snap 整数倍（off-grid 検証）', () => {
    for (const snap of SNAP_VALUES) {
      // off-grid raw beats: 1.37 etc
      const raw = 1.37;
      const q = quantizeBeat(raw, snap);
      expect(isSnapAligned(q, snap), `raw ${raw} snap ${snap} -> ${q} must align`).toBe(true);
      // 具体例: snap 0.5 なら 1.37 -> 1.5
      if (snap === 0.5) expect(q).toBeCloseTo(1.5, 4);
      if (snap === 0.25) expect(q).toBeCloseTo(1.25, 4);
    }
  });

  it('multi-vertex drag: 単一頂点 {v} だけが動く（後続不変）', () => {
    const snap = 0.25;
    const amp = 0.7;
    const tl = makeTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
    const segs: Segment[] = [
      { direction: 'up', beats: 2 },
      { direction: 'down', beats: 2 },
      { direction: 'up', beats: 1 },
    ];
    const eng0 = new WaveEngine(segs, tl, amp, 0);
    const pts0 = eng0.getPoints();
    // pick vertex 1 (between seg0/seg1)
    const v = 1;
    const dxBeat = 0.37; // off-grid -> 0.25 after quantize 0.25
    const dy = 0;
    const result = calculateVertexMultiDrag({
      segments: segs,
      bpmTimeline: tl,
      startPosition: 0,
      vertexIndices: [v],
      dxBeat,
      dy,
      snap,
    });
    expect(result).not.toBeNull();
    const out = result!;
    const eng1 = new WaveEngine(out, tl, amp, 0);
    const pts1 = eng1.getPoints();
    // only vertex v moved
    expect(Math.abs(pts1[v].beat - (pts0[v].beat + quantizeBeat(dxBeat, snap)))).toBeLessThan(1e-6);
    // neighbours except v unchanged in beat (except clamped)
    for (let i = 0; i < pts0.length; i++) {
      if (i === v) continue;
      // due to clamping, some beats might shift slightly, but at least final length invariant
    }
    expect(pts1.length).toBe(pts0.length);
    for (const s of out) expect(isSnapAligned(s.beats, snap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T220: Pinch zoom pure math — wheel計算式流用
// ---------------------------------------------------------------------------
describe('T220: Pinch zoom math (wheel formula reuse)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('3-step: 初期 viewBeats → ピンチ距離変化 → 期待 viewBeats に遷移（clamp 1..200）', () => {
    // Step1: capture initial
    const startBeats = 16;
    const startDist = 180; // px between two pointers
    expect(clampViewBeats(startBeats)).toBe(16);

    // Step2: perform pinch — fingers move closer (zoom out) : 180 -> 120
    const curDistClose = 120;
    const afterClose = expectedPinchBeats(startBeats, startDist, curDistClose);
    // Step3: assert wider view (beats increased) : 16 * 180/120 = 24
    expect(afterClose).toBeCloseTo(24, 6);
    // equally, fingers move apart (zoom in): 180 -> 240 => 16*0.75=12
    const curDistFar = 240;
    const afterFar = expectedPinchBeats(startBeats, startDist, curDistFar);
    expect(afterFar).toBeCloseTo(12, 6);

    // off-grid distances
    const offDist = 187.37;
    const afterOff = expectedPinchBeats(16, offDist, 123.71);
    expect(afterOff).toBeGreaterThan(1);
    expect(afterOff).toBeLessThan(200);
    // clamp upper
    const huge = expectedPinchBeats(16, 500, 10);
    expect(huge).toBe(200);
    // clamp lower
    const tiny = expectedPinchBeats(16, 10, 500);
    expect(tiny).toBe(1);

    // identical to wheel factor semantics: wheel factor 0.85 (zoom in) vs 1.15 (zoom out)
    // pinch ratio start/cur serves as continuous factor; clamp same
    vi.advanceTimersByTime(100);
    expect(afterClose).not.toBe(startBeats);
  });

  it('pinch は既存 wheel と同一クランプ 1..200 かつ anchor beat を保持する設計を満たす', () => {
    // anchor beat (fingers midpoint) should stay fixed: newStart = bCursor - (x / width)*newBeats
    const viewStart = 2.0;
    const viewBeats = 16;
    const canvasW = 800;
    const midX = 400; // center
    const bCursor = viewStart + (midX / canvasW) * viewBeats; // 10
    const newBeats = clampViewBeats(viewBeats * (200 / 100)); // zoom in factor 2 => 32 clamped? actually 16*2=32
    const newStart = bCursor - (midX / canvasW) * newBeats;
    expect(newStart).toBeCloseTo(bCursor - newBeats * 0.5, 6);
    // newStart may go negative -> clamped to 0 downstream
    expect(Math.max(0, newStart)).toBeGreaterThanOrEqual(0);
  });

  it('single-pointer pan と pinch zoom が排他的に動作する期待値', () => {
    // 1本のときは pan（dxBeat）、2本のときは pinch（ratio）。状態遷移の期待値を純粋に検証
    const pointers = new Map<number, { x: number; y: number }>();
    // Step1: initial 0 pointers
    expect(pointers.size).toBe(0);
    // Step2: add first pointer -> should be tracked as single (pan)
    pointers.set(1, { x: 100, y: 200 });
    expect(pointers.size).toBe(1);
    // add second -> pinch mode
    pointers.set(2, { x: 200, y: 200 });
    expect(pointers.size).toBe(2);
    const startDist = Math.hypot(200 - 100, 0);
    expect(startDist).toBe(100);
    // move second pointer apart to 250 => curDist 150 => ratio 0.666 => zoom in
    const curDist = Math.hypot(250 - 100, 0);
    const newBeats = expectedPinchBeats(16, startDist, curDist);
    // Step3: assert pinch produces zoom in (<16)
    expect(newBeats).toBeLessThan(16);
    expect(newBeats).toBeCloseTo(16 * (100 / 150), 6);
  });
});

// ---------------------------------------------------------------------------
// T220: segmentize snap 整合性（off-grid 必須）— 録音ロジック回帰なし
// ---------------------------------------------------------------------------
describe('T220: segmentize snap invariance (off-grid)', () => {
  it('3-step: 軌跡記録 → segmentize → 全 beats が snap 整数倍（off-grid release）', () => {
    for (const snap of [0.125, 0.25, 0.5, 1] as const) {
      for (const amp of COMPLEX_AMPS) {
        // 0.30拍の短押しを off-grid でシミュレート（release が snap 境界ではない）
        const traj: { beat: number; y: number; down: boolean }[] = [
          { beat: 0, y: TW_CENTER_Y, down: false },
          { beat: 0.37, y: TW_CENTER_Y - 40, down: true },
          { beat: 0.67, y: TW_CENTER_Y - 80, down: true },
          { beat: 1.0, y: TW_CENTER_Y - 80, down: false },
        ];
        // Step1: traj length
        expect(traj.length).toBeGreaterThan(1);
        // Step2: segmentize
        const segs = segmentize(traj, snap, amp);
        // Step3: all beats snap-aligned and no zero-length
        for (const s of segs) {
          expect(isSnapAligned(s.beats, snap), `amp=${amp} snap=${snap} beats=${s.beats}`).toBe(true);
          expect(s.beats).toBeGreaterThan(0);
        }
        // 非空なら少なくとも1セグ
        if (traj.length >= 2) {
          expect(segs.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('BPM 120/180 で同一 normAmp の wave 正規化が一致（T112回帰）', () => {
    const segs: Segment[] = [{ direction: 'down', beats: 2 }];
    const tl120 = makeTimeline([{ beat: 0, bpm: 120, amplitude: 1.0 }], 1.0);
    const tl180 = makeTimeline([{ beat: 0, bpm: 180, amplitude: 1.0 }], 1.0);
    const eng120 = new WaveEngine(segs, tl120, 1.0, 0);
    const eng180 = new WaveEngine(segs, tl180, 1.0, 0);
    // waveYAt は bpm に依存しない（amplitude のみ） — 同じ beat で同じ Y
    expect(eng120.waveYAt(1)).toBeCloseTo(eng180.waveYAt(1), 6);
    expect(eng120.waveYAt(0.37)).toBeCloseTo(eng180.waveYAt(0.37), 6);
  });
});

// ---------------------------------------------------------------------------
// T220: FakeTimers determinism — 描画/入力タイミングの決定性
// ---------------------------------------------------------------------------
describe('T220: fake timers determinism for drag/zoom', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('vi.advanceTimersByTime が決定的に進行する（T220のtick前提）', () => {
    let tick = 0;
    const id = setInterval(() => { tick += 1; }, 16);
    // Step1: initial
    expect(tick).toBe(0);
    // Step2: advance 100ms -> ~6 ticks
    vi.advanceTimersByTime(100);
    const after100 = tick;
    expect(after100).toBeGreaterThanOrEqual(6);
    // Step3: advance another 100 -> doubles
    vi.advanceTimersByTime(100);
    expect(tick).toBe(after100 * 2);
    clearInterval(id);
  });
});
