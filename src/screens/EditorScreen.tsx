import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioManager } from '../audio/AudioManager'
import { AudioCache, getBasename } from '../audio/AudioCache'
import { BpmTimeline } from '../audio/bpmTimeline'
import { loadAudio, loadAudioFromFile } from '../audio/loader'
import { parseChartText } from '../chart/loader'
import { chartToToml } from '../chart/serialize'
import { Cursor } from '../game/cursor'
import { WaveEngine } from '../game/waveEngine'
import { segmentize, quantizeBeat, type TrajPoint } from '../chart/quantize'
import type { BpmChange, Chart, RingDef, Segment } from '../types'
import BpmEditor from './editor/BpmEditor'
import SegmentEditor from './editor/SegmentEditor'
import WavePreview, { type WaveView } from './editor/WavePreview'
import GameScreen from './GameScreen'

const SNAP_OPTIONS = [0.125, 0.25, 0.5, 1]

const GAME_CENTER_Y = 300

function formatSeconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  const tenth = Math.floor((ms % 1000) / 100)
  return `${m}:${sec.toString().padStart(2, '0')}.${tenth}`
}

function truncateSegmentsTo(
  segs: Segment[],
  beat: number,
  timeline: BpmTimeline,
  amplitude: number,
): { kept: Segment[]; startY: number } {
  const engine = new WaveEngine(segs, timeline, amplitude)
  const startY = segs.length > 0 ? engine.waveYAt(beat) : GAME_CENTER_Y
  if (beat <= 0) return { kept: [], startY }
  let cum = 0
  const kept: Segment[] = []
  for (const seg of segs) {
    const end = cum + seg.beats
    if (end <= beat) {
      kept.push(seg)
      cum = end
    } else {
      const part = beat - cum
      if (part > 0.0001) {
        kept.push({ direction: seg.direction, beats: Number(part.toFixed(4)) })
      }
      cum = beat
      break
    }
  }
  return { kept, startY }
}

export default function EditorScreen() {
  const [title, setTitle] = useState('Reply')
  const [artist, setArtist] = useState('')
  const [url, setUrl] = useState('/rhythm_game/audio/08.Reply.flac')
  const [bpm, setBpm] = useState(120)
  const [amplitude, setAmplitude] = useState(130)
  const [scrollSpeed, setScrollSpeed] = useState(110)
  const [audioOffset, setAudioOffset] = useState(0)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [durationMs, setDurationMs] = useState(0)
  const [positionMs, setPositionMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snap, setSnap] = useState(0.25)
  const [rings, setRings] = useState<RingDef[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [bpmChanges, setBpmChanges] = useState<BpmChange[]>([])
  const [playtest, setPlaytest] = useState<{ chart: Chart; buffer: AudioBuffer | null } | null>(null)
  const [selectedRing, setSelectedRing] = useState<number | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [ringDetailsOpen, setRingDetailsOpen] = useState(false)
  const [mode, setMode] = useState<'play' | 'record'>('play')
  const [view, setView] = useState<WaveView>({ startBeat: 0, beats: 16 })
  const [recLive, setRecLive] = useState<{ beat: number; y: number; trajectory: { beat: number; y: number }[] } | null>(null)

  useEffect(() => {
    if (rings.length > 0) {
      setRingDetailsOpen(true)
    }
  }, [rings.length])

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__editorSegments = segments
    w.__editorRings = rings
    w.__editorSnap = snap
    w.__editorAudioOffset = audioOffset
    w.__editorView = view
    w.__editorTimeline = timeline
    w.__editorBeat = beat
    w.__editorRecTraj = recTrajRef.current
    w.__editorRecLive = recLive
    w.__editorRecStartBeat = recStartBeatRef.current
    w.__editorQuantizeModule = { quantizeBeat, segmentize }
    w.__editorSeekToBeat = seekToBeat
    // __editorState facade: populated after startRecording/finishRecording are defined
    const facade = (w.__editorState ?? {}) as Record<string, unknown>
    facade.segments = segments
    w.__editorState = facade
  })

  const playtestActiveRef = useRef(false)
  const toastTimerRef = useRef<number | null>(null)
  const modeRef = useRef<'play' | 'record'>('play')
  const recCursorRef = useRef<Cursor | null>(null)
  const recTrajRef = useRef<TrajPoint[]>([])
  const recStartBeatRef = useRef(0)
  const recStartYRef = useRef(GAME_CENTER_Y)
  const lastTickRef = useRef(0)
  const keysRef = useRef({ up: false, down: false, space: false })
  const spacePressBeatRef = useRef(0)

  const notify = useCallback((msg: string) => {
    setToastMsg(msg)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 2500)
  }, [])

  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startCtxTimeRef = useRef(0)
  const startMsRef = useRef(0)
  const positionRef = useRef(0)
  const endMsRef = useRef(0)
  const isPlayingRef = useRef(false)

  const setPlaying = (v: boolean) => {
    isPlayingRef.current = v
    setIsPlaying(v)
  }

  const safeBpm = bpm > 0 ? bpm : 120
  const timeline = useMemo(() => new BpmTimeline(safeBpm, bpmChanges), [safeBpm, bpmChanges])
  const beat = timeline.msToBeat(positionMs)
  const contentBeats = Math.max(
    segments.reduce((s, seg) => s + seg.beats, 0),
    rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), 0),
    8,
  )

  const finishRecording = useCallback(() => {
    if (modeRef.current !== 'record') return
    modeRef.current = 'play'
    setMode('play')
    const traj = recTrajRef.current
    if (traj.length >= 2) {
      const startBeat = recStartBeatRef.current
      const sorted = [...traj].sort((a, b) => a.beat - b.beat)
      const endBeat = sorted[sorted.length - 1].beat

      const { kept: keptBefore } = truncateSegmentsTo(segments, startBeat, timeline, amplitude)
      const newSegs = segmentize(traj, snap, amplitude)

      // Keep only whole segments that start at or after endBeat (no split remainder)
      // This matches the spec: overwrite [startBeat, endBeat) range, preserve segments starting at/after endBeat intact
      let cum = 0
      let endIdx = segments.length
      for (let i = 0; i < segments.length; i++) {
        if (cum >= endBeat - 1e-9) {
          endIdx = i
          break
        }
        cum += segments[i].beats
      }
      // If loop finished without break, endIdx stays at segments.length (all overwritten)
      // Edge: if endBeat is exactly at a boundary, cum at that boundary == endBeat, so we correctly start from that index
      const keptAfter = segments.slice(endIdx)
      ;(window as unknown as Record<string, unknown>).__lastFinishRecording = {
        startBeat,
        endBeat,
        keptBefore,
        newSegs,
        keptAfter,
        final: [...keptBefore, ...newSegs, ...keptAfter],
      }

      setSegments([...keptBefore, ...newSegs, ...keptAfter])
      notify(`波形を記録 (${newSegs.length}セグメント)`)
    }
    setRecLive(null)
    recCursorRef.current = null
    recTrajRef.current = []
  }, [segments, snap, amplitude, timeline, notify])

  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    lastTickRef.current = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(0.05, (now - lastTickRef.current) / 1000)
      lastTickRef.current = now
      const ctx = AudioManager.getInstance().ctx
      const pos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000
      if (pos >= endMsRef.current) {
        if (sourceRef.current) {
          sourceRef.current.disconnect()
          sourceRef.current = null
        }
        setPositionMs(endMsRef.current)
        positionRef.current = endMsRef.current
        if (modeRef.current === 'record') finishRecording()
        setPlaying(false)
      } else {
        setPositionMs(pos)
        positionRef.current = pos
        if (modeRef.current === 'record' && recCursorRef.current) {
          const rawBeat = timeline.msToBeat(pos)
          const beat = quantizeBeat(rawBeat, snap)
          const beatMs = timeline.beatMsAt(rawBeat)
          recCursorRef.current.update(dt, keysRef.current.up, keysRef.current.down, beatMs)
          recTrajRef.current.push({ beat, y: recCursorRef.current.y, down: keysRef.current.up || keysRef.current.down })
          setRecLive({
            beat,
            y: recCursorRef.current.y,
            trajectory: recTrajRef.current.slice(),
          })
        }
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, buffer, timeline, finishRecording])

  useEffect(() => {
    return () => {
      if (sourceRef.current) {
        try {
          sourceRef.current.stop()
        } catch {
          /* already ended */
        }
        sourceRef.current.disconnect()
        sourceRef.current = null
      }
    }
  }, [])

  const loadLocalFile = useCallback(async (file: File) => {
    const mgr = AudioManager.getInstance()
    await mgr.ensure()
    const ctx = mgr.ctx
    setLoadingAudio(true)
    const buf = await loadAudioFromFile(file, ctx)
    setLoadingAudio(false)
    if (buf) {
      if (sourceRef.current) {
        try {
          sourceRef.current.stop()
        } catch {
          /* already ended */
        }
        sourceRef.current.disconnect()
        sourceRef.current = null
        setPlaying(false)
      }
      setBuffer(buf)
      setDurationMs(buf.duration * 1000)
      setPositionMs(0)
      positionRef.current = 0
      const name = file.name.replace(/\.[^.]+$/, '')
      if (name) setTitle(name)
      setUrl(file.name)
      AudioCache.set(getBasename(file.name), buf)
      setError(null)
      notify(`${file.name} を読み込みました`)
    } else {
      setError('ローカル音声ファイルのデコードに失敗しました')
    }
  }, [notify])

  const playFrom = async (fromMs: number) => {
    const mgr = AudioManager.getInstance()
    await mgr.ensure()
    const ctx = mgr.ctx
    let buf = buffer
    let audioFailed = false
    if (!buf) {
      setLoadingAudio(true)
      buf = await loadAudio(url, ctx)
      setLoadingAudio(false)
      if (buf) {
        setBuffer(buf)
        setDurationMs(buf.duration * 1000)
        AudioCache.set(getBasename(url), buf)
      } else {
        audioFailed = true
      }
    } else {
      AudioCache.set(getBasename(url), buf)
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.stop()
      } catch {
        /* already ended */
      }
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (buf) {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const offsetSec = audioOffset / 1000
      const audioTime = Math.max(0, fromMs / 1000)
      let startWhen: number
      let startOffset: number
      if (offsetSec >= 0) {
        startWhen = ctx.currentTime + offsetSec
        startOffset = audioTime
      } else {
        startWhen = ctx.currentTime
        startOffset = Math.max(0, audioTime - offsetSec)
      }
      src.start(startWhen, startOffset)
      const hook: Record<string, unknown> = {
        when: startWhen,
        offset: startOffset,
        audioOffset,
        ctxTime: ctx.currentTime,
        fromMs,
      }
      ;(window as unknown as Record<string, unknown>).__editorPlayFrom = hook
      ;(window as unknown as Record<string, unknown>).__editorPlayFromStartParams = {
        when: startWhen,
        offset: startOffset,
        audioTime,
        ctxCurrentTime: ctx.currentTime,
      }
      ;(window as unknown as Record<string, unknown>).__editorPlayFromOffset = audioOffset
      src.onended = () => {
        if (sourceRef.current === src) {
          sourceRef.current = null
          setPlaying(false)
        }
      }
      sourceRef.current = src
    }
    const contentBeats = Math.max(
      segments.reduce((s, seg) => s + seg.beats, 0),
      rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), 0),
      8,
    )
    const fallbackMs = Math.max(timeline.beatToMs(contentBeats + 4), 30000)
    endMsRef.current = buf ? buf.duration * 1000 : fallbackMs
    startCtxTimeRef.current = ctx.currentTime
    startMsRef.current = fromMs
    setPlaying(true)
    setError(
      audioFailed
        ? '音楽ファイルの読み込みに失敗しました（メトロノームのみで続行）'
        : null,
    )
  }

  const startRecording = useCallback(() => {
    let rawStartBeat: number
    if (lastSeekBeatRef.current !== null && performance.now() - lastSeekTimeRef.current < 2000) {
      rawStartBeat = lastSeekBeatRef.current
    } else {
      rawStartBeat = timeline.msToBeat(positionRef.current)
    }
    const startBeat = quantizeBeat(rawStartBeat, snap)
    recStartBeatRef.current = startBeat
    const engine = new WaveEngine(segments, timeline, amplitude)
    const startY = segments.length > 0 ? engine.waveYAt(startBeat) : GAME_CENTER_Y
    recStartYRef.current = startY
    const cursor = new Cursor(amplitude)
    cursor.y = startY
    recCursorRef.current = cursor
    recTrajRef.current = [{ beat: startBeat, y: startY, down: false }]
    modeRef.current = 'record'
    setMode('record')
    setRecLive({ beat: startBeat, y: startY, trajectory: recTrajRef.current.slice() })
  }, [timeline, segments, amplitude, positionMs])

  const stop = () => {
    const src = sourceRef.current
    if (!src) return
    const ctx = AudioManager.getInstance().ctx
    const pos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000
    const clamped = buffer ? Math.min(pos, buffer.duration * 1000) : pos
    setPositionMs(clamped)
    positionRef.current = clamped
    try {
      src.stop()
    } catch {
      /* already ended */
    }
    src.disconnect()
    sourceRef.current = null
    setPlaying(false)
  }

  // __editorState facade for tests: expose control methods after they are defined
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    const facade = (w.__editorState ?? {}) as Record<string, unknown>
    facade.seekToBeat = seekToBeat
    facade.enterRecordMode = async () => {
      // Seek position to target beat, then start playback so the recording RAF loop runs
      if (isPlayingRef.current) {
        stop()
      }
      // startRecording reads positionRef.current / lastSeekBeatRef, then must have isPlaying=true
      startRecording()
      await playFrom(positionRef.current)
    }
    facade.exitRecordMode = () => {
      finishRecording()
      stop()
    }
    facade.loadInitialSegments = (segs: typeof segments) => {
      setSegments(segs)
    }
    w.__editorState = facade
  })

  const toggle = () => {
    if (isPlaying) {
      stop()
    } else {
      void playFrom(positionMs)
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (playtestActiveRef.current) return

      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const editable =
        tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable === true
      if (editable) return

      // T103: ring stamping via Space is only allowed in record mode.
      if (e.code === 'Space') {
        e.preventDefault()
        if (!isPlayingRef.current) return
        if (modeRef.current !== 'record') return
        if (keysRef.current.space) return
        const rawBeat = timeline.msToBeat(positionRef.current)
        const snapped = quantizeBeat(rawBeat, snap)
        spacePressBeatRef.current = snapped
        keysRef.current.space = true
        return
      }

      if (!editable && (e.code === 'Delete' || e.code === 'Backspace')) {
        if (selectedRing != null) {
          e.preventDefault()
          removeRing(selectedRing)
        }
        return
      }

      if (!isPlayingRef.current) return

      if (modeRef.current === 'record') {
        if (e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW') {
          keysRef.current.up = true
          e.preventDefault()
        } else if (e.code === 'ArrowDown' || e.key === 'ArrowDown' || e.code === 'KeyS') {
          keysRef.current.down = true
          e.preventDefault()
        }
        return
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const isUpKey = e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW'
      const isDownKey = e.code === 'ArrowDown' || e.key === 'ArrowDown' || e.code === 'KeyS'

      // T105: snap the release moment to the grid so the moving segment ends
      // exactly at the released (quantized) beat and does not bleed into the
      // next snap cell (overshoot).
      if ((isUpKey || isDownKey) && modeRef.current === 'record' && isPlayingRef.current && recCursorRef.current) {
        const rawBeat = timeline.msToBeat(positionRef.current)
        const releaseBeat = quantizeBeat(rawBeat, snap)
        const y = recCursorRef.current.y
        const traj = recTrajRef.current
        const last = traj[traj.length - 1]
        if (!last || releaseBeat > last.beat + 1e-9) {
          traj.push({ beat: releaseBeat, y, down: false })
        } else {
          last.beat = releaseBeat
          last.y = y
          last.down = false
        }
        setRecLive({ beat: releaseBeat, y, trajectory: traj.slice() })
      }

      if (isUpKey) keysRef.current.up = false
      if (isDownKey) keysRef.current.down = false
      // T103: ring stamping via Space is only allowed in record mode.
      if (e.code === 'Space') {
        if (!isPlayingRef.current || !keysRef.current.space) {
          keysRef.current.space = false
          return
        }
        if (modeRef.current === 'record') {
          const rawBeat = timeline.msToBeat(positionRef.current)
          const snapped = quantizeBeat(rawBeat, snap)
          const startBeat = spacePressBeatRef.current ?? snapped
          const rawDuration = snapped - startBeat
          const duration = Number(quantizeBeat(rawDuration, snap).toFixed(2))
          let added = false
          setRings((prev) => {
            if (prev.some((r) => Math.abs(r.beat - startBeat) < 0.001)) return prev
            added = true
            if (duration > 0.3) {
              return [...prev, { beat: startBeat, type: 'hold', duration }]
            } else {
              return [...prev, { beat: startBeat, type: 'single' }]
            }
          })
          if (added) notify(`リング追加 @beat ${startBeat.toFixed(2)}${duration > 0.3 ? ` (hold ${duration}拍)` : ''}`)
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
  }, [snap, timeline, selectedRing, segments, notify])

  const removeRing = (index: number) => {
    setRings((prev) => prev.filter((_, i) => i !== index))
    setSelectedRing((cur) => (cur === index ? null : cur))
  }

  const addRing = useCallback(
    (beat: number): number | undefined => {
      const snapped = quantizeBeat(beat, snap)
      let index = -1
      setRings((prev) => {
        if (prev.some((r) => Math.abs(r.beat - snapped) < 0.001)) {
          index = prev.findIndex((r) => Math.abs(r.beat - snapped) < 0.001)
          return prev
        }
        index = prev.length
        return [...prev, { beat: snapped, type: 'single' }]
      })
      notify(`リング追加 @beat ${snapped.toFixed(2)}`)
      return index >= 0 ? index : undefined
    },
    [snap, notify]
  )

  const moveRing = useCallback((index: number, beat: number) => {
    const snapped = Math.round(beat / snap) * snap
    setRings((prev) =>
      prev.map((r, i) => (i === index ? { ...r, beat: snapped } : r))
    )
  }, [snap])

  const setRingBeat = (index: number, beat: number) => {
    const v = Number.isFinite(beat) && beat >= 0 ? beat : 0
    setRings((prev) =>
      prev.map((r, i) => (i === index ? { ...r, beat: v } : r))
    )
  }

  const lastSeekBeatRef = useRef<number | null>(null)
  const lastSeekTimeRef = useRef(0)
  const seekTo = (ms: number) => {
    const clamped = Math.max(0, Math.min(ms, durationMs || ms))
    setPositionMs(clamped)
    positionRef.current = clamped
    lastSeekBeatRef.current = timeline.msToBeat(clamped)
    lastSeekTimeRef.current = performance.now()
    if (isPlaying) {
      void playFrom(clamped)
    }
  }

  const seekToBeat = (beat: number) => {
    seekTo(timeline.beatToMs(beat))
  }

  const buildChart = useCallback((): Chart => {
    const safeAmp = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 130
    const safeScroll = Number.isFinite(scrollSpeed) && scrollSpeed > 0 ? scrollSpeed : 110
    const safeOffset = Number.isFinite(audioOffset) ? audioOffset : 0
    return {
      title: title.trim() || 'Untitled',
      artist: artist.trim(),
      bpm: safeBpm,
      audio: url.trim() || '/rhythm_game/audio/08.Reply.flac',
      audio_offset: safeOffset,
      scroll_speed: safeScroll,
      amplitude: safeAmp,
      bpm_changes: bpmChanges,
      segments,
      rings,
    }
  }, [safeBpm, url, audioOffset, scrollSpeed, amplitude, bpmChanges, segments, rings])

  const exportChart = () => {
    const toml = chartToToml(buildChart())
    const blob = new Blob([toml], { type: 'text/toml' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'reply.toml'
    link.click()
    URL.revokeObjectURL(link.href)
    notify('reply.toml をエクスポートしました')
  }

  const importChart = useCallback((chart: Chart) => {
    setTitle(chart.title)
    setArtist(chart.artist)
    setBpm(chart.bpm)
    setUrl(chart.audio)
    setAudioOffset(chart.audio_offset)
    setScrollSpeed(chart.scroll_speed)
    setAmplitude(chart.amplitude)
    setBpmChanges(chart.bpm_changes)
    setSegments(chart.segments)
    setRings(chart.rings)
    setBuffer(null)
    setDurationMs(0)
    setPositionMs(0)
    setSelectedRing(null)
    setImportError(null)
  }, [])

  const importFromFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '')
        const chart = parseChartText(text, file.name)
        importChart(chart)
        notify(`${file.name} を読み込みました`)
      } catch (e) {
        setImportError(e instanceof Error ? e.message : 'TOMLの読み込みに失敗しました')
      }
    }
    reader.onerror = () => {
      setImportError('ファイルの読み込みに失敗しました')
    }
    reader.readAsText(file)
  }

  const clearAll = () => {
    if (!window.confirm('現在の譜面（リング・セグメント・BPM変更）をすべてクリアします。よろしいですか？')) {
      return
    }
    setRings([])
    setSegments([])
    setBpmChanges([])
    setSelectedRing(null)
    setPositionMs(0)
    positionRef.current = 0
    notify('譜面をクリアしました')
  }

  const closePlaytest = useCallback(() => {
    playtestActiveRef.current = false
    setPlaytest(null)
  }, [])

  return (
    <div className="editor-screen screen-fade">
      <header className="editor-header">
        <h1>オーサリングツール</h1>
        <Link to="/">/ に戻る</Link>
      </header>

      {toastMsg && (
        <div className="editor-toast" role="status" data-testid="editor-toast">
          {toastMsg}
        </div>
      )}

      <div className="editor-body">
        <aside className="editor-sidebar">
          <section className="editor-pane">
            <h2>譜面情報</h2>
            <div className="editor-field">
              <label className="editor-label" htmlFor="chart-title">
                タイトル
              </label>
              <input
                id="chart-title"
                className="editor-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="chart-artist">
                アーティスト
              </label>
              <input
                id="chart-artist"
                className="editor-input"
                type="text"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
              />
            </div>
            <div className="editor-controls">
              <label className="editor-file-label">
                TOML読込
                <input
                  type="file"
                  accept=".toml,text/toml"
                  className="editor-file-input"
                  data-testid="import-toml"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) importFromFile(file)
                    e.target.value = ''
                  }}
                />
              </label>
              <button type="button" onClick={clearAll} data-testid="editor-clear" className="editor-clear-button">
                クリア
              </button>
            </div>
            {importError && <div className="editor-error">{importError}</div>}
          </section>

          <section className="editor-pane" id="music-control">
            <h2>音楽制御</h2>
            <div className="editor-field">
              <label className="editor-label" htmlFor="audio-url">
                URL
              </label>
              <input
                id="audio-url"
                className="editor-input"
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setBuffer(null)
                  setDurationMs(0)
                  setPositionMs(0)
                }}
              />
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="audio-file-input">
                ローカルファイル読込
              </label>
              <input
                id="audio-file-input"
                className="editor-file-input"
                type="file"
                accept="audio/*"
                data-testid="audio-file-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void loadLocalFile(file)
                  e.target.value = ''
                }}
              />
            </div>
            <div
              className="editor-dropzone"
              data-testid="editor-dropzone"
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(e) => {
                e.preventDefault()
                const file = e.dataTransfer.files?.[0]
                if (file) void loadLocalFile(file)
              }}
            >
              ここに音声ファイルをドラッグ＆ドロップ
            </div>
            <div className="editor-controls">
              <button type="button" onClick={toggle} disabled={loadingAudio} data-testid="editor-play">
                {loadingAudio ? '読込中…' : isPlaying ? '停止' : buffer ? '再生' : '読込・再生'}
              </button>
              <button
                type="button"
                onClick={() => (modeRef.current === 'record' ? finishRecording() : startRecording())}
                data-testid="editor-record-toggle"
                className={mode === 'record' ? 'editor-record-active' : ''}
              >
                {mode === 'record' ? '録音停止' : '録音モード'}
              </button>
            </div>
            <input
              className="editor-slider"
              type="range"
              min={0}
              max={durationMs || 1}
              step={10}
              value={Math.min(positionMs, durationMs || 1)}
              disabled={!buffer}
              onChange={(e) => seekTo(Number(e.target.value))}
            />
            <div className="editor-pos">
              <span className="editor-pos-time">{formatSeconds(positionMs)}</span>
              <span className="editor-pos-beat">beat: {beat.toFixed(2)}</span>
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="audio-offset">
                オーディオオフセット (Audio Offset ms)
              </label>
              <input
                id="audio-offset"
                className="editor-input"
                type="number"
                step={10}
                value={Number.isFinite(audioOffset) ? audioOffset : 0}
                onChange={(e) => setAudioOffset(Number(e.target.value))}
              />
            </div>
            {error && <div className="editor-error">{error}</div>}
          </section>

          <section className="editor-pane" id="snap">
            <h2>クオンタイズ / スナップ</h2>
            <div className="editor-field">
              <label className="editor-label" htmlFor="snap-resolution">
                スナップ解像度 (1/N 拍)
              </label>
              <select
                id="snap-resolution"
                className="editor-input"
                value={snap}
                onChange={(e) => setSnap(Number(e.target.value))}
                data-testid="snap-select"
              >
                {SNAP_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    1/{Math.round(1 / s)}
                  </option>
                ))}
              </select>
            </div>
            <p className="editor-hint">録音時の軌跡は選択した解像度の整数倍（1/8・1/4・1/2・1拍）に吸着します</p>
          </section>

          <section className="editor-pane">
            <h2>BPM設定</h2>
            <BpmEditor
              bpm={bpm}
              onBpmChange={setBpm}
              bpmChanges={bpmChanges}
              onBpmChangesChange={setBpmChanges}
              amplitude={amplitude}
              onAmplitudeChange={setAmplitude}
              scrollSpeed={scrollSpeed}
              onScrollSpeedChange={setScrollSpeed}
            />
          </section>

          <section className="editor-pane">
            <h2>エクスポート</h2>
            <div className="editor-controls">
            <button type="button" onClick={exportChart} data-testid="editor-export">
              エクスポート
            </button>
            <button type="button" onClick={() => {
              if (isPlaying) stop()
              playtestActiveRef.current = true
              const chart = buildChart()
              if (buffer) {
                AudioCache.set(getBasename(chart.audio), buffer)
              }
              setPlaytest({ chart, buffer })
            }} data-testid="editor-playtest">
              プレイテスト
            </button>
            </div>
            <p className="editor-hint">現在の状態をTOMLとして reply.toml に書き出し。プレイテストはエクスポートせずその場で確認</p>
          </section>
        </aside>

        <main className="editor-main">
          <div className="editor-legend" data-testid="editor-legend">
            <span><b>使い方</b></span>
            <span>① 音楽URLを入力し「読込・再生」</span>
            <span>② 基本BPM / 振幅などを設定</span>
            <span>③ 波形上クリックでリング追加・ドラッグで移動・ダブルクリックで削除</span>
            <span>④ 上端ルーラー(↑)クリックでシーク</span>
            <span>⑤ 録音モード中 Space=リング追加（単発/ホールド）</span>
            <span>⑥ 録音モード: ↑↓→(W S D) で玉を操作し軌跡を波形に記録（停止でコミット）</span>
            <span>⑧ 空白ドラッグ=パン / ホイール=ズーム / 「エクスポート」でTOML保存</span>
          </div>
          <section className="editor-pane editor-view-controls">
            <h2>表示</h2>
            <div className="editor-field editor-zoom-field">
              <label className="editor-label" htmlFor="zoom">
                ズーム（表示拍数: {view.beats.toFixed(1)}）
              </label>
              <input
                id="zoom"
                className="editor-slider"
                type="range"
                min={1}
                max={64}
                step={0.5}
                value={Math.min(64, Math.max(1, view.beats))}
                onChange={(e) => setView({ startBeat: view.startBeat, beats: Number(e.target.value) })}
              />
            </div>
            <div className="editor-field editor-scroll-field">
              <label className="editor-label" htmlFor="scroll">
                スクロール（開始拍: {view.startBeat.toFixed(1)}）
              </label>
              <input
                id="scroll"
                className="editor-slider"
                type="range"
                min={0}
                max={Math.max(0, contentBeats - view.beats + 2)}
                step={0.5}
                value={Math.min(view.startBeat, Math.max(0, contentBeats - view.beats + 2))}
                onChange={(e) => setView({ startBeat: Number(e.target.value), beats: view.beats })}
              />
            </div>
          </section>
          <WavePreview
            segments={segments}
            bpm={safeBpm}
            bpmChanges={bpmChanges}
            rings={rings}
            amplitude={amplitude}
            snap={snap}
            selectedRing={selectedRing}
            positionMs={positionMs}
            view={view}
            recording={recLive}
            onViewChange={setView}
            onAddRing={addRing}
            onMoveRing={moveRing}
            onSelectRing={setSelectedRing}
            onDeleteRing={removeRing}
            onSeek={seekToBeat}
          />
          <SegmentEditor segments={segments} onSegmentsChange={setSegments} />

          <section className="editor-pane editor-accordion">
             <details data-testid="ring-list-details" open={ringDetailsOpen} onToggle={(e) => setRingDetailsOpen((e.target as HTMLDetailsElement).open)}>
             <summary className="editor-accordion-summary">
               <span>リング録音 ({rings.length})</span>
             </summary>
             <p className="editor-hint">再生中に Space で現在のbeatをスタンプ。プレビュー上で直接クリック・ドラッグ・ダブルクリックも可能</p>
            {rings.length === 0 ? (
              <p className="editor-empty">リングなし</p>
            ) : (
              <ul className="ring-list">
                {[...rings]
                  .map((ring, i) => ({ ring, i }))
                  .sort((a, b) => a.ring.beat - b.ring.beat)
                  .map(({ ring, i }, sortedIdx) => (
                  <li
                    key={`${i}-${ring.beat}`}
                    className={`ring-list-item${i === selectedRing ? ' ring-list-item-selected' : ''}`}
                    data-testid={`ring-list-item-${sortedIdx}`}
                  >
                     <span
                       className="ring-list-beat"
                       onClick={() => {
                         setSelectedRing(i)
                         seekToBeat(ring.beat)
                       }}
                       role="button"
                       tabIndex={0}
                       title="クリックで選択し、その位置へシーク"
                       onKeyDown={(e) => {
                         if (e.key === 'Enter' || e.key === ' ') {
                           setSelectedRing(i)
                           seekToBeat(ring.beat)
                         }
                       }}
                     >
                       beat: {ring.beat.toFixed(2)}
                     </span>
                     <input
                       className="editor-input ring-beat-input"
                       type="number"
                       min={0}
                       step={snap}
                       value={ring.beat}
                       onChange={(e) => {
                         setSelectedRing(i)
                         setRingBeat(i, Number(e.target.value))
                       }}
                       aria-label={`beat ${ring.beat.toFixed(2)} の位置`}
                       title="正確なbeat位置を数値入力"
                     />
                    <select
                      className="editor-input ring-type-select"
                      value={ring.type ?? 'single'}
                      onChange={(e) => {
                        const type = e.target.value as 'single' | 'hold'
                        setRings((prev) =>
                          prev.map((r, idx) => (idx === i ? { ...r, type, duration: type === 'hold' ? (r.duration ?? 1) : undefined } : r))
                        )
                      }}
                      aria-label={`beat ${ring.beat.toFixed(2)} のタイプ`}
                    >
                      <option value="single">単発</option>
                      <option value="hold">ホールド</option>
                    </select>
                    {ring.type === 'hold' && (
                      <input
                        className="editor-input ring-duration-input"
                        type="number"
                        min={0.25}
                        step={0.25}
                        value={ring.duration ?? 1}
                        onChange={(e) => {
                          const duration = Math.max(0.25, Number(e.target.value))
                          setRings((prev) =>
                            prev.map((r, idx) => (idx === i ? { ...r, duration } : r))
                          )
                        }}
                        aria-label={`beat ${ring.beat.toFixed(2)} の長さ`}
                      />
                    )}
                    <button
                      type="button"
                      className="ring-list-delete"
                      onClick={() => removeRing(i)}
                      aria-label={`beat ${ring.beat.toFixed(2)} を削除`}
                      data-testid={`ring-delete-${i}`}
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
          </section>
        </main>
      </div>

      {playtest && (
        <div className="playtest-overlay">
          <GameScreen playtest={playtest} onExit={closePlaytest} />
        </div>
      )}
    </div>
  )
}
