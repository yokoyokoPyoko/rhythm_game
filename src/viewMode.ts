export type ViewMode = 'public' | 'debug'

const STORAGE_KEY = 'traceWaveViewMode'

export function getViewMode(): ViewMode {
  const val = localStorage.getItem(STORAGE_KEY)
  if (val === 'debug' || val === 'public') {
    return val
  }
  return 'public'
}

export function setViewMode(mode: ViewMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
  window.dispatchEvent(new Event('trace-wave-view-mode-changed'))
}

export function toggleViewMode(): ViewMode {
  const current = getViewMode()
  const next: ViewMode = current === 'public' ? 'debug' : 'public'
  setViewMode(next)
  return next
}
