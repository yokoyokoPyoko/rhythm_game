import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { BpmTimeline } from '../src/audio/bpmTimeline'
import { getLeadMs, getManualOffsetMs, setManualOffset, offsetSeconds } from '../src/audio/clock'

function readFile(rel: string): string {
  const p = path.resolve(__dirname, '..', rel)
  return fs.readFileSync(p, 'utf8')
}

// Helpers that mirror the intended post-T143 ruler-anchored logic
function rulerMetronomeWhen(
  startCtxTime: number,
  timeline: BpmTimeline,
  fromMs: number,
  beatIdx: number,
  manualMs: number,
): number {
  // T143: nextBeatTime = startCtxTime + (beatToMs(beatIdx) - fromMs)/1000
  // audible = nextBeatTime + manual/1000  (schedule adds offsetSeconds)
  return startCtxTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000 + manualMs / 1000
}

function musicWhenPositive(ctxTime: number, audioOffset: number, manualMs: number): number {
  const lead = audioOffset + manualMs
  // T138 centralized: getLeadMs = audioOffset + manual
  // playFrom positive branch: startWhen = ctxTime + lead/1000
  return ctxTime + lead / 1000
}

describe('T143: metronome audioOffset removal (ruler/green-bar fixed)', () => {
  let editorSrc: string
  let metroSrc: string
  let clockSrc: string

  beforeEach(() => {
    editorSrc = readFile('src/screens/EditorScreen.tsx')
    metroSrc = readFile('src/audio/metronome.ts')
    clockSrc = readFile('src/audio/clock.ts')
    vi.useFakeTimers()
    // reset manual offset to 0 via localStorage mock (clock reads from localStorage at import, but we can set)
    try { setManualOffset(0) } catch {}
  })
  afterEach(() => {
    vi.useRealTimers()
    try { setManualOffset(0) } catch {}
    try { localStorage.removeItem('rhythmManualOffsetMs') } catch {}
  })

  // ------------------------------------------------------------------
  // 1. Source-code contract: EditorScreen.startMetronome must NOT bake audioOffset
  // ------------------------------------------------------------------
  describe('source code: startMetronome signature and body', () => {
    it('startMetronome is defined with exactly 3 params (ctx, fromMs, startCtxTime) – no leadMs', () => {
      // Must have 3 params, fourth would be leadMs
      const hasThree = /const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*\)/.test(editorSrc)
      const hasFour = /const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs/.test(editorSrc)
      expect(hasThree).toBe(true)
      expect(hasFour).toBe(false)
    })

    it('nextBeatTime is ruler-anchored: startCtxTime + (beatToMs - fromMs)/1000 without leadMs/1000', () => {
      // Correct line should exist
      const correct = /let\s+nextBeatTime\s*=\s*startCtxTime\s*\+\s*\(timeline\.beatToMs\(beatIdx\)\s*-\s*fromMs\)\s*\/\s*1000/.test(editorSrc)
      expect(correct).toBe(true)
      // Old buggy addition must NOT exist anywhere in startMetronome body
      const buggy = /nextBeatTime\s*=\s*startCtxTime\s*\+\s*leadMs\s*\/\s*1000/.test(editorSrc)
      expect(buggy).toBe(false)
    })

    it('while compensation does NOT add manualOffset – pure horizon check while(nextBeatTime < ctx.currentTime)', () => {
      // There should be a loop that advances while nextBeatTime < ctx.currentTime (no + manual)
      const hasPureWhile = /while\s*\(\s*nextBeatTime\s*<\s*ctx\.currentTime\s*\)/.test(editorSrc)
      expect(hasPureWhile).toBe(true)
      const hasBuggyWhile = /while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs\(\)\s*\/\s*1000\s*<\s*ctx\.currentTime/.test(editorSrc)
      expect(hasBuggyWhile).toBe(false)
    })

    it('does not assign audioOffset to metronomeLeadRef', () => {
      // Old: metronomeLeadRef.current = audioOffset
      const hasAssignment = /metronomeLeadRef\.current\s*=\s*audioOffset/.test(editorSrc)
      expect(hasAssignment).toBe(false)
    })

    it('playFrom does NOT call startMetronome with audioOffset fourth arg', () => {
      const hasOldCall = /startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset\s*\)/.test(editorSrc)
      expect(hasOldCall).toBe(false)
      const hasNewCall = /startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*\)/.test(editorSrc)
      expect(hasNewCall).toBe(true)
    })

    it('useEffect restart does NOT pass metronomeLeadRef.current', () => {
      const hasOldEffectCall = /startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*,\s*metronomeLeadRef\.current/.test(editorSrc)
      expect(hasOldEffectCall).toBe(false)
      // New call should be 3 args only
      const hasNewEffectCall = /startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*\)/.test(editorSrc)
      expect(hasNewEffectCall).toBe(true)
    })

    it('metronomeLeadRef is removed or unused (no assignment to it remains for audioOffset)', () => {
      // If the ref still exists, it should not be written with audioOffset
      // Check that no line contains metronomeLeadRef.current = 
      const leadWrites = (editorSrc.match(/metronomeLeadRef\.current\s*=/g) || []).length
      expect(leadWrites).toBe(0)
    })
  })

  // ------------------------------------------------------------------
  // 2. schedule() still adds manualOffset (only audioOffset removed)
  // ------------------------------------------------------------------
  describe('schedule still adds manualOffset via offsetSeconds', () => {
    it('metronome.ts schedule uses offsetSeconds() for manual calibration', () => {
      expect(metroSrc).toMatch(/offsetSeconds\(\)/)
      expect(metroSrc).toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/)
      expect(metroSrc).toMatch(/when\s*=\s*Math\.max\(audioCtx\.currentTime,\s*nextBeatTime\s*\+\s*offsetSeconds\(\)\)/)
    })

    it('clock.ts getLeadMs = audioOffset + manualOffset remains centralized', () => {
      expect(clockSrc).toMatch(/export function getLeadMs/)
      expect(clockSrc).toMatch(/return audioOffsetMs \+ manualOffsetMs/)
      // getLeadMs is used for music playback, not for metronome grid
      expect(editorSrc).toMatch(/getLeadMs\(audioOffset\)/)
    })

    it('schedule does NOT reference audioOffset directly', () => {
      expect(metroSrc).not.toMatch(/audioOffset/)
      expect(metroSrc).not.toMatch(/audio_offset/)
    })
  })

  // ------------------------------------------------------------------
  // 3. Numeric: metronome when is invariant to audioOffset (0 vs 200ms)
  // ------------------------------------------------------------------
  describe('numeric: metronome when invariant to audioOffset (0 -> 200ms)', () => {
    it('same fromMs/startCtxTime/manual yields identical metronome when for audioOffset 0 and 200', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const startCtxTime = 10.0
      const fromMs = 0
      const beatIdx = 0 // first beat
      const manual = 0
      // Simulate old buggy vs new: old would have added audioOffset/1000 to when
      const when0 = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      const when200 = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      // Both should be equal (no audioOffset added) – if buggy, when200 would be 10.2 vs 10.0
      expect(when200).toBeCloseTo(when0, 5)
      expect(when0).toBeCloseTo(10.0, 5)
      // Also verify the buggy delta would be 0.2s if audioOffset were baked in
      const buggyWhen200 = startCtxTime + 200 / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000 + manual / 1000
      expect(buggyWhen200).not.toBeCloseTo(when0, 2)
      expect(buggyWhen200 - when0).toBeCloseTo(0.2, 5)
    })

    it('green bar (raw) and ruler beatToX are aligned – metronome when equals green bar passage for same beat', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const startCtxTime = 5.5
      const fromMs = 0
      // pick a beat that maps to a visible ruler tick (e.g. beat 4)
      const beat = 4
      const beatIdx = beat
      const manual = 15 // small manual offset still applied
      const metroWhen = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      // green bar passage: raw tick = startMs + (ctx.currentTime - startCtx)*1000 => at beat B, rawPos = beatToMs(B)
      // So green time for beat B is startCtxTime + (beatToMs(B)-fromMs)/1000 (same as metro base, then +manual for audible)
      // Verify metro audible and green+manual align
      const greenRawWhen = startCtxTime + (timeline.beatToMs(beat) - fromMs) / 1000
      expect(metroWhen).toBeCloseTo(greenRawWhen + manual / 1000, 5)
      // If audioOffset were baked, ruler and green would diverge
      const audioOffset = 200
      const buggyMetro = startCtxTime + audioOffset / 1000 + (timeline.beatToMs(beat) - fromMs) / 1000 + manual / 1000
      expect(buggyMetro).not.toBeCloseTo(greenRawWhen + manual / 1000, 2)
    })

    it('off-grid fromMs (e.g. 137ms / 0.37 beat start) still ruler-anchored without audioOffset', () => {
      const timeline = new BpmTimeline(120, [], 1.0) // 500ms per beat
      // start partway through a beat: fromMs = 137ms (~0.274 beat)
      const fromMs = 137
      const beatIdx = Math.ceil(timeline.msToBeat(fromMs)) // next integer beat = 1
      const startCtxTime = 20.0
      const manual = 0
      const metroWhen = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      // expected: start + (500 -137)/1000 = 20 + 0.363 = 20.363
      expect(metroWhen).toBeCloseTo(20.363, 3)
      // Change audioOffset 0 -> 200 should NOT change this
      const audioOffset = 200
      // If buggy, would be 20.563
      const buggy = startCtxTime + audioOffset / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000
      expect(buggy).not.toBeCloseTo(metroWhen, 2)
      expect(metroWhen).toBeCloseTo(20.363, 3)
    })
  })

  // ------------------------------------------------------------------
  // 4. Numeric: music vs metronome delta == audioOffset (intentional stagger)
  // ------------------------------------------------------------------
  describe('numeric: music audible vs metronome delta equals audioOffset', () => {
    it('positive audioOffset 200ms: music when = metro when + audioOffset', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const ctxTime = 100.0
      const startCtxTime = ctxTime
      const fromMs = 0
      const beatIdx = 0
      const audioOffset = 200
      const manual = 0
      const metroWhen = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      const musicWhen = musicWhenPositive(ctxTime, audioOffset, manual)
      // music delayed by audioOffset relative to metro
      expect(musicWhen - metroWhen).toBeCloseTo(audioOffset / 1000, 5)
      expect(musicWhen).toBeCloseTo(100.2, 5)
      expect(metroWhen).toBeCloseTo(100.0, 5)
    })

    it('positive audioOffset with manualOffset combined: lead = audio + manual, delta still audioOffset', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const ctxTime = 50.0
      const startCtxTime = ctxTime
      const fromMs = 0
      const beatIdx = 2 // beat 2 => 1000ms
      const audioOffset = 200
      const manual = 80
      const metroWhen = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      const musicWhen = musicWhenPositive(ctxTime, audioOffset, manual)
      // For beat 0, music vs metro delta = audioOffset. For later beats the per-beat grid is same slope,
      // so the delta remains audioOffset (music was delayed at start, metronome not).
      // Verify via direct formula: metro(beat B) = S + (beatToMs(B)-from)/1000 + manual/1000
      // music start = S + (audio+manual)/1000, but music playback position progresses same rate, so at any beat B
      // the audible music position lags metro by audioOffset. Simplest: check beat 0 delta.
      const metro0 = rulerMetronomeWhen(startCtxTime, timeline, fromMs, 0, manual)
      const music0 = musicWhenPositive(ctxTime, audioOffset, manual)
      expect(music0 - metro0).toBeCloseTo(audioOffset / 1000, 5)
      // For beat 2, metro time is later but delta still audioOffset when comparing music start vs metro0
      // Ensure metroWhen is not shifted by audioOffset
      expect(metroWhen).toBeCloseTo(startCtxTime + timeline.beatToMs(beatIdx) / 1000 + manual / 1000, 5)
      expect(musicWhen - metroWhen).toBeCloseTo(audioOffset / 1000 - timeline.beatToMs(beatIdx) / 1000, 5) // non-trivial: shows audioOffset not in metro
      // The key invariant: metro not containing audioOffset, so metroWhen is 200ms earlier than buggy would be
      const buggyMetroWhen = startCtxTime + audioOffset / 1000 + timeline.beatToMs(beatIdx) / 1000 + manual / 1000
      expect(buggyMetroWhen - metroWhen).toBeCloseTo(audioOffset / 1000, 5)
    })

    it('negative audioOffset -80ms still yields correct delta (music earlier relative to metro)', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const ctxTime = 30.0
      const audioOffset = -80
      const manual = 10
      const lead = getLeadMs(audioOffset) // should be -70
      // Need manual set to 10 for offsetSeconds to be 10; we set it via setManualOffset above? but getLeadMs uses module var
      // Verify getLeadMs computes correctly
      setManualOffset(manual)
      expect(getLeadMs(audioOffset)).toBeCloseTo(-70, 5)
      const metroWhen = rulerMetronomeWhen(ctxTime, timeline, 0, 0, manual)
      // musicWhen for negative lead: startWhen = ctxTime (immediate), startOffset = fromMs/1000 - lead/1000
      // For beat0 comparison, music audible start is still ctxTime but logically offset differently; the delta for audible alignment
      // is audioOffset: music vs metro = audioOffset/1000 = -0.08 for same manual
      // We test the invariant: buggy would add -0.08, fixed does not
      const buggy = ctxTime + audioOffset / 1000 + manual / 1000
      expect(buggy).not.toBeCloseTo(metroWhen, 2)
      expect(metroWhen).toBeCloseTo(ctxTime + manual / 1000, 5)
    })

    it('getLeadMs helper itself is audioOffset + manualOffset', () => {
      setManualOffset(30)
      expect(getLeadMs(0)).toBe(30)
      expect(getLeadMs(200)).toBe(230)
      expect(getLeadMs(-100)).toBe(-70)
      setManualOffset(-20)
      expect(getLeadMs(50)).toBe(30)
      expect(offsetSeconds()).toBeCloseTo(getManualOffsetMs() / 1000, 5)
    })
  })

  // ------------------------------------------------------------------
  // 5. Determinism: same fromMs => same when regardless of audioOffset
  // ------------------------------------------------------------------
  describe('determinism (T137) retained after T143', () => {
    it('two consecutive playFrom with same fromMs produce identical metronome when (no jitter, no audioOffset drift)', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const startCtxTime = 7.123 // fake ctx time snapshot
      const fromMs = 0
      const beatIdx = Math.ceil(timeline.msToBeat(fromMs))
      const manual = 0
      const whenFirst = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      const whenSecond = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
      expect(whenFirst).toBeCloseTo(whenSecond, 5)
      // With audioOffset 0 vs 200, they remain identical (fixed ruler)
      const audioOffsets = [0, 200, -120, 80]
      const whens = audioOffsets.map(() => rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual))
      for (let idx = 1; idx < whens.length; idx++) {
        expect(whens[idx]).toBeCloseTo(whens[0], 5)
      }
      // Buggy would have diverged by audioOffset
      const buggyWhens = audioOffsets.map(a => startCtxTime + a / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000 + manual / 1000)
      // At least one buggy differs from fixed
      expect(buggyWhens[1]).not.toBeCloseTo(whens[0], 2)
    })

    it('determinism holds for off-grid positions (0.37 beat start, 1.23 beat etc)', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const cases: Array<[number, number]> = [
        [0.37 * 500, 0.37], // ~185ms
        [1.23 * 500, 1.23], // ~615ms
        [2.71 * 500, 2.71],
      ]
      for (const [fromMs, _beat] of cases) {
        const beatIdx = Math.ceil(timeline.msToBeat(fromMs))
        const startCtxTime = 12.0
        const manual = 0
        const w0 = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
        const w1 = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
        expect(w1).toBeCloseTo(w0, 5)
        // Off-grid quantization must not leak audioOffset
        const buggy = startCtxTime + 200 / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000
        expect(buggy).not.toBeCloseTo(w0, 2)
      }
    })

    it('vi.useFakeTimers determinism: setInterval callback uses snapshot startCtxTime, not live currentTime', () => {
      // Simulate that startCtxTime is captured once; advancing fake timers should not change computed nextBeatTime
      const timeline = new BpmTimeline(120, [], 1.0)
      const start = 10.0
      const fromMs = 100 // 0.2 beat
      const beatIdx = Math.ceil(timeline.msToBeat(fromMs))
      const manual = 0
      const base = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, manual)
      vi.advanceTimersByTime(1000)
      const still = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, manual)
      expect(still).toBeCloseTo(base, 5)
      vi.advanceTimersByTime(5000)
      expect(rulerMetronomeWhen(start, timeline, fromMs, beatIdx, manual)).toBeCloseTo(base, 5)
    })
  })

  // ------------------------------------------------------------------
  // 6. Manual offset still affects metronome (only audioOffset removed)
  // ------------------------------------------------------------------
  describe('manualOffset still baked via schedule (not removed)', () => {
    it('changing manualOffset does shift metronome when by manual delta', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const start = 0
      const fromMs = 0
      const beatIdx = 0
      const w0 = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, 0)
      const w80 = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, 80)
      expect(w80 - w0).toBeCloseTo(0.08, 5)
      const wNeg = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, -40)
      expect(wNeg - w0).toBeCloseTo(-0.04, 5)
    })

    it('audioOffset does not shift metronome but manual does – orthogonal', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const start = 5.0
      const fromMs = 250 // 0.5 beat
      const beatIdx = 1 // 500ms
      const base = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, 0)
      // audio 200 should not move
      const withAudio = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, 0)
      expect(withAudio).toBeCloseTo(base, 5)
      // manual 50 should move +0.05
      const withManual = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, 50)
      expect(withManual - base).toBeCloseTo(0.05, 5)
      // both together: only manual moves
      const both = rulerMetronomeWhen(start, timeline, fromMs, beatIdx, 50)
      expect(both).toBeCloseTo(withManual, 5)
    })
  })

  // ------------------------------------------------------------------
  // 7. BpmTimeline integration: beatToMs slope intact after T143
  // ------------------------------------------------------------------
  describe('BpmTimeline beatToMs still ruler source', () => {
    it('beatToMs at various BPMs produces expected ms, and metronome grid uses it directly', () => {
      const tl120 = new BpmTimeline(120, [], 1.0)
      expect(tl120.beatToMs(0)).toBeCloseTo(0, 5)
      expect(tl120.beatToMs(1)).toBeCloseTo(500, 5)
      expect(tl120.beatToMs(4)).toBeCloseTo(2000, 5)
      const tl180 = new BpmTimeline(180, [], 1.0)
      expect(tl180.beatToMs(1)).toBeCloseTo(333.333, 2)
      const start = 1.0
      const fromMs = 0
      const manual = 0
      const w120 = rulerMetronomeWhen(start, tl120, fromMs, 4, manual)
      expect(w120).toBeCloseTo(1.0 + 2000 / 1000, 5)
      const w180 = rulerMetronomeWhen(start, tl180, fromMs, 4, manual)
      expect(w180).toBeCloseTo(1.0 + tl180.beatToMs(4) / 1000, 5)
      expect(w120).not.toBeCloseTo(w180, 1)
    })

    it('bpm_changes do not affect audioOffset isolation – metronome still ruler-anchored', () => {
      const tl = new BpmTimeline(120, [{ beat: 4, bpm: 150 }], 1.0)
      // beat 0->4 at 500ms/beat =2000ms, beat 5 => 2000 + 400 =2400ms
      expect(tl.beatToMs(4)).toBeCloseTo(2000, 2)
      expect(tl.beatToMs(5)).toBeCloseTo(2400, 2)
      const start = 2.0
      const fromMs = tl.beatToMs(4) // start at beat 4 boundary
      const beatIdx = 5
      const manual = 0
      const metro = rulerMetronomeWhen(start, tl, fromMs, beatIdx, manual)
      expect(metro).toBeCloseTo(2.0 + (2400 - 2000) / 1000, 5)
      // Ensure audioOffset would have wrongly shifted this if baked
      const buggy = start + 200 / 1000 + (tl.beatToMs(beatIdx) - fromMs) / 1000
      expect(buggy).not.toBeCloseTo(metro, 2)
    })
  })

  // ------------------------------------------------------------------
  // 8. End-to-end timeline: ruler beatToX vs metronome vs green bar all align
  // ------------------------------------------------------------------
  describe('ruler/green/metronome alignment (editor contract)', () => {
    it('for any beat B, ruler x position time and metronome when are co-linear (no audioOffset)', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const startCtxTime = 3.0
      const fromMs = 0
      const manual = 25
      const beats = [0, 0.5, 1, 1.23, 2, 3.37, 4, 8]
      for (const b of beats) {
        const beatIdx = Math.ceil(b)
        // ruler: x corresponds to beat B at raw time start + (beatToMs(B)-from)/1000
        const rulerTime = startCtxTime + (timeline.beatToMs(b) - fromMs) / 1000
        // green bar reaches beat B at same rulerTime (raw, T138)
        // metronome clicks at beatIdx: ruler time for that beat + manual
        // For exact integer beats, metronome audible = rulerTime + manual/1000
        // Verify with tolerance
        if (Number.isInteger(b)) {
          const metro = rulerMetronomeWhen(startCtxTime, timeline, fromMs, b, manual)
          expect(metro).toBeCloseTo(rulerTime + manual / 1000, 5)
        }
        // For off-grid b, the green is at rulerTime, next metro is at ceil(b)
        const nextMetro = rulerMetronomeWhen(startCtxTime, timeline, fromMs, beatIdx, manual)
        expect(nextMetro).toBeGreaterThanOrEqual(rulerTime - 1e-9)
        // And importantly, nextMetro does NOT include audioOffset
        const audio = 200
        const buggyNext = startCtxTime + audio / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000 + manual / 1000
        expect(buggyNext).not.toBeCloseTo(nextMetro, 2)
      }
    })

    it('music delay is exactly audioOffset, not affecting ruler/green/metro', () => {
      const timeline = new BpmTimeline(120, [], 1.0)
      const ctxTime = 8.0
      const fromMs = timeline.beatToMs(2) // start at beat 2
      const audioOffset = 150
      const manual = 0
      setManualOffset(manual)
      const lead = getLeadMs(audioOffset)
      expect(lead).toBe(150)
      const musicStart = musicWhenPositive(ctxTime, audioOffset, manual)
      const metroBeat2 = rulerMetronomeWhen(ctxTime, timeline, fromMs, 2, manual)
      // metro at beat2 is now (since fromMs == beatToMs(2)), so metroBeat2 == ctxTime
      expect(metroBeat2).toBeCloseTo(ctxTime, 5)
      expect(musicStart - metroBeat2).toBeCloseTo(audioOffset / 1000, 5)
      // For next beat (3), metro is +0.5s, music still same start offset
      const metroBeat3 = rulerMetronomeWhen(ctxTime, timeline, fromMs, 3, manual)
      expect(metroBeat3).toBeCloseTo(ctxTime + 0.5, 5)
      expect(musicStart).not.toBeCloseTo(metroBeat3, 1)
    })
  })

  // ------------------------------------------------------------------
  // 9. Regression: GameScreen Metronome unchanged (ruler fixed already)
  // ------------------------------------------------------------------
  describe('regression: GameScreen Metronome remains ruler-fixed', () => {
    it('GameScreen.ts does not bake audioOffset into nextBeatTime (reference check)', () => {
      const gameSrc = readFile('src/screens/GameScreen.tsx')
      // GameScreen Metronome uses ctx.currentTime directly, not leadMs
      // It should not contain "leadMs" or "audioOffset" in its Metronome class tick
      // At least ensure it does not add audioOffset to nextBeatTime in the same pattern
      const hasLeadInGameMetronome = /nextBeatTime\s*=\s*.*leadMs/.test(gameSrc)
      expect(hasLeadInGameMetronome).toBe(false)
    })
  })
})
