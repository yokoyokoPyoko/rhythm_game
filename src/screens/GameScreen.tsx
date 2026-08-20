import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AudioManager } from '../audio/AudioManager'
import { BpmTimeline } from '../audio/bpmTimeline'
import { getManualOffsetMs, resetClock, setManualOffset, songNow } from '../audio/clock'
import { isKeySoundEnabled, playKeyClick, setKeySoundEnabled } from '../audio/keySound'
import { loadAudio } from '../audio/loader'
import { LOOKAHEAD_MS, schedule } from '../audio/metronome'
import { loadChart } from '../chart/loader'
import { loadSongList } from '../chart/manifest'
import { Cursor } from '../game/cursor'
import { judgeHit } from '../game/hitJudge'
import { Renderer, type JudgementEvent } from '../game/renderer'
import { RingSpawner } from '../game/ringSpawner'
import { ScoreManager, type ScoreStats } from '../game/score'
import { WaveEngine } from '../game/waveEngine'
import type { Chart, RingState } from '../types'

const CANVAS_WIDTH = 800
const CANVAS_HEIGHT = 600
const TW_TOLERANCE = 26
const END_DELAY_MS = 2000
const METRONOME_TICK_MS = 25
const JUDGEMENT_LIFETIME_MS = 700

type LoadStatus = 'loading' | 'error' | 'ready'

export interface GameScreenProps {
  playtestChart?: Chart
  onExit?: (stats?: ScoreStats) => void
}

export default function GameScreen({ playtestChart, onExit }: GameScreenProps = {}) {
  const { songId } = useParams<{ songId: string }>()
  const navigate = useNavigate()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const timelineRef = useRef<BpmTimeline | null>(null)
  const waveRef = useRef<WaveEngine | null>(null)
  const cursorRef = useRef(new Cursor())
  const spawnerRef = useRef(new RingSpawner())
  const scoreRef = useRef(new ScoreManager())
  const ringsRef = useRef<RingState[]>([])
  const judgementEventsRef = useRef<JudgementEvent[]>([])
  const bufferRef = useRef<AudioBuffer | null>(null)
  const musicSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const metronomeTimerRef = useRef<number | null>(null)
  const keysRef = useRef({ up: false, down: false })
  const startedRef = useRef(false)
  const endedRef = useRef(false)

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [offsetMs, setOffsetMs] = useState(getManualOffsetMs)
  const [keySoundOn, setKeySoundOn] = useState(isKeySoundEnabled)
  const statusRef = useRef<LoadStatus>('loading')
  const keySoundOnRef = useRef(isKeySoundEnabled())
  const onExitRef = useRef(onExit)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  const stopMusic = useCallback(() => {
    if (musicSourceRef.current) {
      try {
        musicSourceRef.current.stop()
      } catch {
        // already stopped
      }
      musicSourceRef.current = null
    }
  }, [])

  const stopMetronome = useCallback(() => {
    if (metronomeTimerRef.current !== null) {
      window.clearInterval(metronomeTimerRef.current)
      metronomeTimerRef.current = null
    }
  }, [])

  const playMusic = useCallback((ctx: AudioContext) => {
    const buffer = bufferRef.current
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
    musicSourceRef.current = source
  }, [])

  const startMetronome = useCallback(
    (ctx: AudioContext) => {
      stopMetronome()
      const audioMgr = AudioManager.getInstance()
      const lookaheadSec = LOOKAHEAD_MS / 1000
      let beat = 0
      let nextBeatTime = ctx.currentTime
      metronomeTimerRef.current = window.setInterval(() => {
        const timeline = timelineRef.current
        if (!timeline) return
        const audioCtx = audioMgr.ctx
        while (nextBeatTime < audioCtx.currentTime + lookaheadSec) {
          try {
            schedule(audioCtx, nextBeatTime, beat)
          } catch {
            // keep the beat grid advancing even if one click fails to schedule
          }
          nextBeatTime += timeline.beatMsAt(beat) / 1000
          beat++
        }
      }, METRONOME_TICK_MS)
    },
    [stopMetronome],
  )

  const startGame = useCallback(async () => {
    if (startedRef.current) return
    const audioMgr = AudioManager.getInstance()
    await audioMgr.ensure()
    if (startedRef.current) return
    const ctx = audioMgr.ctx
    resetClock(ctx)
    startedRef.current = true
    playMusic(ctx)
    startMetronome(ctx)
  }, [playMusic, startMetronome])

  const handleHit = useCallback(() => {
    try {
      const songTimeMs = songNow()
      const timeline = timelineRef.current
      if (!timeline) return
      const beatMs = timeline.beatMsAt(timeline.msToBeat(songTimeMs))
      const judgement = judgeHit(songTimeMs, cursorRef.current.y, ringsRef.current, beatMs)
      if (judgement) {
        scoreRef.current.recordHit(judgement.result)
        judgementEventsRef.current.push({
          result: judgement.result,
          y: cursorRef.current.y,
          at: songTimeMs,
        })
      }
    } catch {
      // AudioContext not initialized yet
    }
  }, [])

  const resetGame = useCallback(() => {
    endedRef.current = false
    stopMusic()
    stopMetronome()
    const audioMgr = AudioManager.getInstance()
    try {
      resetClock(audioMgr.ctx)
    } catch {
      // AudioContext not initialized yet
    }
    startedRef.current = false
    keysRef.current.up = false
    keysRef.current.down = false
    cursorRef.current = new Cursor()
    spawnerRef.current = new RingSpawner()
    scoreRef.current = new ScoreManager()
    ringsRef.current = []
    judgementEventsRef.current = []
  }, [stopMusic, stopMetronome])

  useEffect(() => {
    let cancelled = false
    const audioMgr = AudioManager.getInstance()

    async function init() {
      try {
        let chart: Chart
        if (playtestChart) {
          chart = playtestChart
        } else {
          const songs = await loadSongList()
          const song = songs.find((s) => s.id === songId)
          if (!song) {
            throw new Error('譜面ファイルが見つかりません')
          }
          chart = await loadChart(song.chartPath)
        }
        await audioMgr.ensure()
        const timeline = new BpmTimeline(chart.bpm, chart.bpm_changes)
        chartRef.current = chart
        timelineRef.current = timeline
        waveRef.current = new WaveEngine(chart.segments, timeline)
        bufferRef.current = await loadAudio(chart.audio, audioMgr.ctx)
        if (!cancelled) {
          setStatus('ready')
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '譜面の読み込みに失敗しました')
          setStatus('error')
        }
      }
    }

    void init()

    return () => {
      cancelled = true
    }
  }, [songId, playtestChart])

  useEffect(() => {
    if (status !== 'ready') return

    const renderer = new Renderer()
    let raf = 0
    let lastTime = performance.now()

    const initChart = chartRef.current
    const initTimeline = timelineRef.current
    const lastHitTime =
      initChart && initTimeline && initChart.rings.length > 0
        ? initTimeline.beatToMs(initChart.rings.reduce((m, r) => Math.max(m, r.beat), -Infinity))
        : null

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now

      const canvas = canvasRef.current
      const ctx2d = canvas?.getContext('2d')
      const chart = chartRef.current
      const timeline = timelineRef.current
      const wave = waveRef.current
      if (!canvas || !ctx2d || !chart || !timeline || !wave) {
        raf = requestAnimationFrame(tick)
        return
      }

      let songTimeMs = 0
      if (startedRef.current) {
        try {
          songTimeMs = songNow()
        } catch {
          songTimeMs = 0
        }
      }

      ringsRef.current = spawnerRef.current.update(songTimeMs, chart.rings, timeline, wave)

      const currentBeat = timeline.msToBeat(songTimeMs)
      const currentBeatMs = timeline.beatMsAt(currentBeat)
      cursorRef.current.update(
        dt,
        keysRef.current.up,
        keysRef.current.down,
        currentBeatMs,
        wave.segmentBeatsAt(currentBeat),
      )

      if (startedRef.current) {
        for (const ring of ringsRef.current) {
          if (ring.resolved) continue
          const windowMs = timeline.beatMsAt(timeline.msToBeat(ring.hitTime)) * 0.4
          if (songTimeMs > ring.hitTime + windowMs) {
            ring.resolved = true
            scoreRef.current.recordHit('miss')
            judgementEventsRef.current.push({ result: 'miss', y: ring.targetY, at: ring.hitTime + windowMs })
          }
        }
      }

      judgementEventsRef.current = judgementEventsRef.current.filter(
        (e) => songTimeMs - e.at < JUDGEMENT_LIFETIME_MS,
      )

      if (startedRef.current) {
        const isOnWave = Math.abs(cursorRef.current.y - wave.waveYAtMs(songTimeMs)) < TW_TOLERANCE
        scoreRef.current.recordTrace(dt, isOnWave)
      }

      renderer.render(ctx2d, {
        waveEngine: wave,
        cursor: cursorRef.current,
        rings: ringsRef.current,
        score: scoreRef.current,
        songTimeMs,
        bpmTimeline: timeline,
        judgementEvents: judgementEventsRef.current,
      })

      const buffer = bufferRef.current
      const fallbackEnd = lastHitTime !== null ? lastHitTime + END_DELAY_MS : 60000
      const endThreshold = buffer ? buffer.duration * 1000 : fallbackEnd

      if (!endedRef.current && songTimeMs > endThreshold) {
        endedRef.current = true
        stopMusic()
        stopMetronome()
        const stats = scoreRef.current.getStats()
        if (onExitRef.current) {
          onExitRef.current(stats)
        } else {
          navigate('/result', { state: { stats, songId } })
        }
        return
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      stopMusic()
      stopMetronome()
    }
  }, [status, navigate, stopMusic, stopMetronome, songId])

  const adjustOffset = useCallback((delta: number) => {
    const next = Math.round(getManualOffsetMs() + delta)
    setManualOffset(next)
    setOffsetMs(next)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onExitRef.current) {
          onExitRef.current()
        } else {
          navigate('/')
        }
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        resetGame()
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
      if (e.key === 'k' || e.key === 'K') {
        const next = !keySoundOnRef.current
        keySoundOnRef.current = next
        setKeySoundOn(next)
        setKeySoundEnabled(next)
        return
      }
      if (e.key === 'ArrowUp') {
        keysRef.current.up = true
        return
      }
      if (e.key === 'ArrowDown') {
        keysRef.current.down = true
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        if (statusRef.current !== 'ready') return
        if (keySoundOnRef.current) playKeyClick()
        if (!startedRef.current) {
          void startGame()
        } else {
          handleHit()
        }
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
  }, [navigate, startGame, handleHit, resetGame, adjustOffset])

  return (
    <div className="screen game-screen screen-fade">
      {status === 'loading' && <p className="game-status">譜面を読み込み中...</p>}
      {status === 'error' && (
        <div className="game-error">
          <p>{error}</p>
          <button onClick={() => navigate('/')}>曲選択に戻る</button>
        </div>
      )}
      {status === 'ready' && (
        <>
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="game-canvas"
          />
          <div className="game-offset">
            offset: {offsetMs >= 0 ? '+' : ''}
            {offsetMs}ms
          </div>
          <div className="game-hint">Space: 判定 / ↑↓: 移動 / &lt;&gt;: オフセット±10ms / K: キー音{keySoundOn ? 'ON' : 'OFF'} / R: リセット / ESC: 戻る</div>
        </>
      )}
    </div>
  )
}