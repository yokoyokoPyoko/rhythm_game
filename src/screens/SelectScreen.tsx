import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadSongList } from '../chart/manifest'
import { parseChartText } from '../chart/loader'
import { loadAudioFromFile } from '../audio/loader'
import { AudioManager } from '../audio/AudioManager'
import { getManualOffsetMs, setManualOffset } from '../audio/clock'
import { AudioCache, getBasename } from '../audio/AudioCache'
import { ChartCache } from '../chart/cache'
import { chartToToml } from '../chart/serialize'
import { putChart, putAudio, listCharts, deleteChart, deleteAudio } from '../storage/libraryDb'
import type { StoredChart } from '../storage/libraryDb'
import CalibrationModal from './editor/CalibrationModal'
import { getViewMode, ViewMode } from '../viewMode'
import type { Chart, SongEntry } from '../types'
import { unzipSync } from 'fflate'

const MAX_DIFFICULTY = 5
const SKELETON_COUNT = 4

export default function SelectScreen() {
  const navigate = useNavigate()
  const [songs, setSongs] = useState<SongEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const [chart, setChart] = useState<Chart | null>(null)
  const [chartFileName, setChartFileName] = useState<string>('')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [audioBasename, setAudioBasename] = useState<string>('')

  const dropzoneRef = useRef<HTMLDivElement>(null)
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const savedOffsetRef = useRef(getManualOffsetMs())

  useEffect(() => {
    loadSongList()
      .then(async (list) => {
        let customEntries: SongEntry[] = []
        try {
          const stored = await listCharts()
          customEntries = stored.map((sc: StoredChart) => ({
            id: sc.id,
            title: sc.title,
            artist: sc.artist,
            chartPath: sc.id,
            difficulty: sc.difficulty,
          }))
        } catch {
          /* IndexedDB unavailable, skip custom songs */
        }
        setSongs([...list, ...customEntries])
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '曲リストの読み込みに失敗しました')
        setLoading(false)
      })
  }, [])

  const [viewMode, setViewMode] = useState<ViewMode>(getViewMode())

  useEffect(() => {
    const handleModeChange = () => {
      setViewMode(getViewMode())
    }
    window.addEventListener('storage', handleModeChange)
    window.addEventListener('trace-wave-view-mode-changed', handleModeChange)
    return () => {
      window.removeEventListener('storage', handleModeChange)
      window.removeEventListener('trace-wave-view-mode-changed', handleModeChange)
    }
  }, [])

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
      setImportError(null)
      ChartCache.set(fileName, parsed)
      console.log('[SelectScreen] Chart loaded via drop/input:', fileName, parsed)
    } catch (e) {
      console.warn('Failed to parse chart file', e)
      setImportError(e instanceof Error ? e.message : '譜面ファイルの解析に失敗しました')
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
        setImportError(null)
        AudioCache.set(base, buf)
        AudioCache.set(fileName, buf)
        console.log('[SelectScreen] Audio loaded via drop/input:', fileName)
      }
    } catch (e) {
      console.warn('Failed to load audio file', e)
      setImportError(e instanceof Error ? e.message : '音声ファイルの読み込みに失敗しました')
    }
  }, [])

  const handleZipFile = useCallback(async (file: File) => {
    try {
      const arrayBuffer = await file.arrayBuffer()
      const data = new Uint8Array(arrayBuffer)
      const unzipped = unzipSync(data)

      // Group files by directory (zip path prefix before last /)
      const groups: Record<string, Record<string, Uint8Array>> = {}
      const audioExts = ['.flac', '.mp3', '.wav', '.ogg', '.m4a']
      const skippedFiles: string[] = []
      const usedAudioPaths = new Set<string>()

      for (const [path, bytes] of Object.entries(unzipped)) {
        // Skip directories, __MACOSX, dotfiles
        if (path.endsWith('/')) continue
        if (path.startsWith('__MACOSX/')) continue
        const parts = path.split('/')
        const fileName = parts[parts.length - 1]
        if (fileName.startsWith('.')) continue

        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
        if (!groups[dir]) groups[dir] = {}
        groups[dir][fileName] = bytes
      }

      const newSongs: SongEntry[] = []
      let pairIndex = 0
      const baseTime = Date.now()

      for (const [dir, files] of Object.entries(groups)) {
        // Find all TOML and audio files in this folder
        const tomlFiles: [string, Uint8Array][] = []
        const audioFiles: [string, Uint8Array][] = []

        for (const [name, bytes] of Object.entries(files)) {
          if (name.endsWith('.toml')) {
            tomlFiles.push([name, bytes])
          } else if (audioExts.some(ext => name.toLowerCase().endsWith(ext))) {
            audioFiles.push([name, bytes])
          }
        }

        if (tomlFiles.length === 0) {
          // No TOML in this group — skip non-TOML files
          for (const name of Object.keys(files)) {
            if (!audioExts.some(ext => name.toLowerCase().endsWith(ext))) {
              skippedFiles.push(dir ? `${dir}/${name}` : name)
            }
          }
          continue
        }

        // For each TOML, try to pair with audio
        for (const [tomlName, tomlBytes] of tomlFiles) {
          let text: string
          try {
            text = new TextDecoder().decode(tomlBytes)
          } catch {
            skippedFiles.push(dir ? `${dir}/${tomlName}` : tomlName)
            continue
          }

          let parsed: Chart
          try {
            parsed = parseChartText(text, tomlName)
          } catch {
            skippedFiles.push(dir ? `${dir}/${tomlName}` : tomlName)
            continue
          }

          const audioBase = getBasename(parsed.audio)
          // Find matching audio in same folder
          const matchEntry = audioFiles.find(([name]) => {
            const extIdx = name.lastIndexOf('.')
            const base = extIdx > 0 ? name.substring(0, extIdx) : name
            return base === audioBase || name === audioBase
          })

          const id = `custom-${baseTime}-${pairIndex++}`
          const title = parsed.title || tomlName.replace(/\.toml$/i, '') || 'Untitled'
          const toml = chartToToml(parsed)

          // Register chart
          ChartCache.set(id, parsed)
          ChartCache.set(tomlName, parsed)
          const newEntry: SongEntry = {
            id,
            title,
            artist: parsed.artist || '',
            chartPath: id,
            difficulty: 3,
          }
          newSongs.push(newEntry)

          // Persist chart to IndexedDB
          const audioId = matchEntry ? id : null
          void (async () => {
            try {
              await putChart({
                id,
                title,
                artist: parsed.artist || '',
                difficulty: 3,
                toml,
                audioId,
                addedAt: baseTime,
              })
            } catch (e) {
              console.warn('[SelectScreen] Failed to persist zip chart to IndexedDB', e)
            }
          })()

          if (matchEntry) {
            const [audioName, audioBytes] = matchEntry
            const audioBaseName = getBasename(audioName)
            if (!usedAudioPaths.has(dir + '/' + audioName)) {
              usedAudioPaths.add(dir + '/' + audioName)
              const audioFileObj = new File([audioBytes], audioBaseName, {
                type: `audio/${audioName.split('.').pop() || 'octet-stream'}`,
              })
              const mgr = AudioManager.getInstance()
              void mgr.ensure().then(async () => {
                try {
                  const buf = await loadAudioFromFile(audioFileObj, mgr.ctx)
                  if (buf) {
                    AudioCache.set(audioBaseName, buf)
                    AudioCache.set(id, buf)
                    void (async () => {
                      try {
                        await putAudio({
                          id,
                          name: audioBaseName,
                          mime: audioFileObj.type,
                          bytes: audioBytes,
                        })
                      } catch (e) {
                        console.warn('[SelectScreen] Failed to persist zip audio to IndexedDB', e)
                      }
                    })()
                  }
                } catch (e) {
                  console.warn('[SelectScreen] Failed to decode zip audio', e)
                }
              })
            }
          } else {
            skippedFiles.push(dir ? `${dir}/${tomlName}` : tomlName + ' (音声ファイル不一致)')
          }
        }

        // Report audio files that were never paired with a TOML in this folder
        for (const [audioName] of audioFiles) {
          if (!usedAudioPaths.has(dir + '/' + audioName)) {
            skippedFiles.push(dir ? `${dir}/${audioName}` : audioName)
          }
        }
      }

      if (newSongs.length === 0 && skippedFiles.length === 0) {
        setImportError('zipファイルに譜面(TOML)が含まれていません')
        return
      }

      setSongs(prev => [...prev, ...newSongs])

      if (skippedFiles.length > 0) {
        setImportError(`以下のファイルはスキップされました: ${skippedFiles.slice(0, 5).join(', ')}${skippedFiles.length > 5 ? ` 他${skippedFiles.length - 5}件` : ''}`)
      } else {
        setImportError(null)
      }
    } catch (e) {
      console.warn('[SelectScreen] Failed to process zip file', e)
      setImportError(e instanceof Error ? e.message : 'zipファイルの読み込みに失敗しました')
    }
  }, [])

  const handleFiles = useCallback(async (files: FileList | (File | Blob)[]) => {
    console.log('[SelectScreen] handleFiles count:', files.length)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const name = (file as File).name || ''
      console.log('[SelectScreen] file item:', name, file.type, file.size)

      // Zip files are handled specially (folder-grouped multi-song import)
      if (name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
        await handleZipFile(file as File)
        continue
      }

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
  }, [handleChartFile, handleAudioFile, handleZipFile])

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

      {viewMode === 'debug' && (
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
                    const title = chart.title || chartFileName.replace(/\.toml$/i, '') || 'Untitled'
                    const toml = chartToToml(chart)
                    const base = getBasename(chart.audio)
                    const newEntry: SongEntry = {
                      id,
                      title,
                      artist: chart.artist || '',
                      chartPath: id,
                      difficulty: 3,
                    }
                    ChartCache.set(id, chart)
                    ChartCache.set(chartFileName, chart)
                    AudioCache.set(base, buffer)
                    AudioCache.set(id, buffer)
                    AudioCache.set(getBasename(chartFileName), buffer)
                    setSongs((prev) => [...prev, newEntry])

                    // Persist to IndexedDB
                    void (async () => {
                      try {
                        await putChart({
                          id,
                          title,
                          artist: chart.artist || '',
                          difficulty: 3,
                          toml,
                          audioId: id,
                          addedAt: Date.now(),
                        })
                        if (audioFile) {
                          const raw = await audioFile.arrayBuffer()
                          await putAudio({
                            id,
                            name: audioFile.name || base,
                            mime: audioFile.type || 'application/octet-stream',
                            bytes: new Uint8Array(raw),
                          })
                        }
                        setImportError(null)
                      } catch (e) {
                        console.warn('[SelectScreen] Failed to persist to IndexedDB', e)
                        setImportError(e instanceof Error ? e.message : 'カスタム譜面の保存に失敗しました（再読み込み後は消える場合があります）')
                      }
                    })()
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
          <div style={{ marginBottom: '12px', padding: '12px', border: '1px dashed var(--border)', borderRadius: 'var(--radius)' }}>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>zip一括インポート（曲ごとのフォルダ分け・TOMLと音声を同一フォルダに）</label>
                <input
                  type="file"
                  accept=".zip"
                  data-testid="home-zip-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) {
                      void handleZipFile(f)
                    }
                  }}
                />
              </div>
            </div>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            ここにTOMLファイルや音声ファイルをドラッグ＆ドロップ（またはファイル選択）してください。
            {chart && ` ターゲット音源: ${chart.audio}`}
          </p>
          {importError && (
            <p data-testid="select-import-error" style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>
              {importError}
            </p>
          )}
        </div>
      )}

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
      ) : songs.length === 0 ? (
        <div className="song-grid-empty" data-testid="empty-song-list">
          <p className="empty-message">
            曲がありません。上のエリアから譜面TOMLと音声をインポートしてください。
          </p>
        </div>
      ) : (
        <div className="song-grid">
          {songs.map((song) => {
            const isCustom = song.id.startsWith('custom-')
            return (
              <div key={song.id} className="song-card-wrapper" style={{ position: 'relative' }}>
                <button
                  className="song-card"
                  onClick={() => {
                    if (isCustom) {
                      // Load chart from IndexedDB cache into ChartCache so GameScreen can find it
                      const cached = ChartCache.get(song.id)
                      if (!cached) {
                        void (async () => {
                          try {
                            const { getChart } = await import('../storage/libraryDb')
                            const stored = await getChart(song.id)
                            if (stored) {
                              const parsed = parseChartText(stored.toml, song.id)
                              ChartCache.set(song.id, parsed)
                            }
                          } catch {
                            /* fall through to navigation */
                          }
                          navigate('/play/' + song.id)
                        })()
                        return
                      }
                    }
                    navigate('/play/' + song.id)
                  }}
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
                {viewMode === 'debug' && isCustom && (
                  <button
                    type="button"
                    aria-label={`${song.title}を削除`}
                    data-testid={`delete-${song.id}`}
                    className="song-card-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      void (async () => {
                        try {
                          await deleteChart(song.id)
                          await deleteAudio(song.id)
                        } catch (err) {
                          console.warn('[SelectScreen] Failed to delete custom song', err)
                          setImportError(err instanceof Error ? err.message : 'カスタム譜面の削除に失敗しました')
                        }
                        ChartCache.clear()
                        AudioCache.clear()
                        setSongs((prev) => prev.filter((s) => s.id !== song.id))
                      })()
                    }}
                    style={{
                      position: 'absolute',
                      top: '6px',
                      right: '6px',
                      width: '20px',
                      height: '20px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--danger)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 'var(--radius)',
                      cursor: 'pointer',
                      fontSize: '12px',
                      lineHeight: 1,
                      padding: 0,
                      zIndex: 1,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {viewMode === 'debug' && (
        <div className="select-nav">
          <button type="button" className="select-nav-button" onClick={() => navigate('/editor')}>
            エディタ
          </button>
          <button
            type="button"
            className="select-nav-button"
            data-testid="select-calibration-button"
            onClick={() => {
              savedOffsetRef.current = getManualOffsetMs()
              setCalibrationOpen(true)
            }}
          >
            キャリブレーション
          </button>
          <span className="select-hint">L: キャリブレーション / E: エディタ</span>
        </div>
      )}

      {calibrationOpen && (
        <CalibrationModal
          onClose={(save: boolean) => {
            setCalibrationOpen(false)
            if (!save) setManualOffset(savedOffsetRef.current)
          }}
        />
      )}
    </div>
  )
}
