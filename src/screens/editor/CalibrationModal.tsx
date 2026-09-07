import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioManager } from '../../audio/AudioManager'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { getManualOffsetMs, resetClock, setManualOffset, songNow } from '../../audio/clock'
import { LOOKAHEAD_MS, schedule } from '../../audio/metronome'
import { Cursor } from '../../game/cursor'
import { judgeHit } from '../../game/hitJudge'
import { Renderer, type JudgementEvent } from '../../game/renderer'
import { RingSpawner } from '../../game/ringSpawner'
import { ScoreManager } from '../../game/score'
import { WaveEngine } from '../../game/waveEngine'
import type { Chart, HitResult, RingDef, RingState, Segment } from '../../types'

const CAL_BPM = 120
const METRONOME_TICK_MS = 25
const LEAD_SEC = 0
const CANVAS_WIDTH = 800
const CANVAS_HEIGHT = 600
const TW_TOLERANCE = 26
const JUDGEMENT_LIFETIME_MS = 700
const DEFAULT_TOTAL_BEATS = 24000
// T168: calibration-only wide judgement window. Ring spacing is 4 beats = 2000ms
// at BPM 120, so half (1000ms) is the hard upper bound; 750ms fits high-latency
// (200ms+) PCs without stealing toward the neighbouring ring.
const CALIBRATION_WIDE_WINDOW_MS = 750

// T170: coarse calibration — revived old T61 8-tap average flow.
const CALIBRATION_SAMPLE_COUNT = 8
const CALIBRATION_DISCARD_COUNT = 2
// Ring spacing at BPM 120 = 4 beats * 500ms = 2000ms; the unwrap folds errors
// outside ±1000ms back into range (half of the 2000ms grid period).
const CALIBRATION_GRID_MS = 2000
const CALIBRATION_UNWRAP_BOUND_MS = 1000

/**
 * T133: Build the ProSeka-style infinite-loop practice chart.
 * - BPM fixed at 120.
 * - Segments alternate up 2 beats / down 2 beats.
 * - Rings placed every 4 beats (beat 4, 8, 12, ...), type single.
 * Parametrized by totalBeats for testability; defaults to a very long loop
 * (>= 2400 beats / 20 min) so it can be left running and ended at will.
 */
export function generateCalibrationChart(totalBeats = DEFAULT_TOTAL_BEATS): Chart {
  const size = Number.isFinite(totalBeats) && totalBeats > 0 ? Math.floor(totalBeats) : DEFAULT_TOTAL_BEATS
  const segments: Segment[] = []
  let beat = 0
  let isUp = true
  while (beat < size) {
    const remaining = size - beat
    const beats = Math.min(2, remaining)
    segments.push({ direction: isUp ? 'up' : 'down', beats })
    beat += beats
    isUp = !isUp
  }
  const rings: RingDef[] = []
  for (let b = 4; b <= size; b += 4) {
    rings.push({ beat: b, type: 'single' })
  }
  return {
    title: 'Calibration Practice',
    artist: '',
    bpm: CAL_BPM,
    audio: '',
    audio_offset: 0,
    scroll_speed: 110,
    amplitude: 1.0,
    start_position: 0.0,
    bpm_changes: [],
    segments,
    rings,
  }
}

export function generateCalibrationLoopChart(totalBeats = DEFAULT_TOTAL_BEATS): Chart {
  return generateCalibrationChart(totalBeats)
}

/**
 * T170: bring a timing error into [-bound, +bound] by adding / subtracting the
 * ring grid period (2000ms) — the ±1000ms折返し補正. Combined with the nearest-ring
 * judgement this resolves latencies beyond a half beat without ambiguity.
 */
export function unwrapTimingError(
  raw: number,
  period = CALIBRATION_GRID_MS,
  bound = CALIBRATION_UNWRAP_BOUND_MS,
): number {
  let e = raw
  while (e > bound) e -= period
  while (e < -bound) e += period
  return e
}

/**
 * T170: 8-tap coarse calibration (old T61 flow, revived). The first `discard`
 * samples are dropped, the remaining 6 are unwrapped and averaged. The new
 * offset = currentOffset + average error, driving tap - (hitTime + manualOffset)
 * to 0 on average (T167 sign).
 */
export function computeCoarseOffset(
  rawSamples: number[],
  currentOffset: number,
  discard = CALIBRATION_DISCARD_COUNT,
): number | null {
  // T61式: 最初の2サンプルは破棄し、残り6の平均を取る
  const kept = rawSamples.slice(discard)
  if (kept.length === 0) return null
  const unwrapped = kept.map((r) => unwrapTimingError(r))
  const average = unwrapped.reduce((a, b) => a + b, 0) / unwrapped.length
  return Math.round(currentOffset + average)
}

interface CalibrationModalProps {
  onClose: (save: boolean) => void
}

interface LastJudgement {
  result: HitResult
  errorMs: number | null
  yDist: number
}

const offsetText = (v: number) => `${v >= 0 ? '+' : ''}${v}ms`

export default function CalibrationModal({ onClose }: CalibrationModalProps) {
  const audioMgr = useRef(AudioManager.getInstance()).current
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const metronomeTimerRef = useRef<number | null>(null)
  const startedRef = useRef(false)
  const keysRef = useRef({ up: false, down: false })
  const ringsRef = useRef<RingState[]>([])
  const judgementEventsRef = useRef<JudgementEvent[]>([])
  const scoreRef = useRef(new ScoreManager())
  const lastJudgementRef = useRef<LastJudgement | null>(null)
  const savedOffsetRef = useRef(getManualOffsetMs())

  const [offsetMs, setOffsetMs] = useState(getManualOffsetMs())
  const [lastJudgement, setLastJudgement] = useState<LastJudgement | null>(null)

  // T170: coarse calibration state. Samples are collected in handleHit (tap only
  // records), the offset is applied once 8 samples arrive — never from a tap.
  const coarseActiveRef = useRef(false)
  const coarseSamplesRef = useRef<number[]>([])
  const [coarseActive, setCoarseActive] = useState(false)
  const [coarseTapCount, setCoarseTapCount] = useState(0)
  const [coarseMessage, setCoarseMessage] = useState<string | null>(null)

  // T170: when CALIBRATION_SAMPLE_COUNT samples have been collected in coarse
  // mode, apply the averaged offset once (outside handleHit so a tap never
  // mutates the offset — T169). Samples are the judgeHit errorMs values, which
  // equal tapRaw - (hitTime + manualOffset) under the T167 judgement sign.
  useEffect(() => {
    if (!coarseActive) return
    if (coarseTapCount < CALIBRATION_SAMPLE_COUNT) return
    const samples = coarseSamplesRef.current.slice()
    const next = computeCoarseOffset(samples, getManualOffsetMs())
    coarseSamplesRef.current = []
    setCoarseTapCount(0)
    coarseActiveRef.current = false
    setCoarseActive(false)
    if (next !== null) {
      setManualOffset(next)
      setOffsetMs(next)
      setCoarseMessage(`粗調整完了: ${offsetText(next)} (あとは ,. で微調整)`)
    }
  }, [coarseActive, coarseTapCount])

  const chart = useMemo(() => generateCalibrationChart(), [])
  const timeline = useMemo(() => new BpmTimeline(CAL_BPM, [], 1.0), [])
  const wave = useMemo(() => new WaveEngine(chart.segments, timeline, 1.0, 0.0), [chart, timeline])
  const cursorRef = useRef(new Cursor(1.0, 0.0))
  const spawnerRef = useRef(new RingSpawner())

  const stopMetronome = useCallback(() => {
    if (metronomeTimerRef.current !== null) {
      window.clearInterval(metronomeTimerRef.current)
      metronomeTimerRef.current = null
    }
  }, [])

  const startMetronome = useCallback(() => {
    stopMetronome()
    const ctx = audioMgr.ctx
    const lookaheadSec = LOOKAHEAD_MS / 1000
    const beatSec = 60000 / CAL_BPM / 1000
    let beat = 0
    let nextBeatTime = ctx.currentTime + LEAD_SEC
    metronomeTimerRef.current = window.setInterval(() => {
      const audioCtx = audioMgr.ctx
      while (nextBeatTime < audioCtx.currentTime + lookaheadSec) {
        try {
          schedule(audioCtx, nextBeatTime, beat)
        } catch {
          // keep the beat grid advancing even if one click fails to schedule
        }
        nextBeatTime += beatSec
        beat++
      }
    }, METRONOME_TICK_MS)
  }, [audioMgr, stopMetronome])

  const journal = useCallback((result: HitResult, errorMs: number | null, yDist = 0) => {
    const now = songNow()
    judgementEventsRef.current.push({ result, y: cursorRef.current.y, at: now, errorMs, yDist })
    scoreRef.current.recordHit(result)
    lastJudgementRef.current = { result, errorMs, yDist }
    setLastJudgement({ result, errorMs, yDist })
  }, [])

  const handleHit = useCallback(() => {
    try {
      // T169: no offset reset on tap. Tapping only records the judgement; the
      // manual offset is changed exclusively via ,. keys / buttons and saved or
      // restored by the explicit save / cancel actions.
      const songTimeMs = songNow()
      const beatMs = timeline.beatMsAt(timeline.msToBeat(songTimeMs))
      // T167: manualOffset applies on the judgement side only.
      // Error = tapRaw - (hitTime + manualOffset); passing the shifted tap time
      // keeps hitJudge's errorMs aligned so ,. adjustments reflect linearly.
      const pressTime = songTimeMs - getManualOffsetMs()
      // T174: find the best ring BEFORE calling judgeHit. judgeHit marks
      // that ring `resolved` itself, so any scan performed afterwards would
      // skip it. Use the same logic as the judgement window (nearest).
      let targetRing: RingState | null = null
      let bestErr = Infinity
      for (const ring of ringsRef.current) {
        if (ring.resolved) continue
        if (ring.type === 'hold' && ring.hit) continue
        const err = Math.abs(pressTime - ring.hitTime)
        if (err < bestErr) {
          bestErr = err
          targetRing = ring
        }
      }
      const yDist = targetRing ? Math.abs(cursorRef.current.y - targetRing.targetY) : 0
      const judgement = judgeHit(pressTime, cursorRef.current.y, ringsRef.current, beatMs, CALIBRATION_WIDE_WINDOW_MS)
      if (judgement) {
        journal(judgement.result, judgement.errorMs, yDist)
        // T170: coarse mode collects one timing sample per tap. The offset is
        // never mutated here — the sample counter effect applies the average
        // when CALIBRATION_SAMPLE_COUNT taps have been recorded.
        if (coarseActiveRef.current) {
          coarseSamplesRef.current.push(judgement.errorMs)
          setCoarseTapCount(coarseSamplesRef.current.length)
        }
      }
    } catch {
      // AudioContext not initialized yet
    }
  }, [timeline, journal])

  // Keep a ref mirror of coarseActive so tap handlers read it without re-binding.
  useEffect(() => {
    coarseActiveRef.current = coarseActive
  }, [coarseActive])

  // Start the loop and metronome once on mount.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void audioMgr.ensure().then(() => {
      const ctx = audioMgr.ctx
      resetClock(ctx)
      startMetronome()
    })
  }, [audioMgr, startMetronome])

  // Main render / play loop.
  useEffect(() => {
    const renderer = new Renderer()
    let raf = 0
    let lastTime = performance.now()

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now
      const canvas = canvasRef.current
      const ctx2d = canvas?.getContext('2d')
      if (!canvas || !ctx2d) {
        raf = requestAnimationFrame(tick)
        return
      }
      const songTimeMs = songNow()
      const renderTimeMs = songTimeMs - getManualOffsetMs()
      const currentBeat = timeline.msToBeat(renderTimeMs)
      const currentBeatMs = timeline.beatMsAt(currentBeat)

      ringsRef.current = spawnerRef.current.update(songTimeMs, chart.rings, timeline, wave)

      cursorRef.current.setAmplitude(timeline.amplitudeAt(currentBeat))
       cursorRef.current.update(dt, keysRef.current.up, keysRef.current.down, currentBeatMs, wave.waveYAtMs(renderTimeMs))

      for (const ring of ringsRef.current) {
        if (ring.resolved) continue
        // T168: use the same wide window for the miss deadline so a delayed tap
        // (200ms+ latency) still reaches the nearest ring before it is expired.
        if (songTimeMs - getManualOffsetMs() > ring.hitTime + CALIBRATION_WIDE_WINDOW_MS) {
          ring.resolved = true
          // T172: expired rings have no measurable error — show `--`, never a fake +0ms.
          journal('miss', null)
        }
      }

      judgementEventsRef.current = judgementEventsRef.current.filter(
        (e) => songTimeMs - e.at < JUDGEMENT_LIFETIME_MS,
      )

      const isOnWave = Math.abs(cursorRef.current.y - wave.waveYAtMs(renderTimeMs)) < TW_TOLERANCE;
      scoreRef.current.recordTrace(dt, isOnWave, currentBeatMs)
      renderer.render(ctx2d, {
        waveEngine: wave,
        cursor: cursorRef.current,
        rings: ringsRef.current,
        score: scoreRef.current,
        songTimeMs,
        bpmTimeline: timeline,
        judgementEvents: judgementEventsRef.current,
        scrollSpeed: chart.scroll_speed,
      })

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      stopMetronome()
      startedRef.current = false
    }
  }, [chart, timeline, wave, stopMetronome, journal])

  const resetCoarse = useCallback(() => {
    coarseActiveRef.current = false
    coarseSamplesRef.current = []
    setCoarseActive(false)
    setCoarseTapCount(0)
    setCoarseMessage(null)
  }, [])

  const cancel = useCallback(() => {
    stopMetronome()
    resetCoarse()
    // Restore the offset that was active when the overlay was opened (no save).
    setManualOffset(savedOffsetRef.current)
    setOffsetMs(savedOffsetRef.current)
    onClose(false)
  }, [stopMetronome, resetCoarse, onClose])

  const save = useCallback(() => {
    stopMetronome()
    resetCoarse()
    setManualOffset(getManualOffsetMs())
    onClose(true)
  }, [stopMetronome, resetCoarse, onClose])

  const adjustOffset = useCallback((delta: number) => {
    const next = Math.round(getManualOffsetMs() + delta)
    setManualOffset(next)
    setOffsetMs(next)
  }, [])

  const startCoarse = useCallback(() => {
    if (coarseActive) {
      resetCoarse()
      return
    }
    coarseActiveRef.current = true
    coarseSamplesRef.current = []
    setCoarseActive(true)
    setCoarseTapCount(0)
    setCoarseMessage(null)
  }, [coarseActive, resetCoarse])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        save()
        return
      }
      if (e.key === ',' || e.key === '<') {
        adjustOffset(-10)
        return
      }
      if (e.key === '.' || e.key === '>') {
        adjustOffset(10)
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        if (e.repeat) return
        handleHit()
        return
      }
      if (e.key === 'ArrowUp') {
        keysRef.current.up = true
        e.preventDefault()
        return
      }
      if (e.key === 'ArrowDown') {
        keysRef.current.down = true
        e.preventDefault()
        return
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') keysRef.current.up = false
      if (e.key === 'ArrowDown') keysRef.current.down = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [cancel, save, adjustOffset, handleHit])

  useEffect(() => {
    if (coarseMessage === null) return
    const t = window.setTimeout(() => setCoarseMessage(null), 2500)
    return () => window.clearTimeout(t)
  }, [coarseMessage])

  // T171 (bonus): on open, seed the starting offset with the device latency
  // (outputLatency + baseLatency) so manual tuning starts closer. Only applied
  // while the saved offset is still 0 (never calibrated) so a previous
  // session's value is never doubled; unsupported environments add 0.
  useEffect(() => {
    void audioMgr.ensure().then(() => {
      try {
        const ctx = audioMgr.ctx
        const latencyMs = computeLatencyOffsetMs({
          outputLatency: ctx.outputLatency,
          baseLatency: ctx.baseLatency,
        })
        if (latencyMs !== 0 && getManualOffsetMs() === 0) {
          const seeded = Math.round(getManualOffsetMs() + latencyMs)
          setManualOffset(seeded)
          setOffsetMs(seeded)
        }
      } catch {
        // AudioContext unavailable — keep the saved offset unchanged
      }
    })
  }, [audioMgr])

  // T172: show both the (integer-rounded) timing error and the Y distance so
  // Y-driven GREATs/MISSes are visually explainable. Expired rings carry no
  // measurable error — rendered as `--` instead of a fake +0ms.
  const lastLabel =
    lastJudgement === null
      ? '—'
      : `${lastJudgement.result === 'perfect' ? 'PERFECT' : lastJudgement.result === 'great' ? 'GREAT' : lastJudgement.result === 'good' ? 'GOOD' : 'MISS'} (${
          lastJudgement.result === 'miss' || lastJudgement.errorMs === null
            ? '--'
            : `${Math.round(lastJudgement.errorMs) >= 0 ? '+' : ''}${Math.round(lastJudgement.errorMs)}ms`
        }, ΔY ${Math.round(lastJudgement.yDist)}px)`

  return (
    <div className="calibration-overlay" data-testid="editor-calibration-modal">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="calibration-canvas"
        data-testid="calibration-canvas"
      />
      <div className="calibration-hud">
        <div className="calibration-last" data-testid="calibration-last">
          {lastLabel}
        </div>
        <div className="calibration-combo">
          {scoreRef.current.getStats().combo > 1 ? `${scoreRef.current.getStats().combo} COMBO` : ''}
        </div>
        <div className="calibration-offset" data-testid="calibration-offset">
          offset: {offsetText(offsetMs)}
        </div>
        <div className="calibration-coarse" data-testid="calibration-coarse-progress">
          {coarseActive
            ? `粗調整: ${coarseTapCount}/${CALIBRATION_SAMPLE_COUNT} 回タップ`
            : coarseMessage ?? '粗調整: 強拍に合わせ8回タップで一括補正'}
        </div>
        <div className="calibration-actions">
          <button type="button" data-testid="calibration-minus" onClick={() => adjustOffset(-10)}>
            -10ms
          </button>
          <button type="button" data-testid="calibration-plus" onClick={() => adjustOffset(10)}>
            +10ms
          </button>
          <button type="button" data-testid="calibration-coarse" onClick={startCoarse}>
            {coarseActive ? '粗調整 中止' : '粗調整'}
          </button>
          <button type="button" data-testid="calibration-save" onClick={save}>
            保存して終了
          </button>
          <button type="button" data-testid="calibration-cancel" onClick={cancel}>
            キャンセル
          </button>
        </div>
        <p className="calibration-hint">
          クリックに合わせて叩き、誤差が0になるよう ,. &lt;&gt; で±10ms調整 / Space: 判定 / ↑↓: 移動 / Enter: 保存して終了 / ESC: キャンセル / 「粗調整」で8回タップして大まかに合わせる
        </p>
      </div>
    </div>
  )
}
 
/**
   * T174: Calculate the Y distance for the ring that would actually be hit,
   * replicating the judgeHit logic (nearest timing among Y < HIT_Y candidates,
   * otherwise nearest timing overall for a MISS). This ensures the calibration
   * display shows the Y distance of the judged ring, not just the timing-closest
   * ring. This function is pure and exported for testing.
   */
  export function calculateCalibrationHitYDist(
    pressTimeMs: number,
    cursorY: number,
    rings: RingState[],
    currentBeatMs: number,
    windowMs?: number,
  ): number {
    const win = windowMs ?? currentBeatMs * 0.4;
    const HIT_Y = 60;

    const candidates: { ring: RingState; err: number; yDist: number }[] = [];
    for (const ring of rings) {
      if (ring.resolved) continue;
      if (ring.type === 'hold' && ring.hit) continue;
      const err = Math.abs(pressTimeMs - ring.hitTime);
      if (err < win) {
        const yDist = Math.abs(cursorY - ring.targetY);
        candidates.push({ ring, err, yDist });
      }
    }

    if (candidates.length === 0) return 0;

    const hitCandidates = candidates.filter((c) => c.yDist < HIT_Y);

    let selected: { ring: RingState; err: number; yDist: number } | null = null;

    if (hitCandidates.length > 0) {
      hitCandidates.sort((a, b) => a.err - b.err);
      selected = hitCandidates[0];
    } else {
      candidates.sort((a, b) => a.err - b.err);
      selected = candidates[0];
    }

    return selected ? selected.yDist : 0;
  }

  /**
   * Exported formatter for tests / external use — keeps source pattern checks valid.
   * Matches the inline lastLabel format: "NAME (+XXms, ΔY YYpx)" or "MISS (--, ΔY YYpx)"
   */
  export function formatLastLabel(
  result: HitResult,
  errorMs: number | null,
  yDist: number,
): string {
  const name = result === 'perfect' ? 'PERFECT' : result === 'great' ? 'GREAT' : result === 'good' ? 'GOOD' : 'MISS'
  if (result === 'miss' || errorMs === null) {
    return `${name} (--, ΔY ${Math.round(yDist)}px)`
  }
  const rounded = Math.round(errorMs)
  const sign = rounded >= 0 ? '+' : ''
  return `${name} (${sign}${rounded}ms, ΔY ${Math.round(yDist)}px)`
}
 
 /**
  * T171 (bonus): estimate the device audio latency in ms from the AudioContext's
 * outputLatency / baseLatency (both in seconds). Values that are missing,
 * undefined or NaN (unsupported environments) contribute 0. The result is
 * added to the starting offset when the calibration overlay opens (T167 sign:
 * manual* = +L, i.e. a positive latency raises the offset).
 */
export function computeLatencyOffsetMs(ctx: {
  outputLatency?: number
  baseLatency?: number
} | null | undefined): number {
  if (!ctx) return 0
  const out = Number(ctx.outputLatency) || 0
  const base = Number(ctx.baseLatency) || 0
  return Math.round((out + base) * 1000)
}
