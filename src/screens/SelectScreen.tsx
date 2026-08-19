import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadSongList } from '../chart/manifest'
import type { SongEntry } from '../types'

const MAX_DIFFICULTY = 5

export default function SelectScreen() {
  const navigate = useNavigate()
  const [songs, setSongs] = useState<SongEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadSongList()
      .then(setSongs)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '曲リストの読み込みに失敗しました')
      })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'l' || e.key === 'L') {
        navigate('/calibration')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  return (
    <div className="screen select-screen">
      <header className="select-header">
        <h1>トレース・ウェーブ</h1>
        <span className="select-sub">Trace Wave</span>
      </header>

      {error ? (
        <p className="select-error">{error}</p>
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

      <div className="select-hint">L: キャリブレーション</div>
    </div>
  )
}
