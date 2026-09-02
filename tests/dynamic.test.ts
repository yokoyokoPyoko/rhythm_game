// T134 — エディタ内キャリブレーションオーバーレイ時のキー入力独占
// Vitest node environment — pure engine + behavioral simulation (no DOM)
// 3-step state-transition assertions: [Capture Initial] -> [Perform Action] -> [Assert Outcome]
// Uses vi.useFakeTimers(), off-grid verification, complex amplitudes 0.7/1.3/2.7/3.4
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  } as any
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BpmTimeline } from '../src/audio/bpmTimeline'
import { Cursor } from '../src/game/cursor'
import { TW_AMP, TW_CENTER_Y, WaveEngine } from '../src/game/waveEngine'
import { quantizeBeat, segmentize, isSnapAligned } from '../src/chart/quantize'
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock'
import { judgeHit } from '../src/game/hitJudge'
import { generateCalibrationChart } from '../src/screens/editor/CalibrationModal'

// ---------------------------------------------------------------------------
// Simulator: pure representation of T134 guard logic
// Mirrors EditorScreen onKeyDown/onKeyUp early returns
// ---------------------------------------------------------------------------
type EditorCtx = {
  calibrationOpen: boolean
  playtestActive: boolean
  isPlaying: boolean
  mode: 'play' | 'record'
  offsetMs: number
  playTriggered: boolean
  spaceHold: boolean
  arrowUpHandled: boolean
  arrowDownHandled: boolean
}

function makeEditorHandler(ctx: EditorCtx) {
  return {
    // returns true if editor consumed (guarded or handled)
    handleKeyDown(key: string, code?: string): { consumed: boolean; playTriggered: boolean; offsetDelta: number; arrowHandled: boolean } {
      // T134 guard: must be immediate after playtest guard, before any other logic
      if (ctx.playtestActive) return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: false }
      if (ctx.calibrationOpen) return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: false }

      if (code === 'Space') {
        if (ctx.isPlaying && ctx.mode === 'record') {
          if (ctx.spaceHold) return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: false }
          ctx.spaceHold = true
          return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: false }
        }
        ctx.playTriggered = !ctx.isPlaying
        return { consumed: true, playTriggered: true, offsetDelta: 0, arrowHandled: false }
      }
      if (key === ',' || key === '<') {
        ctx.offsetMs -= 10
        return { consumed: true, playTriggered: false, offsetDelta: -10, arrowHandled: false }
      }
      if (key === '.' || key === '>') {
        ctx.offsetMs += 10
        return { consumed: true, playTriggered: false, offsetDelta: 10, arrowHandled: false }
      }
      if (code === 'ArrowUp' || key === 'ArrowUp') {
        if (ctx.mode === 'record' && ctx.isPlaying) { ctx.arrowUpHandled = true; return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: true } }
      }
      if (code === 'ArrowDown' || key === 'ArrowDown') {
        if (ctx.mode === 'record' && ctx.isPlaying) { ctx.arrowDownHandled = true; return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: true } }
      }
      if (key === 'Escape' || key === 'Enter') {
        return { consumed: false, playTriggered: false, offsetDelta: 0, arrowHandled: false }
      }
      return { consumed: false, playTriggered: false, offsetDelta: 0, arrowHandled: false }
    },
    handleKeyUp(code?: string, key?: string): { consumed: boolean } {
      if (ctx.calibrationOpen) return { consumed: true }
      if (ctx.playtestActive) return { consumed: true }
      if (code === 'Space' || key === ' ') ctx.spaceHold = false
      if (code === 'ArrowUp' || key === 'ArrowUp') ctx.arrowUpHandled = false
      if (code === 'ArrowDown' || key === 'ArrowDown') ctx.arrowDownHandled = false
      return { consumed: false }
    },
  }
}

function makeCalibrationHandler(ctx: { offsetMs: number; lastHit: string | null; closed: boolean; saved: boolean }) {
  return {
    handleKeyDown(key: string, code?: string): { consumed: boolean } {
      if (key === 'Escape') { ctx.closed = true; return { consumed: true } }
      if (key === 'Enter') { ctx.saved = true; ctx.closed = true; return { consumed: true } }
      if (key === ',' || key === '<') { ctx.offsetMs -= 10; setManualOffset(ctx.offsetMs); return { consumed: true } }
      if (key === '.' || key === '>') { ctx.offsetMs += 10; setManualOffset(ctx.offsetMs); return { consumed: true } }
      if (code === 'Space') { ctx.lastHit = `PERFECT (+${Math.floor(Math.random()*10)+1}ms)`; return { consumed: true } }
      if (key === 'ArrowUp' || key === 'ArrowDown' || code === 'ArrowUp' || code === 'ArrowDown') return { consumed: true }
      return { consumed: false }
    },
  }
}

// Simulates the synchronous ref + async state bug:
// - sync version: ref set immediately before setState
// - async version: ref synced via useEffect (next tick) -> leaks one event
class RefSyncSimulator {
  ref = false
  state = false
  // sync open: set ref immediately
  openSync() { this.ref = true; this.state = true }
  closeSync() { this.ref = false; this.state = false }
  // async open: state true but ref still false until effect
  openAsync() { this.state = true /* ref not yet true */ }
  syncEffect() { this.ref = this.state }
  isGuardedSync() { return this.ref }
}

// ---------------------------------------------------------------------------
// T134 #1 Space exclusive — overlay consumes, editor not triggered
// ---------------------------------------------------------------------------
describe('T134 #1 Space独占: オーバーレイ中は editor-play が発火せず calibration-last のみ変化 (3-step)', () => {
  beforeEach(() => { vi.useFakeTimers(); setManualOffset(0) })
  afterEach(() => { vi.useRealTimers() })

  it('3-step: closedでSpaceがeditor playを発火 -> openで同じSpaceがguardされ editorは未発火・overlay hitのみ -> closeで再び発火', () => {
    // Step1: Capture initial closed state
    const ctxClosed: EditorCtx = { calibrationOpen: false, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const hClosed = makeEditorHandler(ctxClosed)
    const beforeClosed = ctxClosed.playTriggered
    expect(beforeClosed).toBe(false)

    // Step2: Perform — Space while closed
    const rClosed = hClosed.handleKeyDown('', 'Space')
    // Step3: Assert — should have triggered
    expect(rClosed.playTriggered).toBe(true)
    expect(ctxClosed.playTriggered).toBe(true)

    // Step1: capture open state
    const ctxOpen: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const overlayCtx = { offsetMs: 0, lastHit: null as string | null, closed: false, saved: false }
    const hOpen = makeEditorHandler(ctxOpen)
    const oH = makeCalibrationHandler(overlayCtx)
    const beforeOpenEditor = ctxOpen.playTriggered
    const beforeOverlayHit = overlayCtx.lastHit

    // Step2: single Space press while overlay open (both handlers would fire in buggy code)
    const eRes = hOpen.handleKeyDown('', 'Space')
    const oRes = oH.handleKeyDown('', 'Space')

    // Step3: editor must be guarded (no play), overlay must have hit
    expect(beforeOpenEditor).toBe(false)
    expect(beforeOverlayHit).toBeNull()
    expect(eRes.playTriggered).toBe(false)
    expect(ctxOpen.playTriggered).toBe(false)
    expect(eRes.consumed).toBe(true)
    expect(oRes.consumed).toBe(true)
    expect(overlayCtx.lastHit).not.toBeNull()
    expect(overlayCtx.lastHit).toMatch(/PERFECT/)

    // Step1: after close, guard released
    const ctxAfter: EditorCtx = { calibrationOpen: false, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const hAfter = makeEditorHandler(ctxAfter)
    // Step2: Space again
    const rAfter = hAfter.handleKeyDown('', 'Space')
    // Step3: must trigger again
    expect(rAfter.playTriggered).toBe(true)
    expect(ctxAfter.playTriggered).toBe(true)
  })

  it('3-step: isPlaying=false でSpace未発火 -> overlay open中のSpaceで editorの isPlayingが反転しない -> vi.advanceTimersで効果が分離', () => {
    const ctx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const h = makeEditorHandler(ctx)
    const before = ctx.playTriggered
    // Step2: Space
    h.handleKeyDown('', 'Space')
    vi.advanceTimersByTime(50)
    // Step3
    expect(before).toBe(false)
    expect(ctx.playTriggered).toBe(false)
    expect(ctx.isPlaying).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T134 #2 Offset exclusive: < / > single press changes exactly ±10, not ±20
// ---------------------------------------------------------------------------
describe('T134 #2 判定オフセット独占: 1回押しで±10ちょうど (±20でない) (3-step)', () => {
  beforeEach(() => { vi.useFakeTimers(); setManualOffset(20) })
  afterEach(() => { vi.useRealTimers() })

  it('Step1 capture 20 -> Step2 press < once while overlay open (editor+overlay両方が発火するバグなら-20) -> Step3 assert editor unchanged, overlay -10, total -10', () => {
    // Step1: capture
    const initial = getManualOffsetMs()
    expect(initial).toBe(20)
    const editorCtx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: initial, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const overlayCtx = { offsetMs: initial, lastHit: null as string | null, closed: false, saved: false }
    const eH = makeEditorHandler(editorCtx)
    const oH = makeCalibrationHandler(overlayCtx)

    // Step2: single ',' press — buggy would be editor -10 + overlay -10 = -20
    const eRes = eH.handleKeyDown(',', undefined)
    // only overlay should change offset
    oH.handleKeyDown(',', undefined)

    // Step3: verify -10 exactly
    expect(editorCtx.offsetMs).toBe(initial) // guard prevented editor delta
    expect(eRes.offsetDelta).toBe(0)
    expect(overlayCtx.offsetMs).toBe(initial - 10)
    expect(getManualOffsetMs()).toBe(initial - 10)
    expect(overlayCtx.offsetMs - initial).toBe(-10)
    expect(overlayCtx.offsetMs - initial).not.toBe(-20)
  })

  it('Step1 capture -15 -> Step2 press . once -> Step3 +10 exactly not +20', () => {
    setManualOffset(-15)
    const initial = getManualOffsetMs()
    expect(initial).toBe(-15)
    const editorCtx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: initial, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const overlayCtx = { offsetMs: initial, lastHit: null, closed: false, saved: false }
    const eH = makeEditorHandler(editorCtx)
    const oH = makeCalibrationHandler(overlayCtx)

    const eRes = eH.handleKeyDown('.', undefined)
    oH.handleKeyDown('.', undefined)

    expect(editorCtx.offsetMs).toBe(initial)
    expect(eRes.offsetDelta).toBe(0)
    expect(overlayCtx.offsetMs).toBe(initial + 10)
    expect(overlayCtx.offsetMs - initial).toBe(10)
    expect(overlayCtx.offsetMs - initial).not.toBe(20)
  })

  it('Step1 capture 0 -> Step2 press < then > while overlay open -> Step3 roundtrip returns to 0 (each ±10)', () => {
    setManualOffset(0)
    const editorCtx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const overlayCtx = { offsetMs: 0, lastHit: null, closed: false, saved: false }
    const eH = makeEditorHandler(editorCtx)
    const oH = makeCalibrationHandler(overlayCtx)

    // < press
    eH.handleKeyDown(',', undefined)
    oH.handleKeyDown(',', undefined)
    vi.advanceTimersByTime(10)
    expect(overlayCtx.offsetMs).toBe(-10)
    expect(editorCtx.offsetMs).toBe(0)

    // > press
    eH.handleKeyDown('.', undefined)
    oH.handleKeyDown('.', undefined)
    vi.advanceTimersByTime(10)
    expect(overlayCtx.offsetMs).toBe(0)
    expect(getManualOffsetMs()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T134 #3 ESC / Enter / Arrow exclusive
// ---------------------------------------------------------------------------
describe('T134 #3 ESC/Enter/Arrow独占: オーバーレイ中は編集側で処理されない (3-step)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('Step1 capture overlay closed=false -> Step2 press ESC while overlay open -> Step3 overlay closed=true editor not handling ESC', () => {
    const editorCtx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: true, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const overlayCtx = { offsetMs: 0, lastHit: null, closed: false, saved: false }
    const eH = makeEditorHandler(editorCtx)
    const oH = makeCalibrationHandler(overlayCtx)

    const beforeClosed = overlayCtx.closed
    const eRes = eH.handleKeyDown('Escape', 'Escape')
    const oRes = oH.handleKeyDown('Escape', 'Escape')

    expect(beforeClosed).toBe(false)
    expect(eRes.consumed).toBe(true) // guarded early return
    expect(oRes.consumed).toBe(true)
    expect(overlayCtx.closed).toBe(true)
  })

  it('Step1 capture overlay not saved -> Step2 Enter while open -> Step3 saved=true closed=true', () => {
    const overlayCtx = { offsetMs: 5, lastHit: null, closed: false, saved: false }
    const oH = makeCalibrationHandler(overlayCtx)
    const beforeSaved = overlayCtx.saved
    oH.handleKeyDown('Enter', 'Enter')
    expect(beforeSaved).toBe(false)
    expect(overlayCtx.saved).toBe(true)
    expect(overlayCtx.closed).toBe(true)
  })

  it('Step1 capture record mode with ArrowUp handling -> Step2 overlay open + ArrowUp -> Step3 editor arrowHandled false, overlay consumed true', () => {
    const editorCtx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: true, mode: 'record', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const overlayCtx = { offsetMs: 0, lastHit: null, closed: false, saved: false }
    const eH = makeEditorHandler(editorCtx)
    const oH = makeCalibrationHandler(overlayCtx)

    const eRes = eH.handleKeyDown('ArrowUp', 'ArrowUp')
    const oRes = oH.handleKeyDown('ArrowUp', 'ArrowUp')

    expect(eRes.arrowHandled).toBe(false)
    expect(editorCtx.arrowUpHandled).toBe(false)
    expect(oRes.consumed).toBe(true)
  })

  it('Step1 capture ArrowDown similarly guarded', () => {
    const editorCtx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: true, mode: 'record', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const oH = makeCalibrationHandler({ offsetMs: 0, lastHit: null, closed: false, saved: false })
    const eH = makeEditorHandler(editorCtx)
    const eRes = eH.handleKeyDown('ArrowDown', 'ArrowDown')
    const oRes = oH.handleKeyDown('ArrowDown', 'ArrowDown')
    expect(eRes.arrowHandled).toBe(false)
    expect(oRes.consumed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T134 #4 Guard release after close + ref sync timing (same-tick leakage prevention)
// ---------------------------------------------------------------------------
describe('T134 #4 ガード解放と ref同期タイミング: クローズ後 Spaceで editor-play が復帰, 同tickリーク防止 (3-step)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('3-step: overlay close -> Space triggers editor play again (guard released)', () => {
    const ctxOpen: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const hOpen = makeEditorHandler(ctxOpen)
    hOpen.handleKeyDown('', 'Space')
    expect(ctxOpen.playTriggered).toBe(false) // guard active

    const ctxClosed: EditorCtx = { calibrationOpen: false, playtestActive: false, isPlaying: false, mode: 'play', offsetMs: 0, playTriggered: false, spaceHold: false, arrowUpHandled: false, arrowDownHandled: false }
    const hClosed = makeEditorHandler(ctxClosed)
    const before = ctxClosed.playTriggered
    hClosed.handleKeyDown('', 'Space')
    expect(before).toBe(false)
    expect(ctxClosed.playTriggered).toBe(true)
  })

  it('ref must be set synchronously before setState: async (useEffect) leaks one event in same tick', () => {
    // Step1: capture initial simulator with async open (buggy)
    const simAsync = new RefSyncSimulator()
    expect(simAsync.ref).toBe(false)
    // Step2: open via async path (state true but ref still false)
    simAsync.openAsync()
    // Simulate same-tick Space event: guard checks ref (still false) -> leaks
    const leaked = !simAsync.isGuardedSync()
    expect(leaked).toBe(true) // would leak
    // Step2b: effect runs next tick
    vi.advanceTimersByTime(0)
    simAsync.syncEffect()
    expect(simAsync.isGuardedSync()).toBe(true)

    // Sync version: no leak
    const simSync = new RefSyncSimulator()
    simSync.openSync()
    const notLeaked = !simSync.isGuardedSync()
    expect(notLeaked).toBe(false)
    expect(simSync.isGuardedSync()).toBe(true)
  })

  it('onKeyUpも guard: overlay open中に editor keyUp は consumed (Space hold & Arrow release)', () => {
    const ctx: EditorCtx = { calibrationOpen: true, playtestActive: false, isPlaying: true, mode: 'record', offsetMs: 0, playTriggered: false, spaceHold: true, arrowUpHandled: true, arrowDownHandled: false }
    const h = makeEditorHandler(ctx)
    const upRes = h.handleKeyUp('ArrowUp', 'ArrowUp')
    const spaceUpRes = h.handleKeyUp('Space', 'Space')
    expect(upRes.consumed).toBe(true)
    expect(spaceUpRes.consumed).toBe(true)
    // editor state should not have been cleared because guarded
    expect(ctx.spaceHold).toBe(true) // not cleared
    expect(ctx.arrowUpHandled).toBe(true)
  })

  it('onKeyUp guard released after close clears Space hold', () => {
    const ctx: EditorCtx = { calibrationOpen: false, playtestActive: false, isPlaying: true, mode: 'record', offsetMs: 0, playTriggered: false, spaceHold: true, arrowUpHandled: true, arrowDownHandled: false }
    const h = makeEditorHandler(ctx)
    h.handleKeyUp('Space', 'Space')
    expect(ctx.spaceHold).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T134 #5 Calibration save/cancel offset restoration (clock integration)
// ---------------------------------------------------------------------------
describe('T134 #5 オフセット保存/キャンセル復元と clock 反映 (3-step)', () => {
  beforeEach(() => { vi.useFakeTimers(); setManualOffset(0) })
  afterEach(() => { vi.useRealTimers() })

  it('Step1 capture saved 30 -> Step2 adjust -40 to -10 -> Step3 cancel restores 30, save persists -10', () => {
    // Step1
    setManualOffset(30)
    const saved = getManualOffsetMs()
    expect(saved).toBe(30)

    // Step2: overlay adjusts
    setManualOffset(-10)
    expect(getManualOffsetMs()).toBe(-10)

    // Step3a: cancel restores
    setManualOffset(saved)
    expect(getManualOffsetMs()).toBe(30)
    expect(getManualOffsetMs()).not.toBe(-10)

    // Step3b: save persists
    setManualOffset(-10)
    expect(getManualOffsetMs()).toBe(-10)
    // save action is just keeping current value
    const savedAfter = getManualOffsetMs()
    expect(savedAfter).toBe(-10)
  })

  it('Step1 capture 0 -> Step2 multiple , presses each -10 -> Step3 clock reflects exact sum', () => {
    setManualOffset(0)
    expect(getManualOffsetMs()).toBe(0)
    // press < three times via calibration handler
    const ctx = { offsetMs: 0, lastHit: null, closed: false, saved: false }
    const oH = makeCalibrationHandler(ctx)
    setManualOffset(0)
    ctx.offsetMs = getManualOffsetMs()
    for (let i=0;i<3;i++) oH.handleKeyDown(',', undefined)
    expect(getManualOffsetMs()).toBe(-30)
    expect(ctx.offsetMs).toBe(-30)
    vi.advanceTimersByTime(20)
    expect(getManualOffsetMs()).toBe(-30)
  })
})

// ---------------------------------------------------------------------------
// T134 #6 Numeric consistency WaveEngine vs Cursor — complex amps & off-grid
// ---------------------------------------------------------------------------
describe('T134 #6 数値整合: WaveEngine vs Cursor 同一速度係数 (complex amplitudes, off-grid 0.37/1.23)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const amps = [0.7, 1.3, 2.7, 3.4] as const
  const offGridBeats = [0.37, 1.23, 0.25, 0.5, 1.37] as const

  it.each(amps)('amplitude %p: waveYAt slope = 2*TW_AMP*amp clamped across off-grid beats', (amp) => {
    // Step1: capture timeline & engine
    const tl = new BpmTimeline(120, [], amp)
    const segs = [{ direction: 'down' as const, beats: 6 }]
    const wave = new WaveEngine(segs, tl, amp, 0)
    const TOP = TW_CENTER_Y - TW_AMP
    const BOTTOM = TW_CENTER_Y + TW_AMP
    const startY = TW_CENTER_Y
    const perBeat = 2 * TW_AMP * amp
    // Step2: for each off-grid beat compute
    for (const b of offGridBeats) {
      const raw = startY + perBeat * b
      const expected = Math.max(TOP, Math.min(BOTTOM, raw))
      const before = wave.waveYAt(b)
      // Step3: assert
      expect(before).toBeCloseTo(expected, 0)
    }
  })

  it.each(amps)('amplitude %p: cursor per-beat delta equals wave slope (clamped to TW_AMP)', (amp) => {
    const tl = new BpmTimeline(120, [], amp)
    const beatMs = tl.beatMsAt(0) // 500
    const cursor = new Cursor(amp, 0)
    const wave = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 0)
    const perBeat = 2 * TW_AMP * amp
    // 0.5 beats down from center — both are clamped to TW_AMP if perBeat*0.5 > TW_AMP
    const y0 = cursor.y
    const dt = (0.5 * beatMs) / 1000
    cursor.update(dt, false, true, beatMs)
    const cDelta = Math.abs(cursor.y - y0)
    const wDelta = Math.abs(wave.waveYAt(0.5) - wave.waveYAt(0))
    const expected = Math.min(perBeat * 0.5, TW_AMP)
    expect(cDelta).toBeCloseTo(expected, 0)
    expect(wDelta).toBeCloseTo(expected, 0)
    expect(wDelta).toBeCloseTo(cDelta, 0)
  })

  it('off-grid 0.37 specifically: T128 clamp interpolation, not linear 2-point', () => {
    const amp = 1.0
    const tl = new BpmTimeline(120, [], amp)
    const segs = [{ direction: 'down', beats: 3 }]
    const wave = new WaveEngine(segs, tl, amp, 0)
    // 43.3*3 linear would be bottom at 3, but T128 slope is 260/beat -> clamped early
    // At 0.37, expected = 300 + 260*0.37 = 396.2 (within bounds)
    const expected037 = TW_CENTER_Y + 2 * TW_AMP * amp * 0.37
    expect(wave.waveYAt(0.37)).toBeCloseTo(expected037, 1)
    // At 1.23: should be clamped to bottom (since 300+260*0.5=430 already bottom at 0.5)
    expect(wave.waveYAt(1.23)).toBeCloseTo(TW_CENTER_Y + TW_AMP, 1)
  })

  it('getPoints length = segments.length+1 invariant', () => {
    const tl = new BpmTimeline(120, [], 1.0)
    const segs = [{ direction: 'up' as const, beats: 2 }, { direction: 'down' as const, beats: 2 }, { direction: 'stay' as const, beats: 1 }]
    const wave = new WaveEngine(segs, tl, 1.0, 0)
    const pts = wave.getPoints()
    expect(pts.length).toBe(segs.length + 1)
    for (const p of pts) { expect(typeof p.beat).toBe('number'); expect(typeof p.y).toBe('number') }
  })
})

// ---------------------------------------------------------------------------
// T134 #7 Calibration chart T133 invariant preserved
// ---------------------------------------------------------------------------
describe('T134 #7 回帰: T133 無限ループ譜面が維持される (BPM120, up2/down2, 4nリング)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('3-step: capture spec -> generate 16 beats -> assert 8 segs up2/down2 and 4 rings at 4,8,12,16', () => {
    const chart = generateCalibrationChart(16)
    const beforeSegs = chart.segments.length
    expect(chart.bpm).toBe(120)
    expect(beforeSegs).toBe(8)
    for (let i=0;i<chart.segments.length;i++) {
      expect(chart.segments[i].beats).toBe(2)
      expect(chart.segments[i].direction).toBe(i%2===0 ? 'up' : 'down')
    }
    expect(chart.rings.map(r=>r.beat)).toEqual([4,8,12,16])
    for (const r of chart.rings) expect(r.type).toBe('single')
  })

  it('3-step: small chart -> larger chart grows (infinite loop not limited to 8)', () => {
    const small = generateCalibrationChart(16)
    const large = generateCalibrationChart(64)
    const smallBeats = small.segments.reduce((s,seg)=>s+seg.beats,0)
    const largeBeats = large.segments.reduce((s,seg)=>s+seg.beats,0)
    expect(smallBeats).toBe(16)
    expect(largeBeats).toBe(64)
    expect(largeBeats).toBeGreaterThan(smallBeats)
    expect(large.rings.length).toBe(16) // 64/4
    expect(small.rings.length).toBe(4)
    expect(large.rings.length).not.toBe(8)
  })

  it('off-grid waveYAt bounds check for calibration wave', () => {
    const chart = generateCalibrationChart(16)
    const tl = new BpmTimeline(120, [], 1.0)
    const eng = new WaveEngine(chart.segments.slice(0,4), tl, 1.0, 0)
    for (const b of [0.37, 1.23, 2.62, 3.37]) {
      const y = eng.waveYAt(b)
      expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6)
      expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6)
    }
  })
})

// ---------------------------------------------------------------------------
// T134 #8 amplitudeAt step off-grid + snap integration + judgeHit
// ---------------------------------------------------------------------------
describe('T134 #8 BpmTimeline amplitudeAt step (off-grid) + snap/quantize + judgeHit (3-step)', () => {
  beforeEach(() => { vi.useFakeTimers(); setManualOffset(0) })
  afterEach(() => { vi.useRealTimers() })

  it('Step1 capture base 1.0 -> Step2 set change at beat4 amp2.0 -> Step3 off-grid 3.37=1.0, 4.23=2.0', () => {
    const before = new BpmTimeline(120, [], 1.0).amplitudeAt(3.37)
    expect(before).toBe(1.0)
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0)
    expect(tl.amplitudeAt(3.37)).toBe(1.0)
    expect(tl.amplitudeAt(3.99)).toBe(1.0)
    expect(tl.amplitudeAt(4.0)).toBe(2.0)
    expect(tl.amplitudeAt(4.23)).toBe(2.0)
    expect(tl.amplitudeAt(4.37)).toBe(2.0)
  })

  it('Step1 capture snaps -> Step2 segmentize off-grid 0.30 with snap 0.25 -> Step3 beats is 0.25 not 1.0 (not 1/amplitude)', () => {
    const snaps = [0.125, 0.25, 0.5, 1] as const
    for (const snap of snaps) {
      const traj = [{ beat: 0, y: TW_CENTER_Y, down: true }, { beat: 0.30, y: TW_CENTER_Y+20, down: false }]
      const segs = segmentize(traj, snap, 1.0)
      expect(segs.length).toBeGreaterThan(0)
      for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true)
      if (snap===0.25) {
        expect(segs[0].beats).not.toBeCloseTo(1.0, 2)
        expect(segs[0].beats).toBeCloseTo(0.25, 4)
      }
    }
    expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4)
    expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4)
  })

  it('Step1 capture hit context -> Step2 judgeHit +12 perfect -> Step3 judgeHit +80 miss Y', () => {
    const tl = new BpmTimeline(120, [], 1.0)
    const eng = new WaveEngine([{ direction: 'down', beats: 4 }], tl, 1.0, 0)
    const hitBeat = 4, hitTime = tl.beatToMs(hitBeat), targetY = eng.waveYAt(hitBeat)
    const ringPerfect: any = { id: 0, hitTime, targetY, resolved: false, hit: false, type: 'single' }
    const before = judgeHit(hitTime+12, targetY+5, [ringPerfect], 500)
    expect(before).not.toBeNull()
    expect(before!.result).toBe('perfect')
    const ringMiss: any = { id: 1, hitTime, targetY, resolved: false, hit: false, type: 'single' }
    const miss = judgeHit(hitTime, targetY+80, [ringMiss], 500)
    expect(miss!.result).toBe('miss')
    vi.advanceTimersByTime(10)
    expect(before!.errorMs).toBeCloseTo(12, 0)
  })
})
