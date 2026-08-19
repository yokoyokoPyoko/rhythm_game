import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioManager } from '../audio/AudioManager'
import { BpmTimeline } from '../audio/bpmTimeline'
import { loadAudio } from '../audio/loader'

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
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [durationMs, setDurationMs] = useState(0)
  const [positionMs, setPositionMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startCtxTimeRef = useRef(0)
  const startMsRef = useRef(0)

  const safeBpm = bpm > 0 ? bpm : 120
  const timeline = useMemo(() => new BpmTimeline(safeBpm, []), [safeBpm])
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
        setIsPlaying(false)
      } else {
        setPositionMs(pos)
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
        setIsPlaying(false)
      }
    }
    sourceRef.current = src
    startCtxTimeRef.current = ctx.currentTime
    startMsRef.current = fromMs
    setIsPlaying(true)
    setError(null)
  }

  const stop = () => {
    const src = sourceRef.current
    if (!src) return
    const ctx = AudioManager.getInstance().ctx
    const pos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000
    setPositionMs(buffer ? Math.min(pos, buffer.duration * 1000) : pos)
    try {
      src.stop()
    } catch {
      /* already ended */
    }
    src.disconnect()
    sourceRef.current = null
    setIsPlaying(false)
  }

  const toggle = () => {
    if (isPlaying) {
      stop()
    } else {
      void playFrom(positionMs)
    }
  }

  const seekTo = (ms: number) => {
    const clamped = Math.max(0, Math.min(ms, durationMs || ms))
    setPositionMs(clamped)
    if (isPlaying) {
      void playFrom(clamped)
    }
  }

  return (
    <div className="editor-screen">
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
            <div className="editor-field">
              <label className="editor-label" htmlFor="bpm">
                基本BPM
              </label>
              <input
                id="bpm"
                className="editor-input"
                type="number"
                min={1}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
              />
            </div>
            {/* TODO(T54): BPM変更リスト・タップテンポ */}
          </section>
        </aside>

        <main className="editor-main">
          <div className="editor-timeline">
            {/* TODO(T52/T53): リング録音・セグメントエディタ・タイムライン */}
          </div>
        </main>
      </div>
    </div>
  )
}
