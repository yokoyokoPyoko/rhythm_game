import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { AudioManager } from '../audio/AudioManager'
import { AudioCache, getBasename } from '../audio/AudioCache'
import { BpmTimeline } from '../audio/bpmTimeline'
import { getManualOffsetMs, resetClock, songNow } from '../audio/clock'

import { loadAudio } from '../audio/loader'
import { LOOKAHEAD_MS, schedule } from '../audio/metronome'
import { ChartCache } from '../chart/cache'
import { loadChart } from '../chart/loader'
import { loadSongList } from '../chart/manifest'
import { Cursor } from '../game/cursor'
import { judgeHit } from '../game/hitJudge'
import { Renderer, type JudgementEvent } from '../game/renderer'
import { RingSpawner } from '../game/ringSpawner'
import { ScoreManager, type ScoreStats } from '../game/score'
import { generateTutorialChart, getTutorialInstruction } from '../game/tutorial'
import { WaveEngine } from '../game/waveEngine'
import { getViewMode } from '../viewMode'
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
  playtestBuffer?: AudioBuffer | null
  playtest?: { chart: Chart; buffer: AudioBuffer | null }
  onExit?: (stats?: ScoreStats) => void
}

export default function GameScreen({ playtestChart, playtestBuffer, playtest, onExit }: GameScreenProps = {}) {
  const { songId } = useParams<{ songId: string }>()
  const location = useLocation()
  const state = location.state as { chart?: Chart; buffer?: AudioBuffer | null } | null
  const navigate = useNavigate()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const timelineRef = useRef<BpmTimeline | null>(null)
  const waveRef = useRef<WaveEngine | null>(null)
  // T210: the main chart is loaded up-front ("別本編先行完了") while the tutorial
  // runs on the same engine. Keep the main engines aside and swap them in on
  // tutorial completion / skip.
  const mainChartRef = useRef<Chart | null>(null)
  const mainTimelineRef = useRef<BpmTimeline | null>(null)
  const mainWaveRef = useRef<WaveEngine | null>(null)
  const tutorialChartRef = useRef<Chart | null>(null)
  const tutorialTimelineRef = useRef<BpmTimeline | null>(null)
  const tutorialWaveRef = useRef<WaveEngine | null>(null)
  const tutorialEndRef = useRef(0)
  const cursorRef = useRef(new Cursor())
  const spawnerRef = useRef(new RingSpawner())
  const scoreRef = useRef(new ScoreManager())
  const ringsRef = useRef<RingState[]>([])
  const judgementEventsRef = useRef<JudgementEvent[]>([])
  const bufferRef = useRef<AudioBuffer | null>(null)
  const musicSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const metronomeTimerRef = useRef<number | null>(null)
  const keysRef = useRef({ up: false, down: false, space: false })
  const startedRef = useRef(false)
  const endedRef = useRef(false)

  // T210: tutorial is only shown in public mode for normal play.
  // Debug mode and playtest (playtest* / onExit) never show the tutorial.
  const isPlaytest = !!(playtest || playtestChart || playtestBuffer || onExit)
  const [phase, setPhase] = useState<'tutorial' | 'main'>(() =>
    getViewMode() === 'public' && !isPlaytest ? 'tutorial' : 'main',
  )
  const phaseRef = useRef(phase)
  const [tutorialInstruction, setTutorialInstruction] = useState('')

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [offsetMs] = useState(getManualOffsetMs)
  const statusRef = useRef<LoadStatus>('loading')
  const onExitRef = useRef(onExit)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

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

  const playMusic = useCallback((ctx: AudioContext, audioOffsetMs = 0) => {
    const buffer = bufferRef.current
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    // T167: audioOffset is for music head-start only. manualOffset applies on the
    // judgement side (handleHit), NOT to when the music plays.
    const offsetSec = audioOffsetMs / 1000
    if (offsetSec >= 0) {
      source.start(ctx.currentTime + offsetSec)
    } else {
      source.start(ctx.currentTime, -offsetSec)
    }
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
    if (phaseRef.current === 'main') {
      // T210: the tutorial phase plays the metronome only (~8s, no music).
      // Music starts when the main chart begins (auto-advance or skip).
      playMusic(ctx, chartRef.current?.audio_offset ?? 0)
    }
    startMetronome(ctx)
  }, [playMusic, startMetronome])

  // T210: swap the tutorial engines for the main chart, discard any tutorial
  // score / combo / trace bonus, and start the main game seamlessly.
  const enterMain = useCallback(() => {
    const chart = mainChartRef.current
    const timeline = mainTimelineRef.current
    const wave = mainWaveRef.current
    if (!chart || !timeline || !wave) return
    stopMusic()
    stopMetronome()
    chartRef.current = chart
    timelineRef.current = timeline
    waveRef.current = wave
    scoreRef.current = new ScoreManager()
    ringsRef.current = []
    judgementEventsRef.current = []
    cursorRef.current = new Cursor(chart.amplitude, chart.start_position)
    keysRef.current = { up: false, down: false, space: false }
    phaseRef.current = 'main'
    setPhase('main')
    if (startedRef.current) {
      try {
        const ctx = AudioManager.getInstance().ctx
        resetClock(ctx)
        playMusic(ctx, chart.audio_offset ?? 0)
        startMetronome(ctx)
      } catch {
        // AudioContext not initialized yet
      }
    }
  }, [playMusic, startMetronome, stopMusic, stopMetronome])

  const skipTutorial = useCallback(() => {
    if (phaseRef.current !== 'tutorial') return
    enterMain()
  }, [enterMain])

  const handleHit = useCallback(() => {
    try {
      const songTimeMs = songNow()
      const timeline = timelineRef.current
      if (!timeline) return
      const beatMs = timeline.beatMsAt(timeline.msToBeat(songTimeMs))
      // T167: manualOffset (device audio latency +L) applies on the judgement side
      // only. Error = tapRaw - (hitTime + manualOffset). Passing the shifted tap
      // time keeps hitJudge's errorMs = pressTimeMs - hitTime aligned to that.
      const pressTime = songTimeMs - getManualOffsetMs()
      let targetY = cursorRef.current.y
      let bestErr = Infinity
      for (const ring of ringsRef.current) {
        if (ring.resolved) continue
        if (ring.type === 'hold' && ring.hit) continue
        const err = Math.abs(pressTime - ring.hitTime)
        if (err < bestErr) {
          bestErr = err
          targetY = ring.targetY
        }
      }
      const judgement = judgeHit(pressTime, cursorRef.current.y, ringsRef.current, beatMs)
      if (judgement) {
        scoreRef.current.recordHit(judgement.result)
        judgementEventsRef.current.push({
          result: judgement.result,
          y: cursorRef.current.y,
          at: songTimeMs,
          errorMs: Math.round(judgement.errorMs),
          yDist: Math.round(Math.abs(cursorRef.current.y - targetY)),
        })
      }
    } catch {
      // AudioContext not initialized yet
    }
  }, [])



  useEffect(() => {
    let cancelled = false
    const audioMgr = AudioManager.getInstance()

    async function init() {
      try {
        let chart: Chart
        let buf: AudioBuffer | null = null

        const effectiveChart = playtest?.chart || playtestChart || state?.chart
        const effectiveBuffer = playtest?.buffer !== undefined ? playtest.buffer : (playtestBuffer !== undefined ? playtestBuffer : state?.buffer)

        if (effectiveChart) {
          chart = effectiveChart
          buf = effectiveBuffer !== undefined ? effectiveBuffer : null
        } else if (state?.chart) {
          chart = state.chart
          buf = state.buffer !== undefined ? state.buffer : null
        } else {
          // T120: support custom chart added via SelectScreen cache (custom-xxx)
          const cached = songId ? ChartCache.get(songId) : undefined
          if (cached) {
            chart = cached
          } else {
            // T195: fallback to IndexedDB for persistent custom charts
            let idbChart: Chart | null = null
            try {
              const { getChart } = await import('../storage/libraryDb')
              const { parseChartText } = await import('../chart/loader')
              const stored = songId ? await getChart(songId) : undefined
              if (stored) {
                idbChart = parseChartText(stored.toml, songId!)
                ChartCache.set(songId!, idbChart)
              }
            } catch {
              // IndexedDB unavailable
            }
            if (idbChart) {
              chart = idbChart
            } else {
              const songs = await loadSongList()
              const song = songs.find((s) => s.id === songId)
              if (!song) {
                throw new Error('譜面ファイルが見つかりません')
              }
              const cachedByPath = ChartCache.get(song.chartPath)
              if (cachedByPath) {
                chart = cachedByPath
              } else {
                chart = await loadChart(song.chartPath)
              }
            }
          }
        }
        await audioMgr.ensure()
        // T187: base tempo is derived internally from the first (beat-min) section
        const timeline = new BpmTimeline(chart.bpm_changes, chart.amplitude)
        const mainWave = new WaveEngine(chart.segments, timeline, chart.amplitude, chart.start_position)
        mainChartRef.current = chart
        mainTimelineRef.current = timeline
        mainWaveRef.current = mainWave

        // T210: fixed, code-generated tutorial chart (~8s, metronome only).
        const tutorialChart = generateTutorialChart()
        const tutorialTimeline = new BpmTimeline(tutorialChart.bpm_changes, tutorialChart.amplitude)
        const tutorialWave = new WaveEngine(
          tutorialChart.segments,
          tutorialTimeline,
          tutorialChart.amplitude,
          tutorialChart.start_position,
        )
        tutorialChartRef.current = tutorialChart
        tutorialTimelineRef.current = tutorialTimeline
        tutorialWaveRef.current = tutorialWave
        tutorialEndRef.current =
          tutorialTimeline.beatToMs(
            tutorialChart.rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity),
          ) + END_DELAY_MS

        // T210: tutorial only for public normal play. Debug / playtest go straight
        // to the main chart (本編先行読込済み).
        const useTutorial = getViewMode() === 'public' && !isPlaytest
        if (useTutorial) {
          chartRef.current = tutorialChart
          timelineRef.current = tutorialTimeline
          waveRef.current = tutorialWave
          cursorRef.current = new Cursor(tutorialChart.amplitude, tutorialChart.start_position)
          phaseRef.current = 'tutorial'
          setPhase('tutorial')
        } else {
          chartRef.current = chart
          timelineRef.current = timeline
          waveRef.current = mainWave
          cursorRef.current = new Cursor(chart.amplitude, chart.start_position)
          phaseRef.current = 'main'
          setPhase('main')
        }

        if (effectiveBuffer !== undefined) {
          buf = effectiveBuffer
        } else if (state?.buffer !== undefined) {
          buf = state.buffer
        } else if (effectiveChart) {
          buf = AudioCache.get(getBasename(chart.audio)) || null
        } else if (!state?.chart) {
          const cachedBuf = AudioCache.get(getBasename(chart.audio)) || (songId ? AudioCache.get(songId) : undefined)
          if (cachedBuf) {
            buf = cachedBuf
          } else {
            // T195: fallback to IndexedDB persistent audio bytes for custom charts
            let idbBuf: AudioBuffer | null = null
            try {
              const { getAudio } = await import('../storage/libraryDb')
              const stored = songId ? await getAudio(songId) : undefined
              if (stored && stored.bytes) {
                const bytes = stored.bytes
                const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
                idbBuf = await audioMgr.ctx.decodeAudioData(arrayBuf)
                const base = getBasename(chart.audio)
                AudioCache.set(songId!, idbBuf)
                AudioCache.set(base, idbBuf)
              }
            } catch {
              // IndexedDB unavailable or decode failed
            }
            if (idbBuf) {
              buf = idbBuf
            } else {
              buf = await loadAudio(chart.audio, audioMgr.ctx)
            }
          }
        }

        if (!buf) {
          const cached = AudioCache.get(getBasename(chart.audio))
          if (cached) buf = cached
        }

        bufferRef.current = buf
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
  }, [songId, playtestChart, state])

  useEffect(() => {
    if (status !== 'ready') return

    const renderer = new Renderer()
    let raf = 0
    let lastTime = performance.now()

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
      // T210: tutorial auto-advances after the last ring + 2s (成否不問・時間で自動進行).
      if (startedRef.current && phaseRef.current === 'tutorial' && songTimeMs > tutorialEndRef.current) {
        enterMain()
        try {
          songTimeMs = songNow()
        } catch {
          songTimeMs = 0
        }
      }
      const renderTimeMs = songTimeMs - getManualOffsetMs()

      // T210: beat-synced instruction overlay while the tutorial runs
      if (phaseRef.current === 'tutorial') {
        const text = getTutorialInstruction(timeline.msToBeat(renderTimeMs))
        setTutorialInstruction((prev) => (prev === text ? prev : text))
      }

      ringsRef.current = spawnerRef.current.update(songTimeMs, chart.rings, timeline, wave)

      const currentBeat = timeline.msToBeat(renderTimeMs)
      const currentBeatMs = timeline.beatMsAt(currentBeat)
      // T131: time-varying amplitude — cursor speed follows the bpm_changes amplitude list
      cursorRef.current.setAmplitude(timeline.amplitudeAt(currentBeat))
       cursorRef.current.update(
         dt,
         keysRef.current.up,
         keysRef.current.down,
         currentBeatMs,
         wave.waveYAtMs(renderTimeMs),
       )
      if (startedRef.current) {
        for (const ring of ringsRef.current) {
          if (ring.resolved) continue
          if (ring.type === 'hold' && ring.hit && ring.holding) {
            const releaseTime = ring.releaseTime ?? ring.hitTime
            const windowMs = timeline.beatMsAt(timeline.msToBeat(ring.hitTime)) * 0.4
            if (songTimeMs - getManualOffsetMs() >= releaseTime + windowMs) {
              ring.holding = false
              ring.resolved = true
              ring.holdCompleted = true
              scoreRef.current.recordHit('good')
              judgementEventsRef.current.push({ result: 'good', y: ring.targetY, at: songTimeMs, errorMs: null, yDist: null })
            } else if (!keysRef.current.space) {
              const e = (songTimeMs - getManualOffsetMs()) - releaseTime
              if (e < -windowMs) {
                ring.holding = false
                ring.resolved = true
                scoreRef.current.recordHit('miss')
                judgementEventsRef.current.push({ result: 'miss', y: ring.targetY, at: songTimeMs, errorMs: null, yDist: null })
              } else if (Math.abs(e) <= windowMs) {
                let releaseResult: 'perfect' | 'great' | 'good'
                if (Math.abs(e) < 50) releaseResult = 'perfect'
                else if (Math.abs(e) < 100) releaseResult = 'great'
                else releaseResult = 'good'
                ring.holding = false
                ring.resolved = true
                ring.holdCompleted = true
                scoreRef.current.recordHit(releaseResult)
                judgementEventsRef.current.push({ result: releaseResult, y: ring.targetY, at: songTimeMs, errorMs: e, yDist: null })
              } else {
                ring.holding = false
                ring.resolved = true
                ring.holdCompleted = true
                scoreRef.current.recordHit('good')
                judgementEventsRef.current.push({ result: 'good', y: ring.targetY, at: songTimeMs, errorMs: e, yDist: null })
              }
            }
            continue
          }
          const windowMs = timeline.beatMsAt(timeline.msToBeat(ring.hitTime)) * 0.4
          if (songTimeMs - getManualOffsetMs() > ring.hitTime + windowMs) {
            ring.resolved = true
            scoreRef.current.recordHit('miss')
            judgementEventsRef.current.push({ result: 'miss', y: ring.targetY, at: songTimeMs, errorMs: null, yDist: null })
          }
        }
      }

      judgementEventsRef.current = judgementEventsRef.current.filter(
        (e) => songTimeMs - e.at < JUDGEMENT_LIFETIME_MS,
      )

      if (startedRef.current) {
        const isOnWave = Math.abs(cursorRef.current.y - wave.waveYAtMs(renderTimeMs)) < TW_TOLERANCE;
        scoreRef.current.recordTrace(dt, isOnWave, currentBeatMs)
      }

      renderer.render(ctx2d, {
        waveEngine: wave,
        cursor: cursorRef.current,
        rings: ringsRef.current,
        score: scoreRef.current,
        songTimeMs: songTimeMs,
        bpmTimeline: timeline,
        judgementEvents: judgementEventsRef.current,
        scrollSpeed: 110 * timeline.zoomAt(currentBeat),
        showJudgementDetail: getViewMode() === 'debug',
      })

      // T206: end-of-song priority = end_beat → last ring (incl. hold tail) +2s → audio length.
      // T210: only the main phase ends the song; the tutorial auto-advances instead.
      const lastHitTime =
        chart.rings.length > 0
          ? timeline.beatToMs(chart.rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity))
          : null
      const buffer = bufferRef.current
      const fallbackEnd = lastHitTime !== null ? lastHitTime + END_DELAY_MS : 60000
      const baseEnd = chart.end_beat !== undefined
        ? timeline.beatToMs(chart.end_beat)
        : lastHitTime !== null
          ? lastHitTime + END_DELAY_MS
          : (buffer ? buffer.duration * 1000 : fallbackEnd)
      const endThreshold = baseEnd + (chart?.audio_offset ?? 0)

      if (!endedRef.current && phaseRef.current === 'main' && songTimeMs > endThreshold) {
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

  // T210: auto-play the tutorial once the chart is loaded (public mode only).
  // Skipping sets phase to 'main' so this never re-runs for the main chart.
  useEffect(() => {
    if (status !== 'ready') return
    if (phase !== 'tutorial') return
    void startGame()
  }, [status, phase, startGame])

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
        keysRef.current.space = true
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
      if (e.code === 'Space') {
        if (startedRef.current && statusRef.current === 'ready') {
          try {
            const songTimeMs = songNow()
            const timeline = timelineRef.current
            const chart = chartRef.current
            if (!timeline || !chart) return
            let bestRing: RingState | null = null
            let bestDist = Infinity
            const beatMs = timeline.beatMsAt(timeline.msToBeat(songTimeMs))
            const windowMs = beatMs * 0.4
            for (const ring of ringsRef.current) {
              if (ring.resolved || !ring.hit || ring.type !== 'hold' || !ring.holding) continue
              const releaseTime = ring.releaseTime ?? ring.hitTime
              const dist = Math.abs(releaseTime - (songTimeMs - getManualOffsetMs()))
              if (dist < bestDist) {
                bestDist = dist
                bestRing = ring
              }
            }
            if (bestRing) {
              const releaseTime = bestRing.releaseTime ?? bestRing.hitTime
              const e = (songTimeMs - getManualOffsetMs()) - releaseTime
              if (e < -windowMs) {
                bestRing.holding = false
                bestRing.resolved = true
                scoreRef.current.recordHit('miss')
                judgementEventsRef.current.push({ result: 'miss', y: bestRing.targetY, at: songTimeMs, errorMs: null, yDist: null })
              } else if (Math.abs(e) <= windowMs) {
                let releaseResult: 'perfect' | 'great' | 'good'
                if (Math.abs(e) < 50) releaseResult = 'perfect'
                else if (Math.abs(e) < 100) releaseResult = 'great'
                else releaseResult = 'good'
                bestRing.holding = false
                bestRing.resolved = true
                bestRing.holdCompleted = true
                scoreRef.current.recordHit(releaseResult)
                judgementEventsRef.current.push({ result: releaseResult, y: bestRing.targetY, at: songTimeMs, errorMs: e, yDist: null })
              } else {
                bestRing.holding = false
                bestRing.resolved = true
                bestRing.holdCompleted = true
                scoreRef.current.recordHit('good')
                judgementEventsRef.current.push({ result: 'good', y: bestRing.targetY, at: songTimeMs, errorMs: e, yDist: null })
              }
            }
          } catch {
            // AudioContext not ready
          }
        }
        keysRef.current.space = false
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [navigate, startGame, handleHit])

  return (
    <div className="screen game-screen screen-fade">
      {status === 'loading' && <p className="game-status">譜面を読み込み中...</p>}
      {status === 'error' && (
        <div className="game-error">
          <p>{error}</p>
          <button onClick={() => { if (onExitRef.current) onExitRef.current(); else navigate('/') }}>
            {onExitRef.current ? 'エディタに戻る' : '曲選択に戻る'}
          </button>
        </div>
      )}
      {status === 'ready' && (
        <>
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="game-canvas"
            data-testid="playtest-canvas"
          />
          {onExitRef.current && (
            <button
              type="button"
              className="game-exit"
              onClick={() => onExitRef.current?.()}
              data-testid="playtest-exit"
            >
              終了
            </button>
          )}
          {phase === 'tutorial' && (
            <div className="tutorial-overlay" data-testid="tutorial-overlay">
              <div className="tutorial-instruction" data-testid="tutorial-instruction">
                {tutorialInstruction || getTutorialInstruction(0)}
              </div>
              <button
                type="button"
                className="tutorial-skip"
                data-testid="tutorial-skip"
                onClick={skipTutorial}
              >
                スキップ (本編へ)
              </button>
            </div>
          )}
          <div className="game-offset">
            offset: {offsetMs >= 0 ? '+' : ''}
            {offsetMs}ms
          </div>
          <div className="game-hint">Space: 判定 / ↑↓: 移動 / ESC: 戻る</div>
        </>
      )}
    </div>
  )
}
