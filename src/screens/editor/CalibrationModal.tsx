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

interface CalibrationModalProps {
  onClose: (save: boolean) => void
}

interface LastJudgement {
  result: HitResult
  errorMs: number
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
  const firstTapRef = useRef(true)

  const [offsetMs, setOffsetMs] = useState(getManualOffsetMs())
  const [lastJudgement, setLastJudgement] = useState<LastJudgement | null>(null)

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

  const journal = useCallback((result: HitResult, errorMs: number) => {
    const now = songNow()
    judgementEventsRef.current.push({ result, y: cursorRef.current.y, at: now })
    scoreRef.current.recordHit(result)
    lastJudgementRef.current = { result, errorMs }
    setLastJudgement({ result, errorMs })
  }, [])

  const handleHit = useCallback(() => {
    try {
      // T136: reset the manual offset at the start of a calibration session so the
      // measured taps are not biased by a previously applied offset. Only the first
      // tap performs this reset; subsequent taps measure relative to the new base.
      if (firstTapRef.current) {
        firstTapRef.current = false
        setManualOffset(0)
        setOffsetMs(0)
      }
      const songTimeMs = songNow()
      const beatMs = timeline.beatMsAt(timeline.msToBeat(songTimeMs))
      const judgement = judgeHit(songTimeMs, cursorRef.current.y, ringsRef.current, beatMs)
      if (judgement) {
        journal(judgement.result, judgement.errorMs)
      }
    } catch {
      // AudioContext not initialized yet
    }
  }, [timeline, journal])

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
    let prevBeatFloor = 0

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

      ringsRef.current = spawnerRef.current.update(songTimeMs, chart.rings, timeline, wave)

      const currentBeat = timeline.msToBeat(songTimeMs)
      const currentBeatMs = timeline.beatMsAt(currentBeat)
      cursorRef.current.setAmplitude(timeline.amplitudeAt(currentBeat))
      cursorRef.current.update(dt, keysRef.current.up, keysRef.current.down, currentBeatMs)

      const beatFloor = Math.floor(currentBeat)
      if (beatFloor !== prevBeatFloor) {
        cursorRef.current.pullTowards(wave.waveYAtMs(songTimeMs), 0.28)
        prevBeatFloor = beatFloor
      }

      for (const ring of ringsRef.current) {
        if (ring.resolved) continue
        const windowMs = timeline.beatMsAt(timeline.msToBeat(ring.hitTime)) * 0.4
        if (songTimeMs > ring.hitTime + windowMs) {
          ring.resolved = true
          journal('miss', 0)
        }
      }

      judgementEventsRef.current = judgementEventsRef.current.filter(
        (e) => songTimeMs - e.at < JUDGEMENT_LIFETIME_MS,
      )

      const isOnWave = Math.abs(cursorRef.current.y - wave.waveYAtMs(songTimeMs)) < TW_TOLERANCE
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

  const cancel = useCallback(() => {
    stopMetronome()
    // Restore the offset that was active when the overlay was opened (no save).
    setManualOffset(savedOffsetRef.current)
    setOffsetMs(savedOffsetRef.current)
    onClose(false)
  }, [stopMetronome, onClose])

  const save = useCallback(() => {
    stopMetronome()
    setManualOffset(getManualOffsetMs())
    onClose(true)
  }, [stopMetronome, onClose])

  const adjustOffset = useCallback((delta: number) => {
    const next = Math.round(getManualOffsetMs() + delta)
    setManualOffset(next)
    setOffsetMs(next)
  }, [])

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

  const lastLabel =
    lastJudgement === null
      ? '—'
      : `${lastJudgement.result === 'perfect' ? 'PERFECT' : lastJudgement.result === 'great' ? 'GREAT' : lastJudgement.result === 'good' ? 'GOOD' : 'MISS'} (${lastJudgement.errorMs >= 0 ? '+' : ''}${lastJudgement.errorMs}ms)`

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
        <div className="calibration-actions">
          <button type="button" data-testid="calibration-minus" onClick={() => adjustOffset(-10)}>
            -10ms
          </button>
          <button type="button" data-testid="calibration-plus" onClick={() => adjustOffset(10)}>
            +10ms
          </button>
          <button type="button" data-testid="calibration-save" onClick={save}>
            保存して終了
          </button>
          <button type="button" data-testid="calibration-cancel" onClick={cancel}>
            キャンセル
          </button>
        </div>
        <p className="calibration-hint">
          Space: 判定 / ↑↓: 移動 / ,. ?&lt;&gt; : ±10ms / Enter: 保存して終了 / ESC: キャンセル
        </p>
      </div>
    </div>
  )
}
