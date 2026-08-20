import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioManager } from '../audio/AudioManager'
import { BpmTimeline } from '../audio/bpmTimeline'
import { loadAudio } from '../audio/loader'
import { chartToToml } from '../chart/serialize'
import type { BpmChange, Chart, RingDef, Segment } from '../types'
import BpmEditor from './editor/BpmEditor'
import SegmentEditor from './editor/SegmentEditor'
import WavePreview from './editor/WavePreview'
import GameScreen from './GameScreen'

const SNAP_OPTIONS = [0.125, 0.25, 0.5, 1]

function formatSeconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  const tenth = Math.floor((ms % 1000) / 100)
  return `${m}:${sec.toString().padStart(2, '0')}.${tenth}`
}

export default function EditorScreen() {
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
  const [playtest, setPlaytest] = useState<Chart | null>(null)

  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startCtxTimeRef = useRef(0)
  const startMsRef = useRef(0)
  const positionRef = useRef(0)
  const isPlayingRef = useRef(false)

  const setPlaying = (v: boolean) => {
    isPlayingRef.current = v
    setIsPlaying(v)
  }

  const safeBpm = bpm > 0 ? bpm : 120
  const timeline = useMemo(() => new BpmTimeline(safeBpm, bpmChanges), [safeBpm, bpmChanges])
  const beat = timeline.msToBeat(positionMs)

  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
      const ctx = AudioManager.getInstance().ctx
      const pos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000
      if (buffer && pos >= buffer.duration * 1000) {
        if (sourceRef.current) {
          sourceRef.current.disconnect()
          sourceRef.current = null
        }
        setPositionMs(buffer.duration * 1000)
        positionRef.current = buffer.duration * 1000
        setPlaying(false)
      } else {
        setPositionMs(pos)
        positionRef.current = pos
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, buffer])

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

  const playFrom = async (fromMs: number) => {
    const mgr = AudioManager.getInstance()
    await mgr.ensure()
    const ctx = mgr.ctx
    let buf = buffer
    if (!buf) {
      buf = await loadAudio(url, ctx)
      if (!buf) {
        setError('音楽ファイルの読み込みに失敗しました')
        return
      }
      setBuffer(buf)
      setDurationMs(buf.duration * 1000)
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
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0, fromMs / 1000)
    src.onended = () => {
      if (sourceRef.current === src) {
        sourceRef.current = null
        setPlaying(false)
      }
    }
    sourceRef.current = src
    startCtxTimeRef.current = ctx.currentTime
    startMsRef.current = fromMs
    setPlaying(true)
    setError(null)
  }

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

  const toggle = () => {
    if (isPlaying) {
      stop()
    } else {
      void playFrom(positionMs)
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        if (!isPlayingRef.current) return
        const rawBeat = timeline.msToBeat(positionRef.current)
        const snapped = Math.round(rawBeat / snap) * snap
        setRings((prev) => {
          if (prev.some((r) => Math.abs(r.beat - snapped) < 0.001)) return prev
          return [...prev, { beat: snapped }]
        })
        return
      }

      if (!isPlayingRef.current) return

      let direction: 'up' | 'down' | 'stay' | null = null
      if (e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.code === 'KeyW') {
        direction = 'up'
      } else if (e.code === 'ArrowDown' || e.key === 'ArrowDown' || e.code === 'KeyS') {
        direction = 'down'
      } else if (e.code === 'ArrowRight' || e.key === 'ArrowRight' || e.code === 'KeyD' || e.code === 'KeyE') {
        direction = 'stay'
      }

      if (!direction) return
      e.preventDefault()

      const currentBeat = timeline.msToBeat(positionRef.current)
      setSegments((prevSegments) => {
        const lastEndBeat = prevSegments.reduce((sum, s) => sum + s.beats, 0)
        const rawBeats = currentBeat - lastEndBeat
        const beats = Math.max(snap, Math.round(rawBeats / snap) * snap)
        return [...prevSegments, { direction, beats }]
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [snap, timeline])

  const removeRing = (index: number) => {
    setRings((prev) => prev.filter((_, i) => i !== index))
  }

  const seekTo = (ms: number) => {
    const clamped = Math.max(0, Math.min(ms, durationMs || ms))
    setPositionMs(clamped)
    positionRef.current = clamped
    if (isPlaying) {
      void playFrom(clamped)
    }
  }

  const buildChart = useCallback((): Chart => {
    // TODO: title / artist の編集UI（現在は固定値）
    return {
      title: 'Reply',
      artist: '',
      bpm: safeBpm,
      audio: url,
      audio_offset: audioOffset,
      scroll_speed: scrollSpeed,
      amplitude,
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
  }

  const closePlaytest = useCallback(() => {
    setPlaytest(null)
  }, [])

  return (
    <div className="editor-screen screen-fade">
      <header className="editor-header">
        <h1>オーサリングツール</h1>
        <Link to="/">/ に戻る</Link>
      </header>

      <div className="editor-body">
        <aside className="editor-sidebar">
          <section className="editor-pane">
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
            <div className="editor-controls">
              <button type="button" onClick={toggle}>
                {isPlaying ? '停止' : '再生'}
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
            {error && <div className="editor-error">{error}</div>}
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
              audioOffset={audioOffset}
              onAudioOffsetChange={setAudioOffset}
            />
          </section>

          <section className="editor-pane">
            <h2>エクスポート</h2>
            <div className="editor-controls">
              <button type="button" onClick={exportChart}>
                エクスポート
              </button>
              <button type="button" onClick={() => setPlaytest(buildChart())}>
                プレイテスト
              </button>
            </div>
            <p className="editor-hint">現在の状態をTOMLとして reply.toml に書き出し。プレイテストはエクスポートせずその場で確認</p>
          </section>
        </aside>

        <main className="editor-main">
          <WavePreview
            segments={segments}
            bpm={safeBpm}
            bpmChanges={bpmChanges}
            rings={rings}
            amplitude={amplitude}
          />
          <SegmentEditor segments={segments} onSegmentsChange={setSegments} />

          <section className="editor-pane">
            <h2>リング録音</h2>
            <div className="editor-field">
              <label className="editor-label" htmlFor="snap">
                スナップ
              </label>
              <select
                id="snap"
                className="editor-input"
                value={snap}
                onChange={(e) => setSnap(Number(e.target.value))}
              >
                {SNAP_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    1/{Math.round(1 / s)}
                  </option>
                ))}
              </select>
            </div>
            <p className="editor-hint">再生中に Space で現在のbeatをスタンプ</p>
            {rings.length === 0 ? (
              <p className="editor-empty">リングなし</p>
            ) : (
              <ul className="ring-list">
                {rings.map((ring, i) => (
                  <li key={`${i}-${ring.beat}`} className="ring-list-item">
                    <span className="ring-list-beat">beat: {ring.beat.toFixed(2)}</span>
                    <button
                      type="button"
                      className="ring-list-delete"
                      onClick={() => removeRing(i)}
                      aria-label={`beat ${ring.beat.toFixed(2)} を削除`}
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </div>

      {playtest && (
        <div className="playtest-overlay">
          <GameScreen playtestChart={playtest} onExit={closePlaytest} />
        </div>
      )}
    </div>
  )
}
