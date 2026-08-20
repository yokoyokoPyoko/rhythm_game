import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ScoreStats } from '../game/score'

const COUNT_UP_DURATION = 1000

type Rank = 'S' | 'A' | 'B' | 'C' | 'D'

const EMPTY_STATS: ScoreStats = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  perfect: 0,
  good: 0,
  miss: 0,
}

function getRank(stats: ScoreStats): Rank {
  const total = stats.perfect + stats.good + stats.miss
  if (total === 0) return 'D'
  const perfectRatio = stats.perfect / total
  if (perfectRatio >= 0.95) return 'S'
  if (perfectRatio >= 0.8) return 'A'
  if (perfectRatio >= 0.6) return 'B'
  if (perfectRatio >= 0.4) return 'C'
  return 'D'
}

export default function ResultScreen() {
  const location = useLocation()
  const navigate = useNavigate()
  const state = (location.state ?? {}) as { stats?: ScoreStats; songId?: string }
  const stats = state.stats ?? EMPTY_STATS
  const songId = state.songId
  const rank = getRank(stats)

  const [displayScore, setDisplayScore] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    const target = stats.score
    const startTime = performance.now()

    const tick = (now: number) => {
      const elapsed = now - startTime
      const t = Math.min(1, elapsed / COUNT_UP_DURATION)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplayScore(Math.round(target * eased))
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [stats.score])

  const handleRetry = () => {
    if (songId) {
      navigate('/play/' + songId)
    } else {
      navigate('/')
    }
  }

  return (
    <div className="screen result-screen screen-fade">
      <h1 className="result-title">リザルト</h1>

      <div className="result-rank" data-rank={rank}>
        {rank}
      </div>

      <div className="result-score">{displayScore.toLocaleString()}</div>

      <div className="result-stats">
        <div className="result-stat perfect">
          <span className="result-stat-label">PERFECT</span>
          <span className="result-stat-value">{stats.perfect}</span>
        </div>
        <div className="result-stat good">
          <span className="result-stat-label">GOOD</span>
          <span className="result-stat-value">{stats.good}</span>
        </div>
        <div className="result-stat miss">
          <span className="result-stat-label">MISS</span>
          <span className="result-stat-value">{stats.miss}</span>
        </div>
      </div>

      <div className="result-actions">
        <button className="result-button primary" onClick={handleRetry}>
          もう一回
        </button>
        <button className="result-button" onClick={() => navigate('/')}>
          曲選択
        </button>
      </div>
    </div>
  )
}