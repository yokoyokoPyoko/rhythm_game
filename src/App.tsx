import { useState, useEffect } from 'react'
import { HashRouter, Route, Routes, Navigate } from 'react-router-dom'
import SelectScreen from './screens/SelectScreen'
import GameScreen from './screens/GameScreen'
import ResultScreen from './screens/ResultScreen'
import EditorScreen from './screens/EditorScreen'
import { getViewMode, toggleViewMode, ViewMode } from './viewMode'

function App() {
  const [mode, setMode] = useState<ViewMode>(getViewMode())

  useEffect(() => {
    const handleStorage = () => {
      setMode(getViewMode())
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener('trace-wave-view-mode-changed', handleStorage)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && e.key === '@') {
        e.preventDefault()
        const newMode = toggleViewMode()
        setMode(newMode)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('trace-wave-view-mode-changed', handleStorage)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <HashRouter>
      {mode === 'debug' && (
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
          DEBUG
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
