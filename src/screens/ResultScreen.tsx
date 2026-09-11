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
  great: 0,
  good: 0,
  miss: 0,
}

function getRank(stats: ScoreStats): Rank {
  const total = stats.perfect + stats.great + stats.good + stats.miss
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
  const state = (location.state ?? {}) as { stats?: ScoreStats; songId?: string; title?: string; rank?: Rank }
  const stats = state.stats ?? EMPTY_STATS
  const songId = state.songId
  // Rank is decided by score alone in GameScreen (passed via state).
  // Fall back to the legacy local calc for direct access.
  const rank = state.rank ?? getRank(stats)
  const title = state.title ?? ''

  const [displayScore, setDisplayScore] = useState(0)
  const rafRef = useRef(0)
  const [globalBest, setGlobalBest] = useState<{ score: number; rank: string | null } | null>(null)
  const [isRecord, setIsRecord] = useState(false)
  const submittedRef = useRef(false)

  // Submit once per result view (StrictMode-safe via ref guard).
  // isRecord comes from submitHighScore, which only celebrates against
  // positively-known prior bests. No local fallback: on fetch failure the
  // best section stays hidden instead of showing a false NEW RECORD.
  useEffect(() => {
    if (submittedRef.current) return
    submittedRef.current = true
    if (!title) return
    void (async () => {
      try {
        const { submitHighScore, fetchBestScores } = await import('../storage/highScores')
        const res = await submitHighScore(title, stats.score, rank)
        if (res) {
          setGlobalBest(res.best)
          setIsRecord(res.isRecord)
        } else {
          const before = await fetchBestScores()
          if (before[title] !== undefined) setGlobalBest(before[title])
        }
      } catch {
        /* offline — hide best section */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

      {globalBest !== null && (
        <div className="result-best" data-testid="result-global-best">
          {isRecord && (
            <div className="result-record" data-testid="result-new-record">
              NEW RECORD!
            </div>
          )}
          <span className="result-best-label">みんなの最高</span>{' '}
          <span className="result-best-value">{globalBest.score.toLocaleString()}点</span>
        </div>
      )}

      <div className="result-stats">
        <div className="result-stat perfect">
          <span className="result-stat-label">PERFECT</span>
          <span className="result-stat-value">{stats.perfect}</span>
        </div>
        <div className="result-stat great">
          <span className="result-stat-label">GREAT</span>
          <span className="result-stat-value">{stats.great}</span>
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