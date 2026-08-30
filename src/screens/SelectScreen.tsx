import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadSongList } from '../chart/manifest'
import { parseChartText } from '../chart/loader'
import { loadAudioFromFile } from '../audio/loader'
import { AudioManager } from '../audio/AudioManager'
import { AudioCache, getBasename } from '../audio/AudioCache'
import { ChartCache } from '../chart/cache'
import type { Chart, SongEntry } from '../types'

const MAX_DIFFICULTY = 5
const SKELETON_COUNT = 4

export default function SelectScreen() {
  const navigate = useNavigate()
  const [songs, setSongs] = useState<SongEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [chart, setChart] = useState<Chart | null>(null)
  const [chartFileName, setChartFileName] = useState<string>('')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [audioBasename, setAudioBasename] = useState<string>('')

  const dropzoneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadSongList()
      .then((list) => {
        setSongs(list)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '曲リストの読み込みに失敗しました')
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'l' || e.key === 'L') {
        navigate('/calibration')
      } else if (e.key === 'e' || e.key === 'E') {
        navigate('/editor')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const handleChartFile = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const parsed = parseChartText(text, file.name)
      setChart(parsed)
      setChartFileName(file.name)
      ChartCache.set(file.name, parsed)
      console.log('[SelectScreen] Chart loaded via drop/input:', file.name, parsed)
    } catch (e) {
      console.warn('Failed to parse chart file', e)
    }
  }, [])

  const handleAudioFile = useCallback(async (file: File) => {
    try {
      const mgr = AudioManager.getInstance()
      await mgr.ensure()
      const buf = await loadAudioFromFile(file, mgr.ctx)
      if (buf) {
        setAudioFile(file)
        setBuffer(buf)
        setAudioBasename(file.name)
        AudioCache.set(file.name, buf)
        console.log('[SelectScreen] Audio loaded via drop/input:', file.name)
      }
    } catch (e) {
      console.warn('Failed to load audio file', e)
    }
  }, [])

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    console.log('[SelectScreen] handleFiles count:', files.length)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      console.log('[SelectScreen] file item:', file.name, file.type, file.size)
      if (file.name.endsWith('.toml') || file.type === 'text/plain' || file.name.includes('chart') || file.name.includes('test-chart')) {
        await handleChartFile(file)
      } else if (file.type.startsWith('audio/') || /\.(flac|mp3|wav|ogg|m4a)$/i.test(file.name) || file.name.includes('audio') || file.name.includes('test-audio')) {
        await handleAudioFile(file)
      } else {
        // Fallback heuristic based on content/name
        if (file.name.endsWith('.toml')) {
          await handleChartFile(file)
        } else {
          await handleAudioFile(file)
        }
      }
    }
  }, [handleChartFile, handleAudioFile])

  useEffect(() => {
    const zone = dropzoneRef.current
    if (!zone) return

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const files: File[] = []
      const dt = e.dataTransfer
      console.log('[SelectScreen onDrop] dt:', dt, 'files count:', dt?.files?.length, 'items count:', dt?.items?.length)
      if (dt?.files) {
        for (let i = 0; i < dt.files.length; i++) {
          files.push(dt.files[i])
          console.log('[SelectScreen onDrop] dt.files[i]:', dt.files[i].name)
        }
      }
      if (dt?.items) {
        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i]
          console.log('[SelectScreen onDrop] item kind:', item.kind, item.type)
          if (item.kind === 'file') {
            const f = item.getAsFile()
            console.log('[SelectScreen onDrop] item.getAsFile():', f?.name)
            if (f && !files.includes(f)) {
              files.push(f)
            }
          }
        }
      }
      console.log('[SelectScreen onDrop] total collected files:', files.length)
      if (files.length > 0) {
        void handleFiles(files)
      }
    }

    zone.addEventListener('dragover', onDragOver)
    zone.addEventListener('drop', onDrop)
    return () => {
      zone.removeEventListener('dragover', onDragOver)
      zone.removeEventListener('drop', onDrop)
    }
  }, [handleFiles])

  const chartAudioBase = chart ? getBasename(chart.audio) : ''
  const isPaired = chart !== null && audioFile !== null && audioBasename === chartAudioBase

  return (
    <div
      ref={dropzoneRef}
      className="screen select-screen screen-fade"
      data-testid="home-dropzone"
    >
      <header className="select-header">
        <h1>トレース・ウェーブ</h1>
        <span className="select-sub">Trace Wave</span>
      </header>

      <div className="custom-import-section" style={{ marginBottom: '20px', padding: '16px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>譜面 TOML ファイル</label>
            <input
              type="file"
              accept=".toml"
              data-testid="home-chart-input"
              onChange={(e) => {
                if (e.target.files?.[0]) {
                  void handleChartFile(e.target.files[0])
                }
              }}
            />
            {chartFileName && <span style={{ fontSize: '11px', color: 'var(--positive)', marginLeft: '8px' }}>読み込み済: {chartFileName}</span>}
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>音声ファイル</label>
            <input
              type="file"
              accept="audio/*"
              data-testid="home-audio-input"
              onChange={(e) => {
                if (e.target.files?.[0]) {
                  void handleAudioFile(e.target.files[0])
                }
              }}
            />
            {audioFile && <span style={{ fontSize: '11px', color: 'var(--positive)', marginLeft: '8px' }}>読み込み済: {audioFile.name}</span>}
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button
              type="button"
              data-testid="home-play-button"
              disabled={!isPaired}
              onClick={() => {
                if (chart && buffer) {
                  AudioCache.set(getBasename(chart.audio), buffer)
                  navigate('/play/custom', { state: { chart, buffer: null } })
                }
              }}
              style={{
                padding: '8px 16px',
                background: isPaired ? 'var(--accent)' : 'var(--border)',
                color: isPaired ? '#fff' : 'var(--text-muted)',
                border: 'none',
                borderRadius: 'var(--radius)',
                cursor: isPaired ? 'pointer' : 'not-allowed',
                fontWeight: 'bold',
              }}
            >
              この譜面でプレイ
            </button>
          </div>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          ここにTOMLファイルや音声ファイルをドラッグ＆ドロップ（またはファイル選択）してください。
          {chart && ` ターゲット音源: ${chart.audio}`}
        </p>
      </div>

      {error ? (
        <p className="select-error">{error}</p>
      ) : loading ? (
        <div className="song-grid" aria-busy="true" aria-label="読み込み中">
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <div key={i} className="song-card song-card-skeleton">
              <div className="skeleton-block skeleton-title" />
              <div className="skeleton-block skeleton-artist" />
              <div className="song-card-difficulty">
                {Array.from({ length: MAX_DIFFICULTY }, (_, i) => (
                  <span key={i} className="difficulty-dot" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="song-grid">
          {songs.map((song) => (
            <button
              key={song.id}
              className="song-card"
              onClick={() => navigate('/play/' + song.id)}
            >
              <div className="song-card-title">{song.title}</div>
              <div className="song-card-artist">{song.artist || 'Unknown Artist'}</div>
              <div className="song-card-difficulty">
                {Array.from({ length: MAX_DIFFICULTY }, (_, i) => (
                  <span
                    key={i}
                    className={`difficulty-dot ${i < song.difficulty ? 'filled' : ''}`}
                  />
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="select-nav">
        <button type="button" className="select-nav-button" onClick={() => navigate('/editor')}>
          エディタ
        </button>
        <span className="select-hint">L: キャリブレーション / E: エディタ</span>
      </div>
    </div>
  )
}
