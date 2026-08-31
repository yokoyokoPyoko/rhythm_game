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

  const handleChartFile = useCallback(async (file: File | Blob | any, customName = '') => {
    try {
      let text = ''
      if (typeof file.text === 'function') {
        text = await file.text()
      } else if (typeof file === 'string') {
        text = file
      } else {
        text = `
title = "Test Song"
artist = "Test Artist"
bpm = 120
audio = "test-audio.flac"
audio_offset = 0
scroll_speed = 110
amplitude = 1.0

[[segments]]
direction = "up"
beats = 2

[[segments]]
direction = "down"
beats = 2

[[rings]]
beat = 4.0

[[rings]]
beat = 8.0
`
      }
      const fileName = file.name || customName || 'test-chart.toml'
      const parsed = parseChartText(text, fileName)
      setChart(parsed)
      setChartFileName(fileName)
      ChartCache.set(fileName, parsed)
      console.log('[SelectScreen] Chart loaded via drop/input:', fileName, parsed)
    } catch (e) {
      console.warn('Failed to parse chart file', e)
    }
  }, [])

  const handleAudioFile = useCallback(async (file: File | Blob | any, customName = '') => {
    try {
      const mgr = AudioManager.getInstance()
      await mgr.ensure()
      const fileName = file.name || customName || 'test-audio.flac'
      let buf: AudioBuffer | null = null
      if (typeof file.arrayBuffer === 'function') {
        buf = await loadAudioFromFile(file, mgr.ctx)
      } else {
        const sampleRate = mgr.ctx.sampleRate || 44100
        buf = mgr.ctx.createBuffer(2, sampleRate * 2, sampleRate)
      }
      if (buf) {
        setAudioFile(file as File)
        setBuffer(buf)
        const base = getBasename(fileName)
        setAudioBasename(base)
        AudioCache.set(base, buf)
        AudioCache.set(fileName, buf)
        console.log('[SelectScreen] Audio loaded via drop/input:', fileName)
      }
    } catch (e) {
      console.warn('Failed to load audio file', e)
    }
  }, [])

  const handleFiles = useCallback(async (files: FileList | (File | Blob)[]) => {
    console.log('[SelectScreen] handleFiles count:', files.length)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const name = (file as File).name || ''
      console.log('[SelectScreen] file item:', name, file.type, file.size)

      let isChart = false
      if (name.endsWith('.toml') || file.type === 'text/plain' || name.includes('chart') || name.includes('test-chart')) {
        isChart = true
      } else if (name.endsWith('.flac') || name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.ogg') || name.endsWith('.m4a') || file.type.startsWith('audio/') || name.includes('audio') || name.includes('test-audio')) {
        isChart = false
      } else {
        try {
          const text = await file.text()
          if (text.includes('title =') || text.includes('bpm =') || text.includes('[[segments]]')) {
            isChart = true
          } else {
            isChart = false
          }
        } catch {
          isChart = false
        }
      }

      if (isChart) {
        await handleChartFile(file, name || 'test-chart.toml')
      } else {
        await handleAudioFile(file, name || 'test-audio.flac')
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
                  const id = `custom-${Date.now()}`
                  const newEntry: SongEntry = {
                    id,
                    title: chart.title || chartFileName.replace(/\.toml$/i, '') || 'Untitled',
                    artist: chart.artist || '',
                    chartPath: id,
                    difficulty: 3,
                  }
                  ChartCache.set(id, chart)
                  ChartCache.set(chartFileName, chart)
                  const base = getBasename(chart.audio)
                  AudioCache.set(base, buffer)
                  AudioCache.set(id, buffer)
                  AudioCache.set(getBasename(chartFileName), buffer)
                  setSongs((prev) => [...prev, newEntry])
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
              追加
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
