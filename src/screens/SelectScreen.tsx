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
import { putChart, putAudio, listCharts, deleteChart, deleteAudio, getChart } from '../storage/libraryDb'
import { handleZipFile as importZipFile } from '../storage/zipImport'
import type { StoredChart } from '../storage/libraryDb'
import CalibrationModal from './editor/CalibrationModal'
import { getViewMode, ViewMode } from '../viewMode'
import { getPlayCount } from '../storage/playCounts'
import type { Chart, SongEntry } from '../types'

// Global counts (by song title) fetched once per mount; falls back to local.
async function loadGlobalCounts(): Promise<Record<string, number>> {
  try {
    const { fetchGlobalCounts } = await import('../storage/playCounts')
    return await fetchGlobalCounts()
  } catch {
    return {}
  }
}

// Global bests (by song title) fetched once per mount.
async function loadGlobalBests(): Promise<Record<string, { score: number; rank: string | null }>> {
  try {
    const { fetchBestScores } = await import('../storage/highScores')
    return await fetchBestScores()
  } catch {
    return {}
  }
}

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
  // Debug-mode inline rename state (card id + draft text)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const commitRename = useCallback(async (songId: string, newTitle: string) => {
    const title = newTitle.trim()
    setRenamingId(null)
    if (!title) return
    setSongs((prev) => {
      const target = prev.find((s) => s.id === songId)
      if (!target || target.title === title) return prev
      // Persist: update IndexedDB record (title + re-serialized TOML) and caches
      void (async () => {
        try {
          const stored = await getChart(songId)
          if (stored) {
            const parsed = parseChartText(stored.toml, songId)
            parsed.title = title
            await putChart({ ...stored, title, toml: chartToToml(parsed) })
            ChartCache.set(songId, parsed)
          }
        } catch (err) {
          console.warn('[SelectScreen] Failed to persist renamed song', err)
          setImportError(err instanceof Error ? err.message : '曲名の保存に失敗しました')
        }
      })()
      return prev.map((s) => (s.id === songId ? { ...s, title } : s))
    })
  }, [])

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
  // Global play counts keyed by song title (empty when backend unconfigured).
  const [globalCounts, setGlobalCounts] = useState<Record<string, number>>({})
  // Global bests keyed by song title (empty when backend unconfigured).
  const [globalBests, setGlobalBests] = useState<Record<string, { score: number; rank: string | null }>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const g = await loadGlobalCounts()
      if (!cancelled && Object.keys(g).length > 0) setGlobalCounts(g)
      const b = await loadGlobalBests()
      if (!cancelled && Object.keys(b).length > 0) setGlobalBests(b)
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
      const result = await importZipFile(file)

      if (result.newSongs.length === 0 && result.skipped.length === 0) {
        setImportError('zipファイルに譜面(TOML)が含まれていません')
        return
      }

      // Persist charts and audio to IndexedDB using unified IDs from result.newSongs
      for (let i = 0; i < result.pairs.length; i++) {
        const pair = result.pairs[i]
        const id = result.newSongs[i]?.id || `custom-${Date.now()}-${i}`
        const title = pair.chart.title || pair.tomlPath.replace(/\.toml$/i, '') || 'Untitled'
        const toml = chartToToml(pair.chart)
        const audioId = pair.audioBytes && pair.audioBytes.length > 0 ? id : null

        ChartCache.set(id, pair.chart)
        ChartCache.set(pair.tomlPath, pair.chart)

        void (async () => {
          try {
            await putChart({
              id,
              title,
              artist: pair.chart.artist || '',
              difficulty: 3,
              toml,
              audioId,
              addedAt: Date.now(),
            })
          } catch (e) {
            console.warn('[SelectScreen] Failed to persist zip chart to IndexedDB', e)
          }
        })()

        // Empty audio bytes → pair not established, report and do not store
        if (pair.audioBytes && pair.audioBytes.length > 0) {
          const audioBaseName = getBasename(pair.audioName || pair.audioPath)
          void (async () => {
            try {
              const mgr = AudioManager.getInstance()
              await mgr.ensure()
              const audioFileObj = new File([pair.audioBytes as BlobPart], audioBaseName, {
                type: `audio/${(pair.audioPath || audioBaseName).split('.').pop() || 'octet-stream'}`,
              })
              const buf = await loadAudioFromFile(audioFileObj, mgr.ctx)
              if (buf) {
                AudioCache.set(audioBaseName, buf)
                AudioCache.set(id, buf)
                await putAudio({
                  id,
                  name: audioBaseName,
                  mime: audioFileObj.type,
                  bytes: pair.audioBytes,
                })
              }
            } catch (e) {
              console.warn('[SelectScreen] Failed to decode zip audio', e)
            }
          })()
        } else {
          setImportError(`音声ファイルが空のためスキップ: ${pair.tomlPath}（空バイトは保存されません）`)
        }
      }

      setSongs(prev => [...prev, ...result.newSongs])

      if (result.skipped.length > 0) {
        setImportError(`以下のファイルはスキップされました: ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ` 他${result.skipped.length - 5}件` : ''}`)
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
        <h1>トレースウェーブ（音ゲー）</h1>
        <span className="select-sub">Trace Wave</span>
      </header>

      {viewMode !== 'debug' && (
        <>
          <p className="select-guide" data-testid="select-guide">
            曲を選択し自由に遊んでください。シャイニングスターの方が簡単です。
          </p>
          <p className="select-guide-sub" data-testid="select-guide-sub">
            選択するとチュートリアルから始まります
          </p>
        </>
      )}

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
            {viewMode !== 'debug'
              ? '曲がありません。'
              : '曲がありません。上のエリアから譜面TOMLと音声をインポートしてください。'}
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
                  {viewMode === 'debug' && renamingId === song.id ? (
                    <input
                      className="song-card-rename-input"
                      data-testid={`rename-input-${song.id}`}
                      value={renameDraft}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename(song.id, renameDraft)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') void commitRename(song.id, renameDraft)
                        else if (e.key === 'Escape') setRenamingId(null)
                      }}
                      style={{ fontSize: '1.125rem', fontWeight: 600, width: '100%' }}
                    />
                  ) : (
                    <div className="song-card-title">{song.title}</div>
                  )}
                  <div className="song-card-artist">{song.artist || 'Unknown Artist'}</div>
                  {viewMode === 'debug' && (
                    <div
                      className="song-card-plays"
                      data-testid={`play-count-${song.id}`}
                      style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                    >
                      ▶ {globalCounts[song.title] ?? getPlayCount(song.id)}回
                    </div>
                  )}
                  {viewMode === 'debug' && globalBests[song.title] !== undefined && (
                    <div
                      className="song-card-best"
                      data-testid={`best-${song.id}`}
                      style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                    >
                      最高 {globalBests[song.title].score.toLocaleString()}点
                    </div>
                  )}
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
                    aria-label={`${song.title}の名前を変更`}
                    data-testid={`rename-${song.id}`}
                    className="song-card-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenameDraft(song.title)
                      setRenamingId(song.id)
                    }}
                    style={{
                      position: 'absolute',
                      top: '6px',
                      right: '30px',
                      width: '20px',
                      height: '20px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--bg-surface)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      cursor: 'pointer',
                      fontSize: '12px',
                      lineHeight: 1,
                      padding: 0,
                      zIndex: 1,
                    }}
                  >
                    ✎
                  </button>
                )}
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
