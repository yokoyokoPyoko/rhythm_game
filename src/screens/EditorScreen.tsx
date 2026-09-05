import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioManager } from '../audio/AudioManager'
import { AudioCache, getBasename } from '../audio/AudioCache'
import { BpmTimeline } from '../audio/bpmTimeline'
import { loadAudio, loadAudioFromFile } from '../audio/loader'
import { LOOKAHEAD_MS, schedule } from '../audio/metronome'
import { getLeadMs, getManualOffsetMs, setManualOffset } from '../audio/clock'
import { parseChartText } from '../chart/loader'
import { chartToToml } from '../chart/serialize'
import { Cursor } from '../game/cursor'
import { TW_AMP, TW_CENTER_Y, WaveEngine } from '../game/waveEngine'
import { segmentize, quantizeBeat, type TrajPoint } from '../chart/quantize'
import type { BpmChange, Chart, RingDef, Segment } from '../types'
import BpmEditor from './editor/BpmEditor'
import SegmentEditor from './editor/SegmentEditor'
import WavePreview, { type WaveView } from './editor/WavePreview'
import CalibrationModal from './editor/CalibrationModal'
import GameScreen from './GameScreen'

const SNAP_OPTIONS = [0.125, 0.25, 0.5, 1]

// T131: The editor's waveform/cursor is list-driven by bpm_changes[].amplitude.
// The main #amplitude input is an injection-only field (stamped into new BPM-change
// entries) and does not immediately change the rendered wave. The editor renders
// with a fixed base amplitude and lets the list drive time-varying amplitude.
const EDITOR_BASE_AMP = 1.0

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
  startPosition = 0.0,
): { kept: Segment[]; startY: number } {
  const engine = new WaveEngine(segs, timeline, amplitude, startPosition)
  const startY = segs.length > 0 ? engine.waveYAt(beat) : TW_CENTER_Y - startPosition * TW_AMP
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

const slugify = (str: string): string => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function EditorScreen() {
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [url, setUrl] = useState('')
  const [bpm, setBpm] = useState(120)
  const [amplitude, setAmplitude] = useState(1.0)
  const [scrollSpeed, setScrollSpeed] = useState(110)
  const [audioOffset, setAudioOffset] = useState(0)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [durationMs, setDurationMs] = useState(0)
  const [positionMs, setPositionMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [metronomeEnabled, setMetronomeEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snap, setSnap] = useState(0.25)
  const [startPosition, setStartPosition] = useState(0.0)
  const [rings, setRings] = useState<RingDef[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [bpmChanges, setBpmChanges] = useState<BpmChange[]>([])
  const [playtest, setPlaytest] = useState<{ chart: Chart; buffer: AudioBuffer | null } | null>(null)
  const [selectedRing, setSelectedRing] = useState<number | null>(null)
  const [selectedRings, setSelectedRings] = useState<number[]>([])
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [ringDetailsOpen, setRingDetailsOpen] = useState(false)
  const [segmentDetailsOpen, setSegmentDetailsOpen] = useState(false)
  const [musicVolume, setMusicVolume] = useState(100)
  const [metronomeVolume, setMetronomeVolume] = useState(100)
  const [offsetMs, setOffsetMs] = useState(getManualOffsetMs())
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const savedOffsetRef = useRef(getManualOffsetMs())
  const [mode, setMode] = useState<'play' | 'record'>('play')
  const [editMode, setEditMode] = useState<'vertex' | 'edge' | 'ring'>('vertex')
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null)
  const [selectedSegments, setSelectedSegments] = useState<number[]>([])
  const [selectedVertices, setSelectedVertices] = useState<number[]>([])
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null)
  const [hoveredRing, setHoveredRing] = useState<number | null>(null)
  const [view, setView] = useState<WaveView>({ startBeat: 0, beats: 16 })
  const [recLive, setRecLive] = useState<{ beat: number; y: number; trajectory: { beat: number; y: number }[] } | null>(null)

  useEffect(() => {
    if (rings.length > 0) {
      setRingDetailsOpen(true)
    }
  }, [rings.length])

  useEffect(() => {
    if (segments.length > 0) {
      setSegmentDetailsOpen(true)
    }
  }, [segments.length])

   useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__editorSegments = segments
    w.__editorRings = rings
    w.__editorSnap = snap
    w.__editorAudioOffset = audioOffset
    w.__editorView = view
    w.__editorTimeline = timeline
    w.__editorWaveEngine = waveEngine
    w.__editorBeat = beat
    w.__editorRecTraj = recTrajRef.current
    w.__editorRecLive = recLive
    w.__editorRecStartBeat = recStartBeatRef.current
    w.__editorQuantizeModule = { quantizeBeat, segmentize }
    w.__editorSeekToBeat = seekToBeat
    w.__editorMode = editMode
    w.__editorSelectedSegment = selectedSegment
    w.__editorSelectedSegments = selectedSegments
    w.__editorSelectedVertices = selectedVertices
    w.__editorSelectedRing = selectedRing
    w.__editorSelectedRings = selectedRings
    w.__editorHoveredSegment = hoveredSegment
    w.__editorHoveredRing = hoveredRing
    // __editorState facade: populated after startRecording/finishRecording are defined
    const facade = (w.__editorState ?? {}) as Record<string, unknown>
    facade.segments = segments
    facade.editMode = editMode
    facade.selectedSegment = selectedSegment
    facade.selectedSegments = selectedSegments
    facade.selectedVertices = selectedVertices
    facade.selectedRing = selectedRing
    facade.selectedRings = selectedRings
    facade.hoveredSegment = hoveredSegment
    facade.hoveredRing = hoveredRing
    facade.amplitude = amplitude
    w.__editorState = facade
  })

  const playtestActiveRef = useRef(false)
  const calibrationOpenRef = useRef(false)
  const toastTimerRef = useRef<number | null>(null)
  const modeRef = useRef<'play' | 'record'>('play')
  const editModeRef = useRef<'vertex' | 'edge' | 'ring'>('vertex')
  useEffect(() => { editModeRef.current = editMode }, [editMode])
  useEffect(() => { metronomeEnabledRef.current = metronomeEnabled }, [metronomeEnabled])
  useEffect(() => { calibrationOpenRef.current = calibrationOpen }, [calibrationOpen])
  const recCursorRef = useRef<Cursor | null>(null)
  const recTrajRef = useRef<TrajPoint[]>([])
  const recStartBeatRef = useRef(0)
  const recStartYRef = useRef(TW_CENTER_Y)
  const lastTickRef = useRef(0)
  const keysRef = useRef({ up: false, down: false, space: false })
  const spacePressBeatRef = useRef(0)

  // T155: undo/redo history (segments + rings)
  const historyRef = useRef<{ past: { segments: Segment[]; rings: RingDef[] }[]; future: { segments: Segment[]; rings: RingDef[] }[] }>({ past: [], future: [] })
  const segmentsRef = useRef(segments)
  const ringsRef = useRef(rings)
  useEffect(() => { segmentsRef.current = segments }, [segments])
  useEffect(() => { ringsRef.current = rings }, [rings])

  const pushHistory = useCallback(() => {
    const snap = { segments: segmentsRef.current, rings: ringsRef.current }
    historyRef.current.past.push(snap)
    if (historyRef.current.past.length > 50) historyRef.current.past.shift()
    historyRef.current.future = []
  }, [])

  const commitSegments = useCallback((newSegs: Segment[]) => {
    pushHistory()
    setSegments(newSegs)
  }, [pushHistory])

  const commitRings = useCallback((newRings: RingDef[] | ((prev: RingDef[]) => RingDef[])) => {
    pushHistory()
    setRings(newRings)
  }, [pushHistory])

  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})

  const notify = useCallback((msg: string) => {
    setToastMsg(msg)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 2500)
  }, [])

  const doUndo = useCallback(() => {
    const { past, future } = historyRef.current
    if (past.length === 0) return
    const current = { segments: segmentsRef.current, rings: ringsRef.current }
    future.push(current)
    const prev = past.pop()!
    setSegments(prev.segments)
    setRings(prev.rings)
    setSelectedSegment((cur) => cur != null && cur >= prev.segments.length ? null : cur)
    setSelectedSegments((cur) => cur.filter((i) => i < prev.segments.length))
    setSelectedVertices((cur) => cur.filter((v) => v < prev.segments.length + 1))
    setSelectedRing((cur) => cur != null && cur >= prev.rings.length ? null : cur)
  }, [])

  const doRedo = useCallback(() => {
    const { past, future } = historyRef.current
    if (future.length === 0) return
    const current = { segments: segmentsRef.current, rings: ringsRef.current }
    past.push(current)
    const next = future.pop()!
    setSegments(next.segments)
    setRings(next.rings)
    setSelectedSegment((cur) => cur != null && cur >= next.segments.length ? null : cur)
    setSelectedSegments((cur) => cur.filter((i) => i < next.segments.length))
    setSelectedVertices((cur) => cur.filter((v) => v < next.segments.length + 1))
    setSelectedRing((cur) => cur != null && cur >= next.rings.length ? null : cur)
  }, [])

  useEffect(() => { undoRef.current = doUndo }, [doUndo])
  useEffect(() => { redoRef.current = doRedo }, [doRedo])

  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const musicGainRef = useRef<GainNode | undefined>(undefined)
  const metronomeGainRef = useRef<GainNode | undefined>(undefined)
  const startCtxTimeRef = useRef(0)
  const startMsRef = useRef(0)
  const positionRef = useRef(0)
  const endMsRef = useRef(0)
  const isPlayingRef = useRef(false)
  const metronomeTimerRef = useRef<number | null>(null)
  const metronomeEnabledRef = useRef(true)

  const setPlaying = (v: boolean) => {
    isPlayingRef.current = v
    setIsPlaying(v)
  }

  const safeBpm = bpm > 0 ? bpm : 120
  // T131: editor timeline uses a fixed base amplitude; bpm_changes[].amplitude
  // (list) is the primary driver for time-varying wave/cursor.
  const timeline = useMemo(
    () => new BpmTimeline(safeBpm, bpmChanges, EDITOR_BASE_AMP),
    [safeBpm, bpmChanges],
  )
  // T131: list-driven wave engine used for editing/recording/preview.
  // Not derived from the live #amplitude injection field (no immediate apply).
  const waveEngine = useMemo(
    () => new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition),
    [segments, timeline, startPosition],
  )
  const beat = timeline.msToBeat(positionMs)
  const contentBeats = Math.max(
    segments.reduce((s, seg) => s + seg.beats, 0),
    rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), 0),
    8,
  )

  const stopMetronome = useCallback(() => {
    if (metronomeTimerRef.current !== null) {
      window.clearInterval(metronomeTimerRef.current)
      metronomeTimerRef.current = null
    }
  }, [])

  const ensureGainNodes = useCallback((ctx: AudioContext) => {
    if (!musicGainRef.current) {
      const g = ctx.createGain()
      g.connect(ctx.destination)
      musicGainRef.current = g
      ;(window as unknown as Record<string, unknown>).__editorMusicGain = g
    }
    if (!metronomeGainRef.current) {
      const g = ctx.createGain()
      g.connect(ctx.destination)
      metronomeGainRef.current = g
      ;(window as unknown as Record<string, unknown>).__editorMetronomeGain = g
    }
  }, [])

  const startMetronome = useCallback((ctx: AudioContext, fromMs: number, startCtxTime: number) => {
    stopMetronome()
    if (!metronomeEnabledRef.current) return
    ensureGainNodes(ctx)
    const metronomeGain = metronomeGainRef.current
    const lookaheadSec = LOOKAHEAD_MS / 1000
    let beatIdx = Math.ceil(timeline.msToBeat(fromMs))
    if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0
    // T143: Deterministic grid anchored to startCtxTime (the snapshot taken when
    // playback began), not the live ctx.currentTime (which has frame jitter).
    // audioOffset is NOT baked in so the clicks stay fixed to the ruler/green bar.
    // schedule() internally adds offsetSeconds() (manualOffset/1000).
    let nextBeatTime = startCtxTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000
    // Advance until the first click is still in the future after schedule() adds
    // manualOffset, so the first click is never clamped to "now" (deterministic).
    while (nextBeatTime < ctx.currentTime) {
      nextBeatTime += timeline.beatMsAt(beatIdx) / 1000
      beatIdx++
    }
    metronomeTimerRef.current = window.setInterval(() => {
      if (!metronomeEnabledRef.current) return
      const audioCtx = AudioManager.getInstance().ctx
      const horizon = audioCtx.currentTime + lookaheadSec
      while (nextBeatTime < horizon) {
        try {
          schedule(audioCtx, nextBeatTime, beatIdx, metronomeGain)
        } catch {
          // keep grid advancing
        }
        nextBeatTime += timeline.beatMsAt(beatIdx) / 1000
        beatIdx++
      }
    }, 25)
  }, [stopMetronome, timeline, ensureGainNodes])

  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__editorMetronomeEnabled = metronomeEnabled
  }, [metronomeEnabled])

  useEffect(() => {
    if (musicGainRef.current) {
      musicGainRef.current.gain.value = Math.max(0, Math.min(300, musicVolume)) / 100
    }
  }, [musicVolume])

  useEffect(() => {
    if (metronomeGainRef.current) {
      metronomeGainRef.current.gain.value = Math.max(0, Math.min(300, metronomeVolume)) / 100
    }
  }, [metronomeVolume])

  useEffect(() => {
    if (isPlaying && metronomeEnabled) {
      // T137: restart deterministically (e.g. after toggling metronomeEnabled)
      // using the values captured at playFrom time (never the stale positionRef).
      try {
        const ctx = AudioManager.getInstance().ctx
        startMetronome(ctx, startMsRef.current, startCtxTimeRef.current)
      } catch { /* ctx not ready */ }
    } else if (!isPlaying || !metronomeEnabled) {
      stopMetronome()
    }
    return () => {
      if (!isPlaying) stopMetronome()
    }
  }, [isPlaying, metronomeEnabled, startMetronome, stopMetronome])

  const finishRecording = useCallback(() => {
    if (modeRef.current !== 'record') return
    modeRef.current = 'play'
    setMode('play')
    const traj = recTrajRef.current
    if (traj.length >= 2) {
      const startBeat = recStartBeatRef.current
      const sorted = [...traj].sort((a, b) => a.beat - b.beat)
      const endBeat = sorted[sorted.length - 1].beat

      const { kept: keptBefore } = truncateSegmentsTo(segments, startBeat, timeline, EDITOR_BASE_AMP, startPosition)
      // T131: threshold uses the time-varying amplitude at the recording start
      const newSegs = segmentize(traj, snap, timeline.amplitudeAt(startBeat))

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

      commitSegments([...keptBefore, ...newSegs, ...keptAfter])
      notify(`波形を記録 (${newSegs.length}セグメント)`)
    }
    setRecLive(null)
    recCursorRef.current = null
    recTrajRef.current = []
  }, [segments, snap, timeline, notify, startPosition])

  // T115: auto-scroll follow - when playhead nears right edge, advance viewStartBeat
  useEffect(() => {
    if (!isPlaying) return
    const curBeat = timeline.msToBeat(positionMs)
    const margin = Math.max(1, view.beats * 0.2)
    const threshold = view.startBeat + view.beats - margin
    if (curBeat > threshold) {
      const newStart = Math.max(0, curBeat - view.beats * 0.55)
      if (Math.abs(newStart - view.startBeat) > 0.05) {
        setView((v) => ({ startBeat: newStart, beats: v.beats }))
      }
    }
  }, [positionMs, isPlaying, timeline, view.startBeat, view.beats])

  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    lastTickRef.current = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(0.05, (now - lastTickRef.current) / 1000)
      lastTickRef.current = now
      const ctx = AudioManager.getInstance().ctx
      // T138 (案A): green bar = raw (judgement basis). Matches Play's songNow so
      // 記録位置 = 判定ライン. Audible music is +leadMs delayed; greensBar leads by
      // design. Do not subtract leadMs here (removal keeps recording/raw in phase).
      const rawPos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000
      const pos = Math.max(0, rawPos)
      if (pos >= endMsRef.current) {
        if (sourceRef.current) {
          sourceRef.current.disconnect()
          sourceRef.current = null
        }
        setPositionMs(endMsRef.current)
        positionRef.current = endMsRef.current
        if (modeRef.current === 'record') finishRecording()
        stopMetronome()
        setPlaying(false)
      } else {
        setPositionMs(pos)
        positionRef.current = pos
        if (modeRef.current === 'record' && recCursorRef.current) {
          const rawBeat = timeline.msToBeat(pos)
          const beat = quantizeBeat(rawBeat, snap)
          const beatMs = timeline.beatMsAt(rawBeat)
          // T131: update cursor amplitude from the list each frame (time-varying)
          recCursorRef.current.setAmplitude(timeline.amplitudeAt(rawBeat))
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
  }, [isPlaying, buffer, timeline, finishRecording, stopMetronome])

  useEffect(() => {
    return () => {
      stopMetronome()
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
  }, [stopMetronome])

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
        stopMetronome()
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
  }, [notify, stopMetronome])

  const playFrom = useCallback(async (fromMs: number) => {
    const mgr = AudioManager.getInstance()
    await mgr.ensure()
    const ctx = mgr.ctx
    ensureGainNodes(ctx)
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
      src.connect(musicGainRef.current!)
      // T138: total music lead (audioOffset + manualOffset), centralized in clock.
      const offsetSec = getLeadMs(audioOffset) / 1000
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
          stopMetronome()
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
    const t0 = ctx.currentTime
    startCtxTimeRef.current = t0
    startMsRef.current = fromMs
    // T143: start the metronome deterministically from this playback's own
    // snapshot (t0, fromMs), never a stale positionRef. The metronome is NOT
    // given audioOffset so clicks stay fixed to the ruler/green bar. The music
    // (getLeadMs(audioOffset)/1000 + delta) is still delayed by audioOffset, so
    // the metronome is intentionally audioOffset apart from the audible music.
    if (metronomeEnabledRef.current) {
      try {
        startMetronome(ctx, fromMs, t0)
      } catch { /* ignore */ }
    }
    setPlaying(true)
    setError(
      audioFailed
        ? '音楽ファイルの読み込みに失敗しました（メトロノームのみで続行）'
        : null,
    )
  }, [buffer, url, audioOffset, segments, rings, timeline, stopMetronome, ensureGainNodes, startMetronome])

  const startRecording = useCallback(() => {
    let rawStartBeat: number
    if (lastSeekBeatRef.current !== null && performance.now() - lastSeekTimeRef.current < 2000) {
      rawStartBeat = lastSeekBeatRef.current
    } else {
      rawStartBeat = timeline.msToBeat(positionRef.current)
    }
    const startBeat = quantizeBeat(rawStartBeat, snap)
    recStartBeatRef.current = startBeat
    // T131: recording uses the list-driven wave engine (not the injection field).
    const startY =
      segments.length > 0 ? waveEngine.waveYAt(startBeat) : waveEngine.waveYAt(0)
    recStartYRef.current = startY
    const cursor = new Cursor(timeline.amplitudeAt(startBeat), startPosition)
    cursor.y = startY
    recCursorRef.current = cursor
    recTrajRef.current = [{ beat: startBeat, y: startY, down: false }]
    modeRef.current = 'record'
    setMode('record')
    setRecLive({ beat: startBeat, y: startY, trajectory: recTrajRef.current.slice() })
  }, [timeline, waveEngine, startPosition, positionMs, snap])

  const stop = useCallback(() => {
    stopMetronome()
    const src = sourceRef.current
    if (!src) {
      setPlaying(false)
      return
    }
    const ctx = AudioManager.getInstance().ctx
    // T138 (案A): green bar = raw (same as Play judgement songNow).
    const rawPos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000
    const pos = Math.max(0, rawPos)
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
  }, [buffer, stopMetronome])

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
      commitSegments(segs)
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
      if (calibrationOpenRef.current) return

      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const editable =
        tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable === true
      if (editable) return

      // T115: Space = play/stop toggle (global), R = record toggle (global)
      // In record+playing mode Space is reserved for hold-ring stamping.
      if (e.code === 'Space') {
        e.preventDefault()
        if (isPlayingRef.current && modeRef.current === 'record') {
          if (keysRef.current.space) return
          const pos = positionRef.current
          const rawBeat = timeline.msToBeat(pos)
          const snapped = quantizeBeat(rawBeat, snap)
          spacePressBeatRef.current = snapped
          keysRef.current.space = true
          return
        }
        // Toggle play/stop
        if (isPlayingRef.current) {
          stop()
        } else {
          void playFrom(positionRef.current)
        }
        return
      }
      // T116: Blender-style 3-mode toggle V/E/R (vertex/edge/ring)
      if (e.code === 'KeyV') {
        e.preventDefault()
        setEditMode('vertex')
        return
      }
      if (e.code === 'KeyE') {
        e.preventDefault()
        setEditMode('edge')
        return
      }
      if (e.code === 'KeyR') {
        e.preventDefault()
        // If already in ring mode, treat R as record toggle for backwards compat (T115)
        if (editModeRef.current !== 'ring') {
          setEditMode('ring')
          return
        }
        if (modeRef.current === 'record') {
          finishRecording()
        } else {
          startRecording()
        }
        return
      }

      // T132: offset fine-tuning with < / > keys (±10ms)
      if (e.key === ',' || e.key === '<') {
        const next = Math.round(getManualOffsetMs() - 10)
        setManualOffset(next)
        setOffsetMs(next)
        return
      }
      if (e.key === '.' || e.key === '>') {
        const next = Math.round(getManualOffsetMs() + 10)
        setManualOffset(next)
        setOffsetMs(next)
        return
      }

      if (e.code === 'Escape') {
        setSelectedRings([])
        setSelectedRing(null)
        setSelectedSegments([])
        setSelectedSegment(null)
        return
      }

      if (!editable && (e.code === 'Delete' || e.code === 'Backspace')) {
        e.preventDefault()
        if (selectedRings.length > 0) {
          commitRings((prev) => prev.filter((_, i) => !selectedRings.includes(i)))
          setSelectedRings([])
          setSelectedRing(null)
        } else if (selectedRing != null) {
          removeRing(selectedRing)
        } else if (selectedSegments.length > 0) {
          commitSegments(segmentsRef.current.filter((_, i) => !selectedSegments.includes(i)))
          setSelectedSegments([])
          setSelectedSegment(null)
        } else if (selectedSegment != null) {
          commitSegments(segmentsRef.current.filter((_, i) => i !== selectedSegment))
          setSelectedSegment(null)
        }
        return
      }

      // T155: Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault()
        undoRef.current()
        return
      }
      if ((e.ctrlKey || e.metaKey) && ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY')) {
        e.preventDefault()
        redoRef.current()
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
      if (calibrationOpenRef.current) return
      const isUpKey = e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW'
      const isDownKey = e.code === 'ArrowDown' || e.key === 'ArrowDown' || e.code === 'KeyS'

      // T105: snap the release moment to the grid so the moving segment ends
      // exactly at the released (quantized) beat and does not bleed into the
      // next snap cell (overshoot).
      if ((isUpKey || isDownKey) && modeRef.current === 'record' && isPlayingRef.current && recCursorRef.current) {
          const pos = positionRef.current
          const rawBeat = timeline.msToBeat(pos)
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
          const pos = positionRef.current
          const rawBeat = timeline.msToBeat(pos)
          const snapped = quantizeBeat(rawBeat, snap)
          const startBeat = spacePressBeatRef.current ?? snapped
          const rawDuration = snapped - startBeat
          const duration = Number(quantizeBeat(rawDuration, snap).toFixed(2))
          let added = false
          commitRings((prev) => {
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
  }, [snap, timeline, selectedRing, selectedRings, selectedSegment, selectedSegments, segments, notify, playFrom, stop, startRecording, finishRecording, commitRings, commitSegments])

  const removeRing = (index: number) => {
    commitRings((prev) => prev.filter((_, i) => i !== index))
    setSelectedRing((cur) => (cur === index ? null : cur))
    setSelectedRings((cur) => cur.filter((i) => i !== index))
  }

  const handleSelectRing = useCallback((index: number | null) => {
    setSelectedRing(index)
    setSelectedRings(index != null ? [index] : [])
    if (index != null) {
      setRingDetailsOpen(true)
      requestAnimationFrame(() => {
        /* details open 差分反映待ち — ハイライトは ring-list-item-selected クラスで付与 */
      })
    }
  }, [])

  const handleSelectRings = useCallback((indices: number[]) => {
    setSelectedRings(indices)
    setSelectedRing(indices[0] ?? null)
    if (indices.length > 0) {
      setRingDetailsOpen(true)
    }
  }, [])

  const handleSelectSegment = useCallback((index: number | null) => {
    setSelectedSegment(index)
    setSelectedSegments(index != null ? [index] : [])
    if (index != null) {
      setSegmentDetailsOpen(true)
      requestAnimationFrame(() => {
        /* details open 差分反映待ち — ハイライトは segment-list-item-selected クラスで付与 */
      })
    }
  }, [])

  const handleSelectSegments = useCallback((indices: number[]) => {
    setSelectedSegments(indices)
    setSelectedSegment(indices[0] ?? null)
    if (indices.length > 0) {
      setSegmentDetailsOpen(true)
    }
  }, [])

  const handleSelectVertices = useCallback((indices: number[]) => {
    setSelectedVertices(indices)
    setSelectedSegments(indices.map((v) => (v === 0 ? 0 : v - 1)))
    setSelectedSegment(indices[0] == null ? null : indices[0] === 0 ? 0 : indices[0] - 1)
    if (indices.length > 0) {
      setSegmentDetailsOpen(true)
    }
  }, [])

  const handleMultiMoveRings = useCallback((moves: { index: number; beat: number }[]) => {
    commitRings((prev) => {
      const next = [...prev]
      moves.forEach(m => {
        if (next[m.index]) {
          next[m.index] = { ...next[m.index], beat: m.beat }
        }
      })
      return next
    })
  }, [commitRings])

  const handleMultiMoveSegments = useCallback((next: Segment[]) => {
    commitSegments(next)
  }, [commitSegments])

  const addRing = useCallback(
    (beat: number): number | undefined => {
      const snapped = quantizeBeat(beat, snap)
      let index = -1
      commitRings((prev) => {
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
    [snap, notify, commitRings]
  )

  const moveRing = useCallback((index: number, beat: number) => {
    const snapped = Math.round(beat / snap) * snap
    commitRings((prev) =>
      prev.map((r, i) => (i === index ? { ...r, beat: snapped } : r))
    )
  }, [snap, commitRings])

  const setRingBeat = (index: number, beat: number) => {
    const v = Number.isFinite(beat) && beat >= 0 ? beat : 0
    commitRings((prev) =>
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
    const safeAmp = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 1.0
    const safeScroll = Number.isFinite(scrollSpeed) && scrollSpeed > 0 ? scrollSpeed : 110
    const safeOffset = Number.isFinite(audioOffset) ? audioOffset : 0
    const safeStartPosition = Number.isFinite(startPosition) ? Math.max(-1.0, Math.min(1.0, startPosition)) : 0.0
    return {
      title: title.trim() || 'Untitled',
      artist: artist.trim(),
      bpm: safeBpm,
      audio: url.trim(),
      audio_offset: safeOffset,
      scroll_speed: safeScroll,
      amplitude: safeAmp,
      start_position: safeStartPosition,
      bpm_changes: bpmChanges,
      segments,
      rings,
    }
  }, [safeBpm, url, audioOffset, scrollSpeed, amplitude, startPosition, bpmChanges, segments, rings])

  const exportChart = () => {
    const slug = slugify(title) || 'untitled'
    const toml = chartToToml(buildChart())
    const blob = new Blob([toml], { type: 'text/toml' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${slug}.toml`
    link.click()
    URL.revokeObjectURL(link.href)
    notify(`${slug}.toml をエクスポートしました`)
  }

  const importChart = useCallback((chart: Chart) => {
    pushHistory()
    setTitle(chart.title)
    setArtist(chart.artist)
    setBpm(chart.bpm)
    setUrl(chart.audio)
    setAudioOffset(chart.audio_offset)
    setScrollSpeed(chart.scroll_speed)
    setAmplitude(chart.amplitude)
    setStartPosition(chart.start_position ?? 0.0)
    setBpmChanges(chart.bpm_changes)
    setSegments(chart.segments)
    setRings(chart.rings)
    setBuffer(null)
    setDurationMs(0)
    setPositionMs(0)
    setSelectedRing(null)
    setImportError(null)
  }, [pushHistory])

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
    pushHistory()
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
                オーディオオフセット (ms)
              </label>
              <input
                id="audio-offset"
                className="editor-input"
                type="number"
                step={10}
                value={audioOffset}
                onChange={(e) => setAudioOffset(Number(e.target.value) || 0)}
              />
            </div>
            <div className="editor-field">
              <label className="editor-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  data-testid="metronome-switch"
                  defaultChecked
                  checked={metronomeEnabled}
                  onChange={(e) => setMetronomeEnabled(e.target.checked)}
                />
                 メトロノーム音
              </label>
            </div>
            <div className="editor-field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="editor-label" style={{ marginBottom: 0 }}>
                判定オフセット
              </span>
              <span className="editor-pos-time" data-testid="editor-offset">
                offset: {offsetMs >= 0 ? '+' : ''}
                {offsetMs}ms
              </span>
            </div>
            <div className="editor-field">
              <button
                type="button"
                onClick={() => {
                  savedOffsetRef.current = getManualOffsetMs()
                  stop()
                  stopMetronome()
                  calibrationOpenRef.current = true
                  setCalibrationOpen(true)
                }}
                data-testid="editor-calibration-button"
              >
                キャリブレーション
              </button>
              <p className="editor-hint">メトロノームに合わせて Space ×8回で判定オフセットを自動計測。&lt;&gt;キーで±10ms微調整</p>
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="metronome-volume">
                メトロノーム音量
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  id="metronome-volume"
                  className="editor-slider"
                  type="range"
                  min={0}
                  max={300}
                  step={5}
                  value={metronomeVolume}
                  data-testid="metronome-volume"
                  onChange={(e) => setMetronomeVolume(Math.max(0, Math.min(300, Number(e.target.value))))}
                  style={{ flex: 1 }}
                />
                <span className="editor-pos-time">{metronomeVolume}%</span>
              </div>
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="music-volume">
                楽曲音量
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  id="music-volume"
                  className="editor-slider"
                  type="range"
                  min={0}
                  max={300}
                  step={5}
                  value={musicVolume}
                  data-testid="music-volume"
                  onChange={(e) => setMusicVolume(Math.max(0, Math.min(300, Number(e.target.value))))}
                  style={{ flex: 1 }}
                />
                <span className="editor-pos-time">{musicVolume}%</span>
              </div>
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
              startPosition={startPosition}
              onStartPositionChange={setStartPosition}
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
            <p className="editor-hint">現在の状態をTOMLとしてファイルに書き出し。プレイテストはエクスポートせずその場で確認</p>
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
          <section className="editor-pane" data-testid="mode-toggle">
            <h2>編集モード</h2>
            <div className="editor-mode-toggle" role="group" aria-label="編集モード切替">
              <button type="button" data-testid="mode-vertex" aria-pressed={editMode === 'vertex'} className={editMode === 'vertex' ? 'editor-mode-active' : ''} onClick={() => setEditMode('vertex')}>[V] 頂点</button>
              <button type="button" data-testid="mode-edge" aria-pressed={editMode === 'edge'} className={editMode === 'edge' ? 'editor-mode-active' : ''} onClick={() => setEditMode('edge')}>[E] 辺</button>
              <button type="button" data-testid="mode-ring" aria-pressed={editMode === 'ring'} className={editMode === 'ring' ? 'editor-mode-active' : ''} onClick={() => setEditMode('ring')}>[R] リング</button>
            </div>
            <p className="editor-hint">V=頂点ドラッグ / E=辺選択 / R=リング配置。Rはリングモード未選択時はモード切替、リングモード中は録音トグル</p>
          </section>
          <WavePreview
            segments={segments}
            bpm={safeBpm}
            bpmChanges={bpmChanges}
            rings={rings}
            amplitude={amplitude}
            startPosition={startPosition}
            snap={snap}
            selectedRing={selectedRing}
            selectedSegment={selectedSegment}
            selectedRings={selectedRings}
            selectedSegments={selectedSegments}
            hoveredRing={hoveredRing}
            hoveredSegment={hoveredSegment}
            positionMs={positionMs}
            view={view}
            recording={recLive}
            editMode={editMode}
            onViewChange={setView}
            onAddRing={addRing}
            onMoveRing={moveRing}
            onSelectRing={handleSelectRing}
            onSelectSegment={handleSelectSegment}
            onSelectRings={handleSelectRings}
            onSelectSegments={handleSelectSegments}
            onSelectVertices={handleSelectVertices}
            selectedVertices={selectedVertices}
            onMultiMoveRings={handleMultiMoveRings}
            onMultiMoveSegments={handleMultiMoveSegments}
            onHoverRing={setHoveredRing}
            onHoverSegment={setHoveredSegment}
            onSegmentsChange={commitSegments}
            onDeleteRing={removeRing}
            onSeek={seekToBeat}
          />
          <SegmentEditor segments={segments} selectedIndex={selectedSegment} selectedIndices={selectedSegments} hoveredIndex={hoveredSegment} onSegmentsChange={commitSegments} onSelect={handleSelectSegment} onHover={setHoveredSegment} editMode={editMode} detailsOpen={segmentDetailsOpen} onDetailsOpenChange={setSegmentDetailsOpen} />

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
                    className={`ring-list-item${i === selectedRing || selectedRings.includes(i) ? ' ring-list-item-selected' : ''}${i === hoveredRing ? ' ring-list-item-hovered' : ''}`}
                    data-testid={`ring-list-item-${sortedIdx}`}
                    data-focus-id={`ring-${i}`}
                    tabIndex={0}
                    onMouseEnter={() => setHoveredRing(i)}
                    onMouseLeave={() => setHoveredRing((cur) => cur === i ? null : cur)}
                    onClick={() => handleSelectRing(i)}
                    onFocus={() => setHoveredRing(i)}
                    onBlur={() => setHoveredRing((cur) => cur === i ? null : cur)}
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
                        commitRings((prev) =>
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
                          commitRings((prev) =>
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
      {calibrationOpen && (
        <CalibrationModal
          onClose={(save: boolean) => {
            calibrationOpenRef.current = false
            setCalibrationOpen(false)
            if (!save) setManualOffset(savedOffsetRef.current)
            setOffsetMs(getManualOffsetMs())
          }}
        />
      )}
    </div>
  )
}
