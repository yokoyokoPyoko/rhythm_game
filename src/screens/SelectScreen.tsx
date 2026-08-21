import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadSongList } from '../chart/manifest'
import type { SongEntry } from '../types'

const MAX_DIFFICULTY = 5
const SKELETON_COUNT = 4

export default function SelectScreen() {
  const navigate = useNavigate()
  const [songs, setSongs] = useState<SongEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="screen select-screen screen-fade">
      <header className="select-header">
        <h1>トレース・ウェーブ</h1>
        <span className="select-sub">Trace Wave</span>
      </header>

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
