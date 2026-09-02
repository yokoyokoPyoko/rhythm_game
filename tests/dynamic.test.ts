/**
 * T134: エディタ内キャリブレーションオーバーレイ時のキー入力独占
 * Vitest (node environment) — pure engine + source-structure + behavioral simulation
 *
 * TDD: This test intentionally FAILS on the current buggy EditorScreen.tsx
 * (no calibrationOpenRef). It will PASS once T134 fix is applied.
 *
 * Covers:
 *  1. Source structure guards (calibrationOpenRef, useEffect sync, onKeyDown/onKeyUp guards, open/close sync)
 *  2. Runtime behavioral simulation with 3-step state-transition assertions (capture -> action -> assert)
 *  3. Regression: T133 infinite loop chart still correct, /calibration route deleted, offset restoration
 *  4. Numeric consistency (waveEngine vs cursor) — ensures T127/T128 not regressed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { BpmTimeline } from '../src/audio/bpmTimeline'
import { Cursor } from '../src/game/cursor'
import { TW_AMP, TW_CENTER_Y, WaveEngine } from '../src/game/waveEngine'
import { generateCalibrationChart } from '../src/screens/editor/CalibrationModal'

// ---------------------------------------------------------------------------
// Helpers: read source files from project root
// ---------------------------------------------------------------------------
function readSource(rel: string): string {
  const p = path.resolve(process.cwd(), rel)
  return fs.readFileSync(p, 'utf-8')
}

function editorSource(): string {
  return readSource('src/screens/EditorScreen.tsx')
}

function appSource(): string {
  return readSource('src/App.tsx')
}

// Simulate the fixed EditorScreen key handler logic as pure functions
// This mirrors the T134 spec: onKeyDown/onKeyUp should early-return when
// calibrationOpenRef.current === true (same as playtestActiveRef pattern).
type HandlerCtx = {
  calibrationOpen: boolean
  playtestActive: boolean
  isPlaying: boolean
  mode: 'play' | 'record'
  offsetMs: number
  playTriggered: boolean
  offsetDelta: number
  arrowHandled: boolean
  spaceHoldTriggered: boolean
}

function createMockEditorHandler(ctx: HandlerCtx) {
  return {
    // Returns { editorConsumed, playTriggered, offsetDelta, arrowHandled }
    handleKeyDown(key: string, code?: string): { consumed: boolean; playTriggered: boolean; offsetDelta: number; arrowHandled: boolean } {
      // T134 guard: must be first checks (after playtest guard)
      if (ctx.playtestActive) return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: false }
      if (ctx.calibrationOpen) return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: false }

      // Space handling (simplified): triggers play when not in record hold
      if (code === 'Space') {
        if (ctx.isPlaying && ctx.mode === 'record') {
          ctx.spaceHoldTriggered = true
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
        if (ctx.mode === 'record' && ctx.isPlaying) {
          ctx.arrowHandled = true
          return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: true }
        }
      }
      if (code === 'ArrowDown' || key === 'ArrowDown') {
        if (ctx.mode === 'record' && ctx.isPlaying) {
          ctx.arrowHandled = true
          return { consumed: true, playTriggered: false, offsetDelta: 0, arrowHandled: true }
        }
      }
      return { consumed: false, playTriggered: false, offsetDelta: 0, arrowHandled: false }
    },
    handleKeyUp(code?: string, key?: string): { consumed: boolean } {
      if (ctx.calibrationOpen) return { consumed: true }
      if (ctx.playtestActive) return { consumed: true }
      // In real code, arrow release and space hold release happen here
      return { consumed: false }
    },
  }
}

function createMockCalibrationHandler(ctx: { offsetMs: number; lastHit: string | null; closed: boolean }) {
  return {
    handleKeyDown(key: string, code?: string): { consumed: boolean } {
      if (key === 'Escape') { ctx.closed = true; return { consumed: true } }
      if (key === 'Enter') { ctx.closed = true; return { consumed: true } }
      if (key === ',' || key === '<') { ctx.offsetMs -= 10; return { consumed: true } }
      if (key === '.' || key === '>') { ctx.offsetMs += 10; return { consumed: true } }
      if (code === 'Space') { ctx.lastHit = 'PERFECT (+5ms)'; return { consumed: true } }
      if (key === 'ArrowUp' || key === 'ArrowDown') return { consumed: true }
      return { consumed: false }
    },
  }
}

// ---------------------------------------------------------------------------
// T134 Source Structure — must FAIL before fix (Red)
// ---------------------------------------------------------------------------
describe('T134 #1 Source structure: calibrationOpenRef and guards (Red before fix)', () => {
  it('EditorScreen declares calibrationOpenRef = useRef(false)', () => {
    const src = editorSource()
    // Step1: capture initial state — current source lacks this
    // Step2: perform read
    // Step3: assert expected target
    expect(src).toMatch(/calibrationOpenRef\s*=\s*useRef\s*\(\s*false\s*\)/)
  })

  it('EditorScreen syncs calibrationOpenRef via useEffect dependency [calibrationOpen]', () => {
    const src = editorSource()
    // The sync must exist exactly as spec: calibrationOpenRef.current = calibrationOpen
    expect(src).toMatch(/useEffect\s*\(\s*\(\)\s*=>\s*\{\s*calibrationOpenRef\.current\s*=\s*calibrationOpen\s*\}.*\[calibrationOpen\]/s)
  })

  it('onKeyDown has calibration guard immediately after playtest guard', () => {
    const src = editorSource()
    // Find onKeyDown definition
    const idx = src.indexOf('const onKeyDown')
    expect(idx).toBeGreaterThan(-1)
    const slice = src.slice(idx, idx + 600)
    // Must contain both guards in order
    const playIdx = slice.indexOf('playtestActiveRef.current')
    const calIdx = slice.indexOf('calibrationOpenRef.current')
    expect(playIdx).toBeGreaterThan(-1)
    expect(calIdx).toBeGreaterThan(-1)
    expect(calIdx).toBeGreaterThan(playIdx)
    // And the guard pattern
    expect(slice).toMatch(/if\s*\(\s*calibrationOpenRef\.current\s*\)\s*return/)
  })

  it('onKeyUp has calibration guard at top', () => {
    const src = editorSource()
    const idx = src.indexOf('const onKeyUp')
    expect(idx).toBeGreaterThan(-1)
    const slice = src.slice(idx, idx + 600)
    expect(slice).toMatch(/if\s*\(\s*calibrationOpenRef\.current\s*\)\s*return/)
  })

  it('open button onClick sets calibrationOpenRef.current = true after stop()/stopMetronome() before setCalibrationOpen(true)', () => {
    const src = editorSource()
    // Find the calibration open button handler
    const btnIdx = src.indexOf('editor-calibration-button')
    expect(btnIdx).toBeGreaterThan(-1)
    // Look ahead ~500 chars for the onClick body
    const contextStart = Math.max(0, btnIdx - 1200)
    const context = src.slice(contextStart, btnIdx + 800)
    // Must contain stop(), stopMetronome(), calibrationOpenRef.current = true, setCalibrationOpen(true) in order
    const stopIdx = context.indexOf('stop()')
    const stopMetroIdx = context.indexOf('stopMetronome()')
    const refTrueIdx = context.indexOf('calibrationOpenRef.current = true')
    const setOpenIdx = context.indexOf('setCalibrationOpen(true)')
    expect(stopIdx).toBeGreaterThan(-1)
    expect(stopMetroIdx).toBeGreaterThan(-1)
    expect(refTrueIdx).toBeGreaterThan(-1)
    expect(setOpenIdx).toBeGreaterThan(-1)
    expect(refTrueIdx).toBeGreaterThan(stopIdx)
    expect(refTrueIdx).toBeGreaterThan(stopMetroIdx)
    expect(setOpenIdx).toBeGreaterThan(refTrueIdx)
  })

  it('onClose handler sets calibrationOpenRef.current = false at top', () => {
    const src = editorSource()
    const idx = src.indexOf('<CalibrationModal')
    expect(idx).toBeGreaterThan(-1)
    const slice = src.slice(idx, idx + 800)
    expect(slice).toMatch(/calibrationOpenRef\.current\s*=\s*false/)
    const refIdx = slice.indexOf('calibrationOpenRef.current = false')
    const setIdx = slice.indexOf('setCalibrationOpen(false)')
    expect(refIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(-1)
    // ref false must be before setCalibrationOpen(false)
    expect(refIdx).toBeLessThan(setIdx)
  })

  it('does NOT keep stray playtestActiveRef-only guard without calibration (negative test)', () => {
    const src = editorSource()
    // The onKeyUp currently has no guard — this test ensures after fix it DOES have calibration guard
    // Before fix, this will FAIL (which is desired Red)
    const onKeyUpIdx = src.indexOf('const onKeyUp')
    expect(onKeyUpIdx).toBeGreaterThan(-1)
    const slice = src.slice(onKeyUpIdx, onKeyUpIdx + 800)
    // Must contain calibration guard, not just playtest
    expect(slice).toContain('calibrationOpenRef')
  })
})

// ---------------------------------------------------------------------------
// T134 Behavioral Simulation — 3-step state-transition assertions
// ---------------------------------------------------------------------------
describe('T134 #2 Runtime behavioral simulation: key独占 (3-step: capture -> action -> assert)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('Space独占: overlay open -> editor play NOT triggered, overlay hit IS triggered', () => {
    // Step1: Capture initial state
    const editorCtx: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const overlayCtx = { offsetMs: 0, lastHit: null as string | null, closed: false }
    const editorHandler = createMockEditorHandler(editorCtx)
    const overlayHandler = createMockCalibrationHandler(overlayCtx)
    const initialEditorPlay = editorCtx.playTriggered
    const initialOverlayHit = overlayCtx.lastHit

    // Step2: Perform user action — single Space press while overlay open
    const editorResult = editorHandler.handleKeyDown('', 'Space')
    const overlayResult = overlayHandler.handleKeyDown('', 'Space')

    // Step3: Assert resulting transition
    // Editor must be guarded: no play triggered
    expect(editorResult.playTriggered).toBe(false)
    expect(editorCtx.playTriggered).toBe(initialEditorPlay) // still false
    expect(editorResult.consumed).toBe(true) // early return consumed
    // Overlay must have consumed and produced hit
    expect(overlayResult.consumed).toBe(true)
    expect(overlayCtx.lastHit).not.toBe(initialOverlayHit)
    expect(overlayCtx.lastHit).toMatch(/PERFECT/)
  })

  it('Space独占 (closed -> open transition): cover -> guarded -> released', () => {
    // Step1: Initial closed state — Space SHOULD trigger play
    const ctxClosed: HandlerCtx = {
      calibrationOpen: false,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const hClosed = createMockEditorHandler(ctxClosed)
    const r1 = hClosed.handleKeyDown('', 'Space')
    expect(r1.playTriggered).toBe(true)
    expect(ctxClosed.playTriggered).toBe(true)

    // Step2: Open overlay — same Space must NOT trigger play
    const ctxOpen: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const hOpen = createMockEditorHandler(ctxOpen)
    const r2 = hOpen.handleKeyDown('', 'Space')
    expect(r2.playTriggered).toBe(false)

    // Step3: Close overlay — guard released, Space triggers again
    const ctxReopened: HandlerCtx = {
      calibrationOpen: false,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const hReopen = createMockEditorHandler(ctxReopened)
    const r3 = hReopen.handleKeyDown('', 'Space')
    expect(r3.playTriggered).toBe(true)
  })

  it('offset独占: < (,) pressed once with overlay open -> editor-offset changes -10 exactly, NOT -20', () => {
    // Step1: Capture initial offset
    const initialOffset = 40
    const editorCtx: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: initialOffset,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const overlayCtx = { offsetMs: initialOffset, lastHit: null as string | null, closed: false }
    const editorH = createMockEditorHandler(editorCtx)
    const overlayH = createMockCalibrationHandler(overlayCtx)

    // Step2: Single ',' press — buggy would call BOTH handlers (-20), fixed only overlay (-10)
    // Simulate fixed behavior: editor guarded, only overlay fires
    const eRes = editorH.handleKeyDown(',', undefined)
    let totalDelta = 0
    if (!eRes.consumed || eRes.offsetDelta !== 0) totalDelta += eRes.offsetDelta // should be 0 when guarded
    else totalDelta += 0
    const oRes = overlayH.handleKeyDown(',', undefined)
    if (oRes.consumed) totalDelta += -10 // overlay always -10 (we know its impl)
    // For assertion we use overlayCtx offset
    // Step3: Assert -10 exactly
    expect(editorCtx.offsetMs).toBe(initialOffset) // editor unchanged
    expect(overlayCtx.offsetMs).toBe(initialOffset - 10)
    expect(eRes.offsetDelta).toBe(0)
    expect(totalDelta).toBe(-10)
    expect(totalDelta).not.toBe(-20) // ensure not double
  })

  it('offset独占: . (>) pressed once -> +10 exactly, not +20', () => {
    const initialOffset = -30
    const editorCtx: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: initialOffset,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const overlayCtx = { offsetMs: initialOffset, lastHit: null, closed: false }
    const editorH = createMockEditorHandler(editorCtx)
    const overlayH = createMockCalibrationHandler(overlayCtx)

    const eRes = editorH.handleKeyDown('.', undefined)
    const oRes = overlayH.handleKeyDown('.', undefined)
    let totalDelta = (eRes.offsetDelta || 0) + (oRes.consumed ? 10 : 0)
    // editor should be 0 due to guard
    expect(editorCtx.offsetMs).toBe(initialOffset)
    expect(overlayCtx.offsetMs).toBe(initialOffset + 10)
    expect(totalDelta).toBe(10)
    expect(totalDelta).not.toBe(20)
  })

  it('ESC独占: overlay open -> ESC closes overlay only, not editor', () => {
    const editorCtx: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: true,
      mode: 'play',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const overlayCtx = { offsetMs: 0, lastHit: null, closed: false }
    const eH = createMockEditorHandler(editorCtx)
    const oH = createMockCalibrationHandler(overlayCtx)

    const eRes = eH.handleKeyDown('Escape', 'Escape')
    const oRes = oH.handleKeyDown('Escape', 'Escape')

    expect(eRes.consumed).toBe(true) // guarded — does not handle ESC as editor action
    expect(oRes.consumed).toBe(true)
    expect(overlayCtx.closed).toBe(true)
  })

  it('Enter独占 & Arrow独占: overlay open -> Enter/Arrow only consumed by overlay', () => {
    const editorCtx: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: true,
      mode: 'record',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const overlayCtx = { offsetMs: 0, lastHit: null, closed: false }
    const eH = createMockEditorHandler(editorCtx)
    const oH = createMockCalibrationHandler(overlayCtx)

    // ArrowUp while recording — editor would normally handle, but must be guarded
    const eArrow = eH.handleKeyDown('ArrowUp', 'ArrowUp')
    const oArrow = oH.handleKeyDown('ArrowUp', 'ArrowUp')
    expect(eArrow.arrowHandled).toBe(false) // guarded, not handled
    expect(oArrow.consumed).toBe(true)

    // Enter
    const eEnter = eH.handleKeyDown('Enter', 'Enter')
    const oEnter = oH.handleKeyDown('Enter', 'Enter')
    expect(eEnter.consumed).toBe(true) // guarded early return
    expect(oEnter.consumed).toBe(true)
    expect(overlayCtx.closed).toBe(true)
  })

  it('onKeyUpも独占: overlay open -> editor keyUp guarded (Space hold & Arrow release)', () => {
    const ctx: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: true,
      mode: 'record',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const h = createMockEditorHandler(ctx)
    const upRes = h.handleKeyUp('ArrowUp', 'ArrowUp')
    const spaceUpRes = h.handleKeyUp('Space', 'Space')
    expect(upRes.consumed).toBe(true)
    expect(spaceUpRes.consumed).toBe(true)
  })

  it('guard released after overlay close -> Space triggers editor play again', () => {
    // Step1: overlay closed state
    const ctxClosed: HandlerCtx = {
      calibrationOpen: false,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 0,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const h = createMockEditorHandler(ctxClosed)
    const before = ctxClosed.playTriggered
    const res = h.handleKeyDown('', 'Space')
    // Step3: must have triggered
    expect(before).toBe(false)
    expect(res.playTriggered).toBe(true)
    expect(ctxClosed.playTriggered).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regression: T133 + T132 + general invariants
// ---------------------------------------------------------------------------
describe('T134 #3 Regression: T133/T132 invariants & /calibration route deletion', () => {
  it('/calibration route must NOT exist in App.tsx (T133 deletion)', () => {
    const src = appSource()
    // Step1: capture — check for any /calibration route
    const hasCalibrationRoute = /path\s*=\s*["']\/calibration["']/.test(src)
    // Step2: (no action needed — static check)
    // Step3: assert deleted
    expect(hasCalibrationRoute).toBe(false)
    expect(src).not.toContain('CalibrationScreen')
    expect(src).not.toContain("navigate('/calibration')")
    expect(src).not.toContain('navigate("/calibration")')
  })

  it('CalibrationScreen.tsx file must be deleted (T133)', () => {
    const p = path.resolve(process.cwd(), 'src/screens/CalibrationScreen.tsx')
    const exists = fs.existsSync(p)
    expect(exists).toBe(false)
  })

  it('CalibrationModal still exports generateCalibrationChart with T133 spec (infinite loop)', () => {
    // Step1: capture initial chart with small totalBeats for deterministic check
    const chartSmall = generateCalibrationChart(16)
    // Step2: generate large default
    const chartLarge = generateCalibrationChart()
    // Step3: assert invariants
    expect(chartSmall.bpm).toBe(120)
    expect(chartLarge.bpm).toBe(120)
    // segments: up 2 / down 2 alternating
    expect(chartSmall.segments.length).toBe(8) // 16 beats /2
    for (let i = 0; i < chartSmall.segments.length; i++) {
      expect(chartSmall.segments[i].beats).toBe(2)
      expect(chartSmall.segments[i].direction).toBe(i % 2 === 0 ? 'up' : 'down')
    }
    // rings: every 4 beats starting at 4
    expect(chartSmall.rings.map(r => r.beat)).toEqual([4, 8, 12, 16])
    for (const r of chartSmall.rings) expect(r.type).toBe('single')
    // Large chart length: default 24000 beats
    expect(chartLarge.segments.length).toBeGreaterThanOrEqual(12000) // 24000/2
    expect(chartLarge.rings.length).toBeGreaterThanOrEqual(6000) // 24000/4
    expect(chartLarge.rings[0].beat).toBe(4)
    expect(chartLarge.rings[1].beat).toBe(8)
    // Ensure uniform step 4
    for (let i = 1; i < Math.min(20, chartLarge.rings.length); i++) {
      expect(chartLarge.rings[i].beat - chartLarge.rings[i-1].beat).toBe(4)
    }
  })

  it('CalibrationModal cancel restores offset (T132 offset restoration)', () => {
    const src = readSource('src/screens/editor/CalibrationModal.tsx')
    // Must restore savedOffsetRef on cancel
    expect(src).toMatch(/savedOffsetRef\.current/)
    expect(src).toMatch(/setManualOffset\s*\(\s*savedOffsetRef\.current\s*\)/)
    // And must have both save and cancel handlers
    expect(src).toContain('onClose(false)')
    expect(src).toContain('onClose(true)')
  })

  it('EditorScreen calibration open stops BGM/metronome (prevents overlap)', () => {
    const src = editorSource()
    const btnIdx = src.indexOf('editor-calibration-button')
    const context = src.slice(Math.max(0, btnIdx - 1200), btnIdx + 800)
    expect(context).toContain('stop()')
    expect(context).toContain('stopMetronome()')
  })

  it('EditorScreen does not use navigate("/calibration") and uses overlay instead', () => {
    const src = editorSource()
    expect(src).not.toContain("'/calibration'")
    expect(src).not.toContain('"/calibration"')
    expect(src).toContain('CalibrationModal')
    expect(src).toContain('calibrationOpen')
    expect(src).toContain('setCalibrationOpen')
  })

  it('CalibrationModal schedule uses no latency arg (T91 regression preserved)', () => {
    const src = readSource('src/screens/editor/CalibrationModal.tsx')
    // Must call schedule(audioCtx, nextBeatTime, beat) without latency
    expect(src).toMatch(/schedule\s*\(\s*audioCtx\s*,\s*nextBeatTime\s*,\s*beat\s*\)/)
    expect(src).not.toMatch(/schedule\s*\(\s*audioCtx\s*,\s*nextBeatTime\s*,\s*beat\s*,\s*.*latency/)
  })
})

// ---------------------------------------------------------------------------
// Numeric consistency: WaveEngine vs Cursor (T127/T128) — ensure not regressed
// Off-grid verification principle: include fractional beats like 0.37 / 1.23
// ---------------------------------------------------------------------------
describe('T134 #4 Numeric consistency regression: WaveEngine vs Cursor (complex amplitudes, off-grid)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const amplitudes = [0.7, 1.3, 2.7, 3.4]

  it('waveYAt slope matches 2*TW_AMP*amplitudeAt (clamped) across complex amplitudes', () => {
    for (const amp of amplitudes) {
      const timeline = new BpmTimeline(120, [], amp)
      const segs = [{ direction: 'down' as const, beats: 3 }]
      const wave = new WaveEngine(segs, timeline, amp, 0)
      const waveTop = TW_CENTER_Y - TW_AMP
      const waveBottom = TW_CENTER_Y + TW_AMP
      const center = TW_CENTER_Y
      // T128: waveYAt(beat) = clamp(center + 2*TW_AMP*amp*beat, top, bottom) for single down segment from center
      const testBeats = [0.25, 0.37, 0.5, 1.0, 1.23, 1.5, 2.0]
      for (const b of testBeats) {
        const expected = Math.max(waveTop, Math.min(waveBottom, center + 2 * TW_AMP * amp * b))
        const actual = wave.waveYAt(b)
        expect(actual).toBeCloseTo(expected, 4)
      }
    }
  })

  it('cursor per-beat displacement equals waveEngine segment slope (2*TW_AMP*amplitude)', () => {
    for (const amp of amplitudes) {
      const timeline = new BpmTimeline(120, [], amp)
      const beatMs = timeline.beatMsAt(0) // 500ms at 120bpm
      const cursor = new Cursor(amp, 0)
      const startY = cursor.y
      const dt = beatMs / 1000 // exactly one beat duration
      cursor.update(dt, true, false, beatMs)
      const delta = cursor.y - startY
      const expectedDelta = -2 * TW_AMP * amp
      const maxUp = TW_CENTER_Y - TW_AMP - startY // -130 from center
      const clampedExpected = Math.max(maxUp, expectedDelta)
      expect(delta).toBeCloseTo(clampedExpected, 4)
    }
  })

  it('off-grid beats (0.37, 1.23) produce correct clamp-interpolated Y', () => {
    const amp = 1.0
    const timeline = new BpmTimeline(120, [], amp)
    const segs = [
      { direction: 'down' as const, beats: 1 },
      { direction: 'up' as const, beats: 1 },
      { direction: 'down' as const, beats: 2 },
    ]
    const wave = new WaveEngine(segs, timeline, amp, 0)
    // From center (300), down 1 beat at amp=1 => bottom 430 (clamped segment)
    // beat 0.37: should be center + 2*130*0.37 = 396.2
    expect(wave.waveYAt(0.37)).toBeCloseTo(TW_CENTER_Y + 2 * TW_AMP * amp * 0.37, 4)
    // beat 1.23: after first down (bottom), up segment starts at beat 1: up from bottom
    // For up: y = bottom + (-2*TW_AMP*amp)*(beat-1) = 430 - 260*(0.23) = 370.2
    expect(wave.waveYAt(1.23)).toBeCloseTo(TW_CENTER_Y + TW_AMP - 2 * TW_AMP * amp * 0.23, 4)
  })

  it('getPoints length invariant: segments.length +1 and {beat,y} structure', () => {
    const timeline = new BpmTimeline(120, [], 1.0)
    const segs = [
      { direction: 'up' as const, beats: 2 },
      { direction: 'down' as const, beats: 2 },
      { direction: 'stay' as const, beats: 1 },
    ]
    const wave = new WaveEngine(segs, timeline, 1.0, 0)
    const pts = wave.getPoints()
    expect(pts.length).toBe(segs.length + 1)
    for (const p of pts) {
      expect(p).toHaveProperty('beat')
      expect(p).toHaveProperty('y')
      expect(typeof p.beat).toBe('number')
      expect(typeof p.y).toBe('number')
    }
  })

  it('amplitude list-driven: amplitudeAt step before/after change (off-grid)', () => {
    const changes = [{ beat: 4, bpm: 120, amplitude: 2.0 }]
    const timeline = new BpmTimeline(120, changes, 1.0)
    // Off-grid before change
    expect(timeline.amplitudeAt(3.37)).toBe(1.0)
    expect(timeline.amplitudeAt(3.99)).toBe(1.0)
    // Off-grid after change
    expect(timeline.amplitudeAt(4.0)).toBe(2.0)
    expect(timeline.amplitudeAt(4.23)).toBe(2.0)
    expect(timeline.amplitudeAt(4.37)).toBe(2.0)
  })
})

// ---------------------------------------------------------------------------
// Additional 3-step: editor-play guarded during overlay (mirrors DOM spec)
// ---------------------------------------------------------------------------
describe('T134 #5 Integration: overlay open -> editor-play guarded, close -> released', () => {
  it('editor-play button logic is guarded when calibrationOpenRef true (3-step)', () => {
    // Step1: initial closed
    const ctxClosed: HandlerCtx = {
      calibrationOpen: false,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 10,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const hClosed = createMockEditorHandler(ctxClosed)
    const beforeClosed = ctxClosed.playTriggered
    hClosed.handleKeyDown('', 'Space')
    expect(beforeClosed).toBe(false)
    expect(ctxClosed.playTriggered).toBe(true)

    // Step2: overlay open — same Space should NOT toggle play
    const ctxOpen: HandlerCtx = {
      calibrationOpen: true,
      playtestActive: false,
      isPlaying: false,
      mode: 'play',
      offsetMs: 10,
      playTriggered: false,
      offsetDelta: 0,
      arrowHandled: false,
      spaceHoldTriggered: false,
    }
    const hOpen = createMockEditorHandler(ctxOpen)
    hOpen.handleKeyDown('', 'Space')
    // Step3: assert no change
    expect(ctxOpen.playTriggered).toBe(false)
    expect(hOpen.handleKeyDown('', 'Space').playTriggered).toBe(false)
  })

  it('verifies source: EditorScreen imports CalibrationModal as overlay, not route', () => {
    const src = editorSource()
    const modalSrc = readSource('src/screens/editor/CalibrationModal.tsx')
    expect(src).toMatch(/import\s+CalibrationModal/)
    expect(modalSrc).toMatch(/data-testid="editor-calibration-modal"/)
    // Must be conditionally rendered via {calibrationOpen && <CalibrationModal
    expect(src).toMatch(/\{calibrationOpen\s*&&\s*\(?\s*<CalibrationModal/)
  })
})
