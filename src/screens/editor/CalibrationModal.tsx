import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioManager } from '../../audio/AudioManager'
import { getManualOffsetMs, setManualOffset } from '../../audio/clock'
import { LOOKAHEAD_MS, schedule } from '../../audio/metronome'

const CAL_BPM = 120
const CAL_SAMPLES = 8
const DISCARD_FIRST = 2
const METRONOME_TICK_MS = 25
const LEAD_SEC = 0.3

interface CalibrationModalProps {
  onClose: (save: boolean) => void
}

export default function CalibrationModal({ onClose }: CalibrationModalProps) {
  const audioMgr = useRef(AudioManager.getInstance()).current
  const metronomeTimerRef = useRef<number | null>(null)
  const gridRef = useRef<number[]>([])
  const samplesRef = useRef<number[]>([])
  const startedRef = useRef(false)
  const [taps, setTaps] = useState(0)
  const [offsetMs, setOffsetMs] = useState(getManualOffsetMs())
  const [done, setDone] = useState(false)

  const stopMetronome = useCallback(() => {
    if (metronomeTimerRef.current !== null) {
      window.clearInterval(metronomeTimerRef.current)
      metronomeTimerRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    stopMetronome()
    onClose(false)
  }, [stopMetronome, onClose])

  const startMetronome = useCallback(() => {
    stopMetronome()
    const ctx = audioMgr.ctx
    const lookaheadSec = LOOKAHEAD_MS / 1000
    const beatSec = 60000 / CAL_BPM / 1000
    let beat = 0
    let nextBeatTime = ctx.currentTime + LEAD_SEC
    metronomeTimerRef.current = window.setInterval(() => {
      while (nextBeatTime < ctx.currentTime + lookaheadSec) {
        if (beat < CAL_SAMPLES) {
          gridRef.current[beat] = nextBeatTime
        }
        try {
          schedule(ctx, nextBeatTime, beat)
        } catch {
          // keep the beat grid advancing even if one click fails to schedule
        }
        nextBeatTime += beatSec
        beat++
      }
    }, METRONOME_TICK_MS)
  }, [audioMgr, stopMetronome])

  const handleSpace = useCallback(async () => {
    if (done || samplesRef.current.length >= CAL_SAMPLES) return
    if (!startedRef.current) {
      startedRef.current = true
      setManualOffset(0)
      setOffsetMs(0)
      await audioMgr.ensure()
      startMetronome()
    }
    const tapTime = audioMgr.ctx.currentTime
    const index = samplesRef.current.length
    const grid = gridRef.current[index]
    const errorMs = grid !== undefined ? (tapTime - grid) * 1000 : Number.NaN
    samplesRef.current.push(errorMs)
    setTaps(samplesRef.current.length)
    if (samplesRef.current.length >= CAL_SAMPLES) {
      const kept = samplesRef.current.slice(DISCARD_FIRST).filter((v) => Number.isFinite(v))
      if (kept.length > 0) {
        const avg = kept.reduce((a, b) => a + b, 0) / kept.length
        const next = Math.round(avg)
        setManualOffset(next)
        setOffsetMs(next)
      }
      stopMetronome()
      setDone(true)
    }
  }, [audioMgr, done, startMetronome, stopMetronome])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        if (e.repeat) return
        if (done) {
          onClose(true)
          return
        }
        void handleSpace()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      stopMetronome()
    }
  }, [handleSpace, stopMetronome, cancel, done, onClose])

  const offsetText = (v: number) => `${v >= 0 ? '+' : ''}${v}ms`

  return (
    <div className="calibration-overlay" data-testid="editor-calibration-modal">
      <div className="calibration-modal">
        <h2 className="calibration-title">エディタ内キャリブレーション</h2>

        {!done ? (
          <>
            <div className="calibration-progress">
              <span className="calibration-progress-count">{taps}</span>
              <span className="calibration-progress-total">/ {CAL_SAMPLES}</span>
            </div>
            <div className="calibration-offset">
              現在のオフセット: <span className="calibration-offset-value">{offsetText(offsetMs)}</span>
            </div>
            <p className="calibration-hint">
              メトロノームに合わせて Space を {CAL_SAMPLES} 回押してください
            </p>
            <p className="calibration-hint">ESC / 閉じる でキャンセル（変更を保存しません）</p>
          </>
        ) : (
          <>
            <p className="calibration-done">キャリブレーション完了</p>
            <div className="calibration-offset">
              新しいオフセット: <span className="calibration-offset-value">{offsetText(offsetMs)}</span>
            </div>
          </>
        )}

        <div className="calibration-modal-actions">
          <button
            type="button"
            onClick={() => (done ? onClose(true) : cancel())}
            data-testid="editor-calibration-close"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
