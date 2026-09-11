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
import { ScoreManager, maxRingScore, rankForScore, type ScoreStats } from '../game/score'
import {
  generateWavePracticeChart,
  generateRingPracticeChart,
  generateHoldPracticeChart,
  getTutorialInstruction,
  TUTORIAL_HOLD_END_BEAT,
  type TutorialStage,
} from '../game/tutorial'
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
  const wavePracticeChartRef = useRef<Chart | null>(null)
  const wavePracticeTimelineRef = useRef<BpmTimeline | null>(null)
  const wavePracticeWaveRef = useRef<WaveEngine | null>(null)
  const wavePracticeEndRef = useRef(0)
  const ringPracticeChartRef = useRef<Chart | null>(null)
  const ringPracticeTimelineRef = useRef<BpmTimeline | null>(null)
  const ringPracticeWaveRef = useRef<WaveEngine | null>(null)
  const ringPracticeEndRef = useRef(0)
  const holdPracticeChartRef = useRef<Chart | null>(null)
  const holdPracticeTimelineRef = useRef<BpmTimeline | null>(null)
  const holdPracticeWaveRef = useRef<WaveEngine | null>(null)
  const holdPracticeEndRef = useRef(0)
  const tutorialStageRef = useRef<TutorialStage>('wave')
  // T211: key-press confirmation — the clock only starts after the first
  // ArrowUp/ArrowDown (stage A) or Space (stage B) press.
  const tutorialConfirmedRef = useRef(false)
  const cursorRef = useRef(new Cursor())
  const spawnerRef = useRef(new RingSpawner())
  const scoreRef = useRef(new ScoreManager())
  const ringsRef = useRef<RingState[]>([])
  // HUD best display (null = no record yet, undefined = not fetched).
  // CalibrationModal does not pass bestScore, so its HUD is unchanged.
  const bestScoreRef = useRef<number | null | undefined>(undefined)
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
  const [phase, setPhase] = useState<'tutorial-wave' | 'tutorial-ring' | 'tutorial-hold' | 'main'>(() =>
    getViewMode() === 'public' && !isPlaytest ? 'tutorial-wave' : 'main',
  )
  const phaseRef = useRef(phase)
  const [tutorialInstruction, setTutorialInstruction] = useState('')
  // T213: 暗さの制御はオーバーレイ層のみに一本化する（canvasは常時不透明度1）。
  // チュートリアル待機（押下前）と本編のSpace待ちは減光ON、練習中は減光OFF。
  const [overlayDimmed, setOverlayDimmed] = useState(true)
  // 本編の音楽開始はSpace待ちに統一する（チュートリアル完了後・スキップ時・デバッグ初回）。
  // trueの間は時計・判定・終了判定を進めず、「Spaceを押してスタート」の指示だけ出す。
  const [mainWaiting, setMainWaiting] = useState(
    () => !(getViewMode() === 'public' && !isPlaytest),
  )
  const mainWaitingRef = useRef(!(getViewMode() === 'public' && !isPlaytest))

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
    // NOTE: 音楽・メトロノームの開始は呼び出し側が明示的に行う。
    // チュートリアル確認 → confirmTutorialStart がメトロノームのみ開始。
    // 本編 → Space待ち経路が startMainMusic で音楽＋メトロノームを開始。
  }, [])

  // 本編の音楽開始（Space待ち解除時）。スポナー・リング・カーソルを初期化し、
  // 時計リセット→音楽＋メトロノーム開始までを一気に行う。
  // デバッグ用アクセスカウンタもここで加算する（プレイテストは除外）。
  const startMainMusic = useCallback(async () => {
    const audioMgr = AudioManager.getInstance()
    await audioMgr.ensure()
    const ctx = audioMgr.ctx
    const chart = chartRef.current
    spawnerRef.current = new RingSpawner()
    ringsRef.current = []
    judgementEventsRef.current = []
    cursorRef.current = new Cursor(chart?.amplitude ?? 1.0, chart?.start_position ?? 0.0)
    keysRef.current = { up: false, down: false, space: true }
    resetClock(ctx)
    startedRef.current = true
    if (!isPlaytest) {
      try {
        const { recordPlay } = await import('../storage/playCounts')
        // Global key = title (copies imported on other PCs share the title,
        // so festival-wide counts accumulate). Local key = song id.
        void recordPlay(songId ?? chart?.title ?? '', chart?.title)
      } catch {
        /* ignore counter errors */
      }
      // HUD best display: fetch once at song start (frozen during play).
      try {
        const { fetchBestScores } = await import('../storage/highScores')
        const all = await fetchBestScores()
        const title = chart?.title ?? ''
        bestScoreRef.current = title && all[title] !== undefined ? all[title].score : null
      } catch {
        bestScoreRef.current = null
      }
    }
    playMusic(ctx, chart?.audio_offset ?? 0)
    startMetronome(ctx)
  }, [playMusic, startMetronome, isPlaytest, songId])

  // T211: called on the first ArrowUp/ArrowDown (stage A) or Space (stage B)
  // press. Resets the clock so practice starts now, clears the overlay dim
  // (canvas is always fully opaque — dimming lives on the overlay layer only).
  const confirmTutorialStart = useCallback(() => {
    if (tutorialConfirmedRef.current) return
    tutorialConfirmedRef.current = true
    setOverlayDimmed(false)
    try {
      const ctx = AudioManager.getInstance().ctx
      resetClock(ctx)
      startMetronome(ctx)
    } catch {
      // AudioContext not initialized yet
    }
  }, [startMetronome])

  // T211: swap the wave-practice chart for the ring-practice chart after stage
  // A completes. The ring stage also waits (dimmed overlay, clock paused) for
  // its confirmation key (Space).
  const startRingStage = useCallback(() => {
    if (phaseRef.current !== 'tutorial-wave') return
    const chart = ringPracticeChartRef.current
    const timeline = ringPracticeTimelineRef.current
    const wave = ringPracticeWaveRef.current
    if (!chart || !timeline || !wave) return
    stopMetronome()
    chartRef.current = chart
    timelineRef.current = timeline
    waveRef.current = wave
    cursorRef.current = new Cursor(chart.amplitude, chart.start_position)
    // 玉を開始拍の波形位置に完全に合わせる
    cursorRef.current.y = wave.waveYAt(0)
    ringsRef.current = []
    judgementEventsRef.current = []
    keysRef.current = { up: false, down: false, space: false }
    tutorialStageRef.current = 'ring'
    tutorialConfirmedRef.current = false
    setOverlayDimmed(true)
    setTutorialInstruction(getTutorialInstruction(0, 'ring'))
    phaseRef.current = 'tutorial-ring'
    setPhase('tutorial-ring')
    try {
      const ctx = AudioManager.getInstance().ctx
      resetClock(ctx)
    } catch {
      // AudioContext not initialized yet
    }
  }, [stopMetronome])

  // T226: swap the ring-practice chart for the hold-practice chart after stage
  // B completes. The hold stage also waits (dimmed overlay, clock paused) for
  // its confirmation key (Space).
  const startHoldStage = useCallback(() => {
    if (phaseRef.current !== 'tutorial-ring') return
    const chart = holdPracticeChartRef.current
    const timeline = holdPracticeTimelineRef.current
    const wave = holdPracticeWaveRef.current
    if (!chart || !timeline || !wave) return
    stopMetronome()
    chartRef.current = chart
    timelineRef.current = timeline
    waveRef.current = wave
    cursorRef.current = new Cursor(chart.amplitude, chart.start_position)
    // 玉を開始拍の波形位置に完全に合わせる
    cursorRef.current.y = wave.waveYAt(0)
    ringsRef.current = []
    judgementEventsRef.current = []
    keysRef.current = { up: false, down: false, space: false }
    tutorialStageRef.current = 'hold'
    tutorialConfirmedRef.current = false
    setOverlayDimmed(true)
    setTutorialInstruction(getTutorialInstruction(0, 'hold'))
    phaseRef.current = 'tutorial-hold'
    setPhase('tutorial-hold')
    try {
      const ctx = AudioManager.getInstance().ctx
      resetClock(ctx)
    } catch {
      // AudioContext not initialized yet
    }
  }, [stopMetronome])

  // T210: swap the tutorial engines for the main chart, discard any tutorial
  // score / combo / trace bonus. 本編の音楽はすぐ鳴らさず Space 待ちにする
  // （チュートリアル完了後・スキップ時・デバッグ初回で統一）。
  const enterMain = useCallback(() => {
    // 二重timeout・スキップ連打での二重実行を防止（処理自体は冪等だが明示化）。
    if (phaseRef.current === 'main') return
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
    spawnerRef.current = new RingSpawner()
    ringsRef.current = []
    judgementEventsRef.current = []
    cursorRef.current = new Cursor(chart.amplitude, chart.start_position)
    keysRef.current = { up: false, down: false, space: false }
    phaseRef.current = 'main'
    setPhase('main')
    // 本編はSpace待ちに入る：オーバーレイを減光して待機表示（canvasは常時1）。
    setOverlayDimmed(true)
    mainWaitingRef.current = true
    setMainWaiting(true)
  }, [stopMusic, stopMetronome])

  const skipTutorial = useCallback(() => {
    if (phaseRef.current === 'main') return
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
        // F5リロード直後はジェスチャーが無くresume()が保留されうるため、
        // タイムアウト付きで待つ（デコードはsuspendedでも動作する）。
        // 音は初回Space時の再ensureで鳴る。
        await Promise.race([
          audioMgr.ensure(),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ])
        // T187: base tempo is derived internally from the first (beat-min) section
        const timeline = new BpmTimeline(chart.bpm_changes, chart.amplitude)
        const mainWave = new WaveEngine(chart.segments, timeline, chart.amplitude, chart.start_position)
        mainChartRef.current = chart
        mainTimelineRef.current = timeline
        mainWaveRef.current = mainWave

        // T211: fixed, code-generated 2-stage tutorial charts (BPM90, metronome only).
        const wavePracticeChart = generateWavePracticeChart()
        const wavePracticeTimeline = new BpmTimeline(wavePracticeChart.bpm_changes, wavePracticeChart.amplitude)
        const wavePracticeWave = new WaveEngine(
          wavePracticeChart.segments,
          wavePracticeTimeline,
          wavePracticeChart.amplitude,
          wavePracticeChart.start_position,
        )
        wavePracticeChartRef.current = wavePracticeChart
        wavePracticeTimelineRef.current = wavePracticeTimeline
        wavePracticeWaveRef.current = wavePracticeWave
        wavePracticeEndRef.current = wavePracticeTimeline.beatToMs(4)

        const ringPracticeChart = generateRingPracticeChart()
        const ringPracticeTimeline = new BpmTimeline(ringPracticeChart.bpm_changes, ringPracticeChart.amplitude)
        const ringPracticeWave = new WaveEngine(
          ringPracticeChart.segments,
          ringPracticeTimeline,
          ringPracticeChart.amplitude,
          ringPracticeChart.start_position,
        )
        ringPracticeChartRef.current = ringPracticeChart
        ringPracticeTimelineRef.current = ringPracticeTimeline
        ringPracticeWaveRef.current = ringPracticeWave
        ringPracticeEndRef.current = ringPracticeTimeline.beatToMs(5)

        const holdPracticeChart = generateHoldPracticeChart()
        const holdPracticeTimeline = new BpmTimeline(holdPracticeChart.bpm_changes, holdPracticeChart.amplitude)
        const holdPracticeWave = new WaveEngine(
          holdPracticeChart.segments,
          holdPracticeTimeline,
          holdPracticeChart.amplitude,
          holdPracticeChart.start_position,
        )
        holdPracticeChartRef.current = holdPracticeChart
        holdPracticeTimelineRef.current = holdPracticeTimeline
        holdPracticeWaveRef.current = holdPracticeWave
        holdPracticeEndRef.current = holdPracticeTimeline.beatToMs(TUTORIAL_HOLD_END_BEAT)

        // T210/T211: tutorial only for public normal play. Debug / playtest go
        // straight to the main chart (本編先行読込済み).
        const useTutorial = getViewMode() === 'public' && !isPlaytest
        if (useTutorial) {
          chartRef.current = wavePracticeChart
          timelineRef.current = wavePracticeTimeline
          waveRef.current = wavePracticeWave
          cursorRef.current = new Cursor(wavePracticeChart.amplitude, wavePracticeChart.start_position)
          // 玉を開始拍の波形位置に完全に合わせる
          cursorRef.current.y = wavePracticeWave.waveYAt(0)
          tutorialStageRef.current = 'wave'
          tutorialConfirmedRef.current = false
          setOverlayDimmed(true)
          phaseRef.current = 'tutorial-wave'
          setPhase('tutorial-wave')
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
      // T211: while a tutorial stage waits for its confirmation key the clock
      // stays frozen (songTimeMs = 0) even though the AudioContext has started.
      const inTutorialWait = phaseRef.current !== 'main' && !tutorialConfirmedRef.current
      // 本編のSpace待ち中も時計・判定・終了判定を進めない（静止した波形を背景表示）。
      const inMainWait = phaseRef.current === 'main' && mainWaitingRef.current
      if (startedRef.current && !inTutorialWait && !inMainWait) {
        try {
          songTimeMs = songNow()
        } catch {
          songTimeMs = 0
        }
      }
      // T211/T226: tutorial stages advance by beats once the confirmation key
      // gave the go-ahead:
      //   tutorial-wave  → 4 beats complete → tutorial-ring
      //   tutorial-ring  → final ring (beat 4) + small margin → tutorial-hold
      //   tutorial-hold  → final hold tail (beat 6) + margin → main chart
      if (
        startedRef.current &&
        tutorialConfirmedRef.current &&
        phaseRef.current === 'tutorial-wave' &&
        songTimeMs > wavePracticeEndRef.current
      ) {
        setTimeout(() => startRingStage(), 0)
      }
      if (
        startedRef.current &&
        tutorialConfirmedRef.current &&
        phaseRef.current === 'tutorial-ring' &&
        songTimeMs > ringPracticeEndRef.current
      ) {
        setTimeout(() => startHoldStage(), 0)
      }
      if (
        startedRef.current &&
        tutorialConfirmedRef.current &&
        phaseRef.current === 'tutorial-hold' &&
        songTimeMs > holdPracticeEndRef.current
      ) {
        // 他ステージと同様にdeferする：同フレーム内でenterMain()を直呼びすると
        // inMainWait等のフラグが遷移前判定のまま残り、作り直し直後のスポナーが
        // チュートリアル時計時刻で全リングを期限切れMISSにしてしまう。
        // 次フレームは fresh な main-wait として凍結される。
        setTimeout(() => enterMain(), 0)
      }
      const renderTimeMs = songTimeMs - getManualOffsetMs()

      // T211: beat-synced instruction overlay while the tutorial runs
      if (
        phaseRef.current === 'tutorial-wave' ||
        phaseRef.current === 'tutorial-ring' ||
        phaseRef.current === 'tutorial-hold'
      ) {
        const stage = tutorialStageRef.current
        const text = getTutorialInstruction(timeline.msToBeat(renderTimeMs), stage)
        setTutorialInstruction((prev) => (prev === text ? prev : text))
      }

      // 本編のSpace待ち中はリングを出さない（開始時にスポナーを作り直すため）。
      ringsRef.current = inMainWait ? [] : spawnerRef.current.update(songTimeMs, chart.rings, timeline, wave)

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
      if (startedRef.current && !inMainWait) {
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

      if (startedRef.current && !inMainWait) {
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
        bestScore: bestScoreRef.current,
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

      if (!endedRef.current && phaseRef.current === 'main' && !inMainWait && songTimeMs > endThreshold) {
        endedRef.current = true
        stopMusic()
        stopMetronome()
        const stats = scoreRef.current.getStats()
        if (onExitRef.current) {
          onExitRef.current(stats)
        } else {
          // Rank is decided by score alone (ratio to the chart's max ring score).
          const max = maxRingScore(chart?.rings ?? [])
          const rank = rankForScore(stats.score, max)
          navigate('/result', { state: { stats, songId, title: chart.title, rank } })
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
  }, [status, navigate, stopMusic, stopMetronome, songId, enterMain, startRingStage])

  // T211: the tutorial does NOT auto-play. Each stage waits (clock paused,
  // canvas dimmed) for its confirmation key, which calls startGame() +
  // confirmTutorialStart() on the first press. Skipping sets phase to 'main'.

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
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (e.key === 'ArrowUp') keysRef.current.up = true
        if (e.key === 'ArrowDown') keysRef.current.down = true
        // T211: stage A waits for the first arrow press to start practice.
        if (
          statusRef.current === 'ready' &&
          phaseRef.current === 'tutorial-wave' &&
          !tutorialConfirmedRef.current
        ) {
          void (async () => {
            if (!startedRef.current) await startGame()
            confirmTutorialStart()
          })()
        }
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        if (statusRef.current !== 'ready') return
        keysRef.current.space = true
        // オートリピートは判定に回さない（CalibrationModalと同一ガード）。
        // 押し続け判定（ホールド維持）はkeysRef.spaceのレベル参照のため不変。
        if (e.repeat) return
        const inTutorial = phaseRef.current !== 'main'
        if (inTutorial) {
          // T211/T226: stage B/C each wait for the first Space press to start.
          if (
            (phaseRef.current === 'tutorial-ring' || phaseRef.current === 'tutorial-hold') &&
            !tutorialConfirmedRef.current
          ) {
            void (async () => {
              if (!startedRef.current) await startGame()
              confirmTutorialStart()
            })()
          } else if (tutorialConfirmedRef.current) {
            handleHit()
          }
          return
        }
        // 本編のSpace待ち（チュートリアル完了後・スキップ時・デバッグ初回で統一）:
        // この1打は開始合図として消費し、判定には回さない。
        if (mainWaitingRef.current || !startedRef.current) {
          mainWaitingRef.current = false
          setMainWaiting(false)
          void (async () => {
            try {
              await startMainMusic()
            } catch {
              // AudioContext not ready — stay waiting
              mainWaitingRef.current = true
              setMainWaiting(true)
            }
          })()
          return
        }
        handleHit()
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
  }, [navigate, startGame, startMainMusic, handleHit, confirmTutorialStart])

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
          {(phase === 'tutorial-wave' || phase === 'tutorial-ring' || phase === 'tutorial-hold') && (
            <div
              className={`tutorial-overlay${overlayDimmed ? ' dim' : ' clear'}`}
              data-testid="tutorial-overlay"
            >
              <button
                type="button"
                className="tutorial-skip"
                data-testid="tutorial-skip"
                onClick={skipTutorial}
              >
                スキップ (本編へ)
              </button>
              <div className="tutorial-instruction" data-testid="tutorial-instruction">
                {tutorialInstruction || getTutorialInstruction(0, tutorialStageRef.current)}
              </div>
            </div>
          )}
          {phase === 'main' && mainWaiting && (
            <div className="tutorial-overlay dim main-wait" data-testid="main-wait-overlay">
              <div className="tutorial-instruction" data-testid="main-wait-instruction">
                Spaceを押してスタート
              </div>
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
