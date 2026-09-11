import { useState, useEffect } from 'react'
import { HashRouter, Route, Routes, Navigate } from 'react-router-dom'
import SelectScreen from './screens/SelectScreen'
import GameScreen from './screens/GameScreen'
import ResultScreen from './screens/ResultScreen'
import EditorScreen from './screens/EditorScreen'
import { getViewMode, toggleViewMode, ViewMode } from './viewMode'
import { isCountingPaused, toggleCountingPaused } from './storage/playCounts'

function App() {
  const [mode, setMode] = useState<ViewMode>(getViewMode())
  const [countPaused, setCountPaused] = useState(() => {
    try {
      return isCountingPaused()
    } catch {
      return false
    }
  })

  useEffect(() => {
    const handleStorage = () => {
      setMode(getViewMode())
    }
    const handleCountChange = () => {
      try {
        setCountPaused(isCountingPaused())
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener('trace-wave-view-mode-changed', handleStorage)
    window.addEventListener('trace-wave-counting-changed', handleCountChange)

    const handleKeyDown = (e: KeyboardEvent) => {
      // JIS配列では Shift+@ が '`' になるため e.key だけでは拾えない。
      // US配列 (Shift+2 → '@') と AltGr 環境での化けに備え、物理キー位置でも判定する。
      // BracketLeft = JISの@キー位置 / Digit2 = USの@キー位置
      const isToggleKey =
        e.key === '@' || e.key === '`' || e.code === 'BracketLeft' || e.code === 'Digit2'
      if (e.ctrlKey && e.altKey && e.shiftKey && isToggleKey) {
        e.preventDefault()
        const newMode = toggleViewMode()
        setMode(newMode)
        return
      }
      // カウントしないモードのオンオフ切替（JIS/US差異に備えcode併用）
      const isCountKey = e.key === '0' || e.code === 'Digit0'
      if (e.ctrlKey && e.altKey && e.shiftKey && isCountKey) {
        e.preventDefault()
        setCountPaused(toggleCountingPaused())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('trace-wave-view-mode-changed', handleStorage)
      window.removeEventListener('trace-wave-counting-changed', handleCountChange)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <HashRouter>
      {(mode === 'debug' || countPaused) && (
        <div
          style={{
            position: 'fixed',
            bottom: 8,
            right: 8,
            background: 'var(--bg-surface, #111)',
            border: '1px solid var(--border, rgba(255,255,255,0.08))',
            color: 'var(--warning, #fbbf24)',
            padding: '2px 6px',
            fontSize: '11px',
            borderRadius: '4px',
            zIndex: 99999,
            pointerEvents: 'none',
            fontFamily: 'var(--font)'
          }}
          data-testid="debug-badge"
        >
          {mode === 'debug' ? (countPaused ? 'DEBUG・カウント停止中' : 'DEBUG') : 'カウント停止中'}
        </div>
      )}
      <Routes>
        <Route path="/" element={<SelectScreen />} />
        <Route path="/play/:songId" element={<GameScreen />} />
        <Route path="/play/custom" element={<GameScreen />} />
        <Route path="/result" element={<ResultScreen />} />
        <Route
          path="/editor"
          element={mode === 'debug' ? <EditorScreen /> : <Navigate to="/" replace />}
        />
      </Routes>
    </HashRouter>
  )
}

export default App
