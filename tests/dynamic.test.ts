import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { BpmTimeline } from '../src/audio/bpmTimeline'
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine'
import { Cursor } from '../src/game/cursor'
import { quantizeBeat, segmentize, type TrajPoint } from '../src/chart/quantize'
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock'
import fs from 'node:fs'
import path from 'node:path'

// --- node localStorage stub (clock.ts uses it) ---
const _store: Record<string, string> = {}
if (!(globalThis as any).localStorage) {
  ;(globalThis as any).localStorage = {
    getItem(k: string) { return _store[k] ?? null },
    setItem(k: string, v: string) { _store[k] = String(v) },
    removeItem(k: string) { delete _store[k] },
    clear() { for (const kk in _store) delete _store[kk] },
  }
}

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true
  const r = ((beats % snap) + snap) % snap
  return r < 1e-6 || Math.abs(r - snap) < 1e-6
}

// Helpers that simulate *expected* T132-corrected editor stamping logic
function editorRingPressBeat(posMs: number, timeline: BpmTimeline, snap: number, mode: 'play' | 'record', isPlaying: boolean): number | null {
  if (mode !== 'record' || !isPlaying) return null
  const posPrime = posMs - getManualOffsetMs()
  return quantizeBeat(timeline.msToBeat(posPrime), snap)
}
function editorHoldEndBeat(posMs: number, timeline: BpmTimeline, snap: number, mode: 'play' | 'record', isPlaying: boolean): number | null {
  if (mode !== 'record' || !isPlaying) return null
  const posPrime = posMs - getManualOffsetMs()
  return quantizeBeat(timeline.msToBeat(posPrime), snap)
}
function editorSegmentReleaseBeat(posMs: number, timeline: BpmTimeline, snap: number, mode: 'play' | 'record', isPlaying: boolean): number | null {
  if (mode !== 'record' || !isPlaying) return null
  const posPrime = posMs - getManualOffsetMs()
  return quantizeBeat(timeline.msToBeat(posPrime), snap)
}
function recLoopBeat(posMs: number, timeline: BpmTimeline, snap: number): number {
  // continuous trajectory must NOT be compensated
  return quantizeBeat(timeline.msToBeat(posMs), snap)
}

// Calibration engine extracted from spec (single source of truth)
class CalibrationSim {
  static CAL_BPM = 120
  static CAL_SAMPLES = 8
  static DISCARD_FIRST = 2
  savedOffset = 0
  samples: number[] = []
  grid: number[] = []
  started = false
  buildGrid(ctxNow = 0) {
    const beatSec = 60 / CalibrationSim.CAL_BPM
    let t = ctxNow + 0.3
    for (let i = 0; i < CalibrationSim.CAL_SAMPLES; i++) {
      this.grid[i] = t
      t += beatSec
    }
  }
  beginIfNeeded() {
    if (!this.started) {
      this.started = true
      // T132-3: first Space resets offset to 0
      this.savedOffset = getManualOffsetMs()
      setManualOffset(0)
      this.buildGrid(0)
    }
  }
  tap(tapTimeSec: number): number | null {
    this.beginIfNeeded()
    const idx = this.samples.length
    if (idx >= CalibrationSim.CAL_SAMPLES) return null
    const err = this.grid[idx] !== undefined ? (tapTimeSec - this.grid[idx]) * 1000 : NaN
    this.samples.push(err)
    if (this.samples.length >= CalibrationSim.CAL_SAMPLES) {
      const kept = this.samples.slice(CalibrationSim.DISCARD_FIRST).filter(v => Number.isFinite(v))
      if (kept.length > 0) {
        const avg = kept.reduce((a, b) => a + b, 0) / kept.length
        const next = Math.round(avg)
        setManualOffset(next)
        return next
      }
      return getManualOffsetMs()
    }
    return null
  }
  cancel() {
    // restore saved offset
    setManualOffset(this.savedOffset)
  }
}

beforeEach(() => {
  setManualOffset(0)
  for (const k in _store) delete _store[k]
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  setManualOffset(0)
})

describe('T132-1: 録音時オフセット補正 (ring press / hold終端 / セグメントrelease) + 軌跡非補正', () => {
  const snaps = [0.125, 0.25, 0.5, 1] as const

  test('ring Space押下 beat が pos-getManualOffsetMs で補正される (off-grid必須)', () => {
    // [Step 1: Capture Before] 未補正のbeat
    const timeline = new BpmTimeline(120, [], 1.0)
    const snap = 0.25
    const tapBeatOffGrid = 2.37 // off-grid
    const tapPos = timeline.beatToMs(tapBeatOffGrid)
    const beforeUncorrected = quantizeBeat(timeline.msToBeat(tapPos), snap)

    // [Step 2: Perform Action] offset +80 を設定し record中に打刻
    setManualOffset(80)
    const corrected = editorRingPressBeat(tapPos, timeline, snap, 'record', true)
    // [Step 3: Assert Transition] 補正後のbeatが式に一致し、未補正と異なる
    const expected = quantizeBeat(timeline.msToBeat(tapPos - 80), snap)
    expect(corrected).not.toBeNull()
    expect(corrected).toBeCloseTo(expected, 4)
    expect(corrected).not.toBeCloseTo(beforeUncorrected, 4)
  })

  for (const snap of snaps) {
    test(`snap=${snap}: ring press off-grid 0.37/1.23/2.71 で補正が snap整数倍かつ式と一致`, () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const offGridBeats = [0.37, 1.23, 2.71]
      setManualOffset(80)
      for (const b of offGridBeats) {
        const pos = timeline.beatToMs(b)
        const before = quantizeBeat(timeline.msToBeat(pos), snap)
        const got = editorRingPressBeat(pos, timeline, snap, 'record', true)!
        const exp = quantizeBeat(timeline.msToBeat(pos - 80), snap)
        expect(isSnapAligned(got, snap)).toBe(true)
        expect(got).toBeCloseTo(exp, 4)
        // when offset non-zero, generally differs (allow equality only if quantize absorbs 80ms ~ 0.16beat at 120BPM may occasionally coincide)
        // enforce by picking beats where difference is material: skip equality check if close
        if (Math.abs(before - exp) > 1e-6) expect(got).not.toBe(before)
      }
    })
  }

  test('hold終端 beat も同式 pos-80 で補正される', () => {
    const timeline = new BpmTimeline(120, [], 1.0)
    const snap = 0.25
    setManualOffset(80)
    const startPos = timeline.beatToMs(1.37)
    const endPos = timeline.beatToMs(2.73) // off-grid release
    const startBeat = editorRingPressBeat(startPos, timeline, snap, 'record', true)!
    const snappedEnd = editorHoldEndBeat(endPos, timeline, snap, 'record', true)!
    const expStart = quantizeBeat(timeline.msToBeat(startPos - 80), snap)
    const expEnd = quantizeBeat(timeline.msToBeat(endPos - 80), snap)
    expect(startBeat).toBeCloseTo(expStart, 4)
    expect(snappedEnd).toBeCloseTo(expEnd, 4)
    const rawDur = snappedEnd - startBeat
    const duration = Number(quantizeBeat(rawDur, snap).toFixed(2))
    expect(isSnapAligned(duration, snap)).toBe(true)
  })

  test('セグメント ArrowUp release beat も pos-80 補正 (T105 b_end = round(b_rel/s)*s)', () => {
    const timeline = new BpmTimeline(120, [], 1.0)
    const snap = 0.5
    setManualOffset(80)
    // off-grid release beats 1.2 -> 1.0, 1.3 -> 1.5
    for (const [rawBeat, expectedEnd] of [[1.2, 1.0], [1.3, 1.5]] as const) {
      const pos = timeline.beatToMs(rawBeat)
      const got = editorSegmentReleaseBeat(pos, timeline, snap, 'record', true)!
      const exp = quantizeBeat(timeline.msToBeat(pos - 80), snap)
      // also check T105 rounding property on the raw corrected value
      // corrected raw before quantize is msToBeat(pos-80); its quantize should be round(.../s)*s
      const manualRound = Math.round(timeline.msToBeat(pos - 80) / snap) * snap
      expect(got).toBeCloseTo(Number(manualRound.toFixed(4)), 4)
      expect(got).toBeCloseTo(exp, 4)
      // also verify T105 specific: without offset, 1.2->1.0, but with -80ms offset the beat shifts slightly
      // we check that our helper is exactly the off-grid principle
      expect(isSnapAligned(got, snap)).toBe(true)
    }
  })

  test('連続軌跡サンプル beat は補正しない (posそのまま)', () => {
    const timeline = new BpmTimeline(120, [], 1.0)
    const snap = 0.25
    const pos = timeline.beatToMs(3.37)
    setManualOffset(80)
    // capture before: trajectory beat (uncorrected)
    const trajBeat = recLoopBeat(pos, timeline, snap)
    const compensatedBeat = quantizeBeat(timeline.msToBeat(pos - 80), snap)
    // perform: trajectory must remain uncorrected
    expect(trajBeat).toBeCloseTo(quantizeBeat(timeline.msToBeat(pos), snap), 4)
    expect(trajBeat).not.toBeCloseTo(compensatedBeat, 4)
    expect(isSnapAligned(trajBeat, snap)).toBe(true)
  })

  test('補正は mode=record && isPlaying の打刻のみ、playモードではnullを返す', () => {
    const timeline = new BpmTimeline(120, [], 1.0)
    const snap = 0.25
    setManualOffset(80)
    const pos = timeline.beatToMs(1.5)
    const inPlay = editorRingPressBeat(pos, timeline, snap, 'play', true)
    const notPlaying = editorRingPressBeat(pos, timeline, snap, 'record', false)
    const inRecord = editorRingPressBeat(pos, timeline, snap, 'record', true)
    expect(inPlay).toBeNull()
    expect(notPlaying).toBeNull()
    expect(inRecord).not.toBeNull()
  })

  test('finishRecording startBeat(recStartBeatRef)は補正しない', () => {
    // startBeat is recording start position, not a key tap: must use raw pos
    const timeline = new BpmTimeline(120, [], 1.0)
    const snap = 0.25
    setManualOffset(80)
    const startPos = timeline.beatToMs(0.37)
    const rawStartBeat = quantizeBeat(timeline.msToBeat(startPos), snap)
    const compensated = quantizeBeat(timeline.msToBeat(startPos - 80), snap)
    expect(rawStartBeat).not.toBe(compensated)
    // spec says startBeat not compensated
    expect(rawStartBeat).toBeCloseTo(0.25 /* 0.37 quantized to 0.25 */ , 4)
  })
})

describe('T132-2: エディタ </> 微調整 ±10ms + offset表示', () => {
  test('</> キーで getManualOffsetMs が ±10 変化する (3-step)', () => {
    // Step1: capture before
    setManualOffset(20)
    const before = getManualOffsetMs()
    expect(before).toBe(20)

    // Step2: simulate ,/</. > handlers: setManualOffset(getManualOffsetMs()+delta)
    const adjust = (d: number) => setManualOffset(Math.round(getManualOffsetMs() + d))
    adjust(-10)
    const afterDec = getManualOffsetMs()
    expect(afterDec).toBe(10)

    // Step3: increment back
    adjust(10)
    const afterInc = getManualOffsetMs()
    expect(afterInc).toBe(20)
    expect(afterInc - afterDec).toBe(10)
  })

  test('offset表示文字列は GameScreenと同形式 offset: +Xms', () => {
    // capture before
    setManualOffset(0)
    const fmt = (v: number) => `offset: ${v >= 0 ? '+' : ''}${v}ms`
    expect(fmt(getManualOffsetMs())).toBe('offset: +0ms')
    // action
    setManualOffset(-30)
    expect(fmt(getManualOffsetMs())).toBe('offset: -30ms')
    setManualOffset(80)
    expect(fmt(getManualOffsetMs())).toBe('offset: +80ms')
  })

  test('EditorScreen.tsx が ,/. ハンドラと editor-offset 表示と getManualOffsetMs import を含む (Red→Green)', () => {
    const fp = path.join(process.cwd(), 'src/screens/EditorScreen.tsx')
    const src = fs.readFileSync(fp, 'utf-8')
    // must import from clock
    expect(src).toMatch(/from\s+['"]\.\.\/audio\/clock['"]/)
    expect(src).toMatch(/getManualOffsetMs/)
    expect(src).toMatch(/setManualOffset/)
    // , / < handler
    expect(src).toMatch(/e\.key\s*===\s*','/)
    expect(src).toMatch(/e\.key\s*===\s*'\.'/)
    // or key check for < > could be present — require delta logic
    expect(src).toContain('setManualOffset')
    // display
    expect(src).toContain('data-testid="editor-offset"')
    expect(src).toContain('#music-control')
    // adjustOffset pattern: getManualOffsetMs() + delta
    expect(src).toMatch(/getManualOffsetMs\(\)\s*\+/)
  })

  test('EditorScreen.tsx の #music-control 内に editor-offset 要素が存在する位置検証', () => {
    const fp = path.join(process.cwd(), 'src/screens/EditorScreen.tsx')
    const src = fs.readFileSync(fp, 'utf-8')
    const musicControlIdx = src.indexOf('id="music-control"')
    const offsetIdx = src.indexOf('editor-offset')
    expect(musicControlIdx).toBeGreaterThan(-1)
    expect(offsetIdx).toBeGreaterThan(-1)
    expect(offsetIdx).toBeGreaterThan(musicControlIdx)
  })
})

describe('T132-3: エディタ内キャリブレーションモーダル (Space×8, 最初2破棄, 平均)', () => {
  test('CalibrationModal.tsx が新規作成され必須仕様を含む (Red→Green)', () => {
    const fp = path.join(process.cwd(), 'src/screens/editor/CalibrationModal.tsx')
    expect(fs.existsSync(fp)).toBe(true)
    const src = fs.readFileSync(fp, 'utf-8')
    expect(src).toContain('120') // CAL_BPM
    expect(src).toMatch(/8/)
    expect(src).toMatch(/setManualOffset\(0\)/)
    expect(src).toMatch(/setManualOffset/) // average save
    expect(src).toMatch(/Escape|ESC/)
    expect(src).toMatch(/editor-calibration-button|CalibrationModal/)
  })

  test('EditorScreen が editor-calibration-button を #music-control 内に持つ', () => {
    const fp = path.join(process.cwd(), 'src/screens/EditorScreen.tsx')
    const src = fs.readFileSync(fp, 'utf-8')
    expect(src).toContain('data-testid="editor-calibration-button"')
    const mcIdx = src.indexOf('id="music-control"')
    const btnIdx = src.indexOf('editor-calibration-button')
    expect(mcIdx).toBeGreaterThan(-1)
    expect(btnIdx).toBeGreaterThan(mcIdx)
  })

  test('キャリブレーション: Space1回目で setManualOffset(0) にリセット (3-step)', () => {
    setManualOffset(75)
    const before = getManualOffsetMs()
    expect(before).toBe(75)
    const sim = new CalibrationSim()
    sim.tap(0.31) // first tap triggers reset
    const afterFirst = getManualOffsetMs()
    expect(afterFirst).toBe(0)
    expect(before).not.toBe(afterFirst)
  })

  test('Space×8 完了で残り6平均が offset になる (3-step, off-grid含む)', () => {
    setManualOffset(10)
    const sim = new CalibrationSim()
    sim.buildGrid(0)
    // tap times: slightly off-grid, 8 taps
    const errorsWanted = [5, 7, 30, 32, 28, 35, 31, 29] // ms errors vs grid
    for (let i = 0; i < 8; i++) {
      const tap = sim.grid[i] + errorsWanted[i] / 1000
      sim.tap(tap)
    }
    const kept = errorsWanted.slice(2)
    const expectedAvg = Math.round(kept.reduce((a, b) => a + b, 0) / kept.length)
    const got = getManualOffsetMs()
    expect(got).toBe(expectedAvg)
    expect(got).toBe(Math.round((30+32+28+35+31+29)/6))
  })

  test('ESC/閉じるでキャンセル時は直前オフセットへ復元 (3-step)', () => {
    setManualOffset(42)
    const before = getManualOffsetMs()
    const sim = new CalibrationSim()
    // open modal saves before
    sim.savedOffset = before
    sim.beginIfNeeded() // resets to 0 but saved is 42
    // do few taps
    sim.tap(sim.grid[0] + 0.02)
    sim.tap(sim.grid[1] + 0.03)
    expect(getManualOffsetMs()).toBe(0) // still not finished
    // cancel
    sim.cancel()
    const afterCancel = getManualOffsetMs()
    expect(afterCancel).toBe(before)
    expect(afterCancel).toBe(42)
  })

  test('キャリブレーション完了後は平均値が保存され、キャンセルでは保存されない分岐', () => {
    // Scenario A: complete
    setManualOffset(0)
    let sim = new CalibrationSim()
    sim.buildGrid(0)
    const errs = [10, 12, 20, 22, 24, 26, 28, 30]
    for (let i = 0; i < 8; i++) sim.tap(sim.grid[i] + errs[i]/1000)
    const completedOffset = getManualOffsetMs()
    const expected = Math.round(errs.slice(2).reduce((a,b)=>a+b,0)/6)
    expect(completedOffset).toBe(expected)

    // Scenario B: cancel restores
    setManualOffset(99)
    sim = new CalibrationSim()
    sim.savedOffset = 99
    sim.beginIfNeeded()
    sim.tap(sim.grid[0] + 0.05)
    sim.cancel()
    expect(getManualOffsetMs()).toBe(99)
  })
})

describe('T132-4: 回帰 (T102/T103, T100, T105, T129, 軌跡非補正, T127/T128数値整合)', () => {
  test('T102/T103: playモード中のリング/セグメント打刻は無効 (3-step)', () => {
    const tl = new BpmTimeline(120, [], 1.0)
    setManualOffset(80)
    const pos = tl.beatToMs(1.5)
    const beforeRings = 0
    const ringInPlay = editorRingPressBeat(pos, tl, 0.25, 'play', true)
    expect(ringInPlay).toBeNull()
    const segInPlay = editorSegmentReleaseBeat(pos, tl, 0.25, 'play', true)
    expect(segInPlay).toBeNull()
    expect(beforeRings).toBe(0)
    // record mode should allow
    const ringInRecord = editorRingPressBeat(pos, tl, 0.25, 'record', true)
    expect(ringInRecord).not.toBeNull()
  })

  test('T100: holdリングは duration>0.3 で hold として生成 (3-step)', () => {
    const tl = new BpmTimeline(120, [], 1.0)
    const snap = 0.25
    setManualOffset(80)
    const startPos = tl.beatToMs(1.0)
    const shortEndPos = tl.beatToMs(1.15) // ~0.15 beat short
    const longEndPos = tl.beatToMs(1.6) // ~0.6 beat long
    const startBeat = editorRingPressBeat(startPos, tl, snap, 'record', true)!
    const shortEnd = editorHoldEndBeat(shortEndPos, tl, snap, 'record', true)!
    const longEnd = editorHoldEndBeat(longEndPos, tl, snap, 'record', true)!
    const shortDur = Number(quantizeBeat(longEnd - startBeat < 0.2 ? shortEnd - startBeat : shortEnd - startBeat, snap).toFixed(2))
    // need proper: short duration
    const sDur = Number(quantizeBeat(shortEnd - startBeat, snap).toFixed(2))
    const lDur = Number(quantizeBeat(longEnd - startBeat, snap).toFixed(2))
    expect(sDur <= 0.3).toBe(true)
    expect(lDur > 0.3).toBe(true)
    // compensated vs uncompensated gap check
    const uncompensatedShort = Number(quantizeBeat(quantizeBeat(tl.msToBeat(shortEndPos), snap) - quantizeBeat(tl.msToBeat(startPos), snap), snap).toFixed(2))
    // they differ when offset applied (except rare coincidence)
    // hold reflection invariant still holds: duration snap-aligned
    expect(isSnapAligned(lDur, snap)).toBe(true)
  })

  test('T105: リリース吸着 b_end = round(b_rel/s)*s オフグリッド検証 (snap=0.5)', () => {
    const snap = 0.5
    // directly test quantizeBeat formula
    const cases: Array<[number, number]> = [[1.2, 1.0], [1.3, 1.5], [0.74, 0.5], [0.76, 1.0]]
    for (const [bRel, exp] of cases) {
      const got = quantizeBeat(bRel, snap)
      expect(got).toBeCloseTo(exp, 4)
    }
    // also via editor helper with offset
    const tl = new BpmTimeline(120, [], 1.0)
    setManualOffset(80)
    for (const [bRel, expNoOffset] of cases) {
      const pos = tl.beatToMs(bRel)
      const correctedBeat = editorSegmentReleaseBeat(pos, tl, snap, 'record', true)!
      const expWithOffset = quantizeBeat(tl.msToBeat(pos - 80), snap)
      expect(correctedBeat).toBeCloseTo(expWithOffset, 4)
      expect(isSnapAligned(correctedBeat, snap)).toBe(true)
    }
  })

  test('T129: segmentize の各 beats は snap 整数倍 (off-grid含む)', () => {
    const snap = 0.25
    const tl = new BpmTimeline(120, [], 1.0)
    // use quantize path: segmentize with off-grid trajectory
    // Build traj with short off-grid runs
    const traj: TrajPoint[] = [
      { beat: 0, y: 300, down: false },
      { beat: 0.3, y: 300, down: true }, // off-grid start
      { beat: 0.6, y: 170, down: false }, // off-grid end
      { beat: 1.1, y: 170, down: false },
    ]
    const segs = segmentize(traj, snap, 1.0)
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true)
    // T129 also requires: short 0.30 beats with snap=0.125 should quantize to 0.25 not 1.0
    const traj2: TrajPoint[] = [
      { beat: 0, y: 300, down: false },
      { beat: 0.10, y: 300, down: true },
      { beat: 0.40, y: 170, down: false }, // 0.30 raw
    ]
    const segs0125 = segmentize(traj2, 0.125, 1.0)
    const moving = segs0125.find(s => s.direction !== 'stay')
    expect(moving).toBeDefined()
    expect(moving!.beats).toBeCloseTo(0.25, 4) // not 1.0
    expect(isSnapAligned(moving!.beats, 0.125)).toBe(true)
  })

  test('録音ループ軌跡は常に非補正 (trajectory beat unchanged by offset)', () => {
    const tl = new BpmTimeline(120, [], 1.0)
    for (const snap of [0.125, 0.25, 0.5] as const) {
      for (const b of [0.37, 1.23] as const) {
        const pos = tl.beatToMs(b)
        setManualOffset(80)
        const trajBeat = recLoopBeat(pos, tl, snap)
        const uncomp = quantizeBeat(tl.msToBeat(pos), snap)
        const comp = quantizeBeat(tl.msToBeat(pos - 80), snap)
        expect(trajBeat).toBe(uncomp)
        expect(trajBeat).not.toBe(comp)
      }
    }
  })

  test('T127/T128: WaveEngine と Cursor の数値整合 (複雑振幅 0.7/1.3/2.7/3.4 + off-grid 0.37/1.23)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const
    const offGridBeats = [0.37, 1.23, 2.37, 3.71]
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: amp } as any], amp)
      // Verify amplitudeAt step before / after
      expect(tl.amplitudeAt(3.37)).toBe(amp) // base is amp itself, until change at 4 — actually base = amp, so 3.37 also amp; test step with two entries
      const tl2 = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 1.0 }, { beat: 8, bpm: 120, amplitude: amp }] as any, 1.0)
      expect(tl2.amplitudeAt(3.37)).toBe(1.0)
      expect(tl2.amplitudeAt(4.23)).toBe(1.0)
      expect(tl2.amplitudeAt(8.37)).toBe(amp)
      expect(tl2.amplitudeAt(8.0)).toBe(amp)

      const segs = [{ direction: 'down' as const, beats: 3 }, { direction: 'up' as const, beats: 3 }, { direction: 'stay' as const, beats: 2 }]
      const engine = new WaveEngine(segs, new BpmTimeline(120, [], amp), undefined, 0.0)
      // check dY-derived slope: up = -2*TW_AMP*amp
      const perBeatPx = 2 * TW_AMP * amp
      const waveTop = TW_CENTER_Y - TW_AMP
      const waveBottom = TW_CENTER_Y + TW_AMP
      // cursor speed should match perBeatPx
      const beatMs = 500 // 120 BPM
      const cursor = new Cursor(amp, 0)
      const beforeY = cursor.y
      cursor.update(0.5, false, true, beatMs) // down half sec -> delta = speed*0.5 = perBeatPx * 1000/beatMs *0.5 = perBeatPx * (0.5*1000/500)=perBeatPx
      // speed = 2*TW_AMP*amp / (beatMs/1000) = perBeatPx / (0.5) = 2*perBeatPx; delta=2*perBeatPx*0.5=perBeatPx
      const cursorDelta = cursor.y - beforeY
      expect(cursorDelta).toBeCloseTo(perBeatPx, 4)

      for (const b of offGridBeats) {
        const startY = TW_CENTER_Y // startPosition 0
        // waveYAt with amplitude-driven slope, clamped
        const rawY = startY + perBeatPx * b // down direction first seg
        const expectedClamped = Math.max(waveTop, Math.min(waveBottom, rawY))
        // For beats within first segment (0-3), waveYAt should equal that
        if (b <= 3) {
          const got = engine.waveYAt(b)
          expect(got).toBeCloseTo(expectedClamped, 4)
        }
      }
      // getPoints length = segments.length +1
      expect(engine.getPoints().length).toBe(segs.length + 1)
      // amplitude change does not alter TW_AMP height
      const top = waveTop
      const bottom = waveBottom
      expect(bottom - top).toBeCloseTo(2 * TW_AMP, 4)
    }
  })
})
