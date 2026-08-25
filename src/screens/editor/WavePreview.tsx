import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { WaveEngine } from '../../game/waveEngine'
import type { BpmChange, RingDef, Segment } from '../../types'

const GAME_CENTER_Y = 300
const RULER_H = 22
const ACCENT_COLOR = '#6366f1'
const SUB_COLOR = '#22d3ee'
const STAY_COLOR = '#fbbf24'
const SELECT_COLOR = '#ededed'

export interface WaveView {
  startBeat: number
  beats: number
}

export interface RecordingState {
  beat: number
  y: number
  trajectory: { beat: number; y: number }[]
}

export interface WavePreviewProps {
  segments: Segment[]
  bpm: number
  bpmChanges?: BpmChange[]
  rings?: RingDef[]
  amplitude?: number
  snap?: number
  selectedRing?: number | null
  positionMs?: number
  view?: WaveView
  recording?: RecordingState | null
  onViewChange?: (view: WaveView) => void
  onAddRing?: (beat: number) => number | undefined
  onMoveRing?: (index: number, beat: number) => void
  onSelectRing?: (index: number | null) => void
  onDeleteRing?: (index: number) => void
  onSeek?: (beat: number) => void
}

export default function WavePreview({
  segments,
  bpm,
  bpmChanges = [],
  rings = [],
  amplitude = 130,
  snap = 0.25,
  selectedRing = null,
  positionMs,
  view,
  recording = null,
  onViewChange,
  onAddRing,
  onMoveRing,
  onSelectRing,
  onDeleteRing,
  onSeek,
}: WavePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geoRef = useRef<{ lastBeat: number; viewStart: number; viewBeats: number }>({
    lastBeat: 4,
    viewStart: 0,
    viewBeats: 16,
  })
  const dragRef = useRef<{ index: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; startBeat: number; viewBeats: number; moved: boolean } | null>(null)

  const safeSnap = snap > 0 ? snap : 0.25

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW === 0 || cssH === 0) return
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const ampVal = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 130
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges)
    const engine = new WaveEngine(segments, timeline, ampVal)

    const centerY = RULER_H + (cssH - RULER_H) / 2
    const fieldH = cssH - RULER_H
    const amp = Math.min((fieldH - 24) / 2, ampVal)
    const mapY = (y: number) => centerY + ((y - GAME_CENTER_Y) / ampVal) * amp

    const totalBeats = segments.reduce((sum, seg) => sum + seg.beats, 0)
    const contentBeats = Math.max(
      totalBeats,
      rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), 0),
      4,
    )
    const lastBeat = Math.max(contentBeats, 4)

    const viewStart = view && Number.isFinite(view.startBeat) ? view.startBeat : 0
    const viewBeats = view && view.beats > 0 ? view.beats : lastBeat
    const beatToX = (b: number) => ((b - viewStart) / viewBeats) * cssW
    geoRef.current = { lastBeat, viewStart, viewBeats }

    // Horizontal guide lines: top / center / bottom (high visibility)
    ctx.lineWidth = 1
    for (const gy of [mapY(GAME_CENTER_Y - ampVal), centerY, mapY(GAME_CENTER_Y + ampVal)]) {
      const isCenter = Math.abs(gy - centerY) < 0.5
      ctx.strokeStyle = isCenter ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.14)'
      ctx.beginPath()
      ctx.moveTo(0, gy)
      ctx.lineTo(cssW, gy)
      ctx.stroke()
    }

    // Beat ruler + vertical grid lines
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.fillRect(0, 0, cssW, RULER_H)
    ctx.font = '11px Inter, system-ui, sans-serif'
    ctx.textBaseline = 'top'
    const minorStep = viewBeats <= 8 ? 0.5 : viewBeats <= 32 ? 1 : 4
    const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep
    for (let i = 0; ; i++) {
      const b = Number((firstMinor + i * minorStep).toFixed(4))
      if (b > viewStart + viewBeats + 1e-9) break
      const gx = beatToX(b)
      if (gx < -2 || gx > cssW + 2) continue
      const strong = Math.abs(b % 4) < 1e-6
      ctx.strokeStyle = strong ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)'
      ctx.lineWidth = strong ? 1.5 : 1
      ctx.beginPath()
      ctx.moveTo(gx, RULER_H)
      ctx.lineTo(gx, cssH)
      ctx.stroke()
      if (strong) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fillText(String(b), gx + 4, 4)
      }
    }

    // Start / judgment line (left edge), thick & labeled
    ctx.strokeStyle = 'rgba(99,102,241,0.95)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(2, RULER_H)
    ctx.lineTo(2, cssH)
    ctx.stroke()
    ctx.fillStyle = 'rgba(99,102,241,0.95)'
    ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.fillText('START', 6, RULER_H + 4)

    // Segment color coding (up = accent, down = sub, stay = warning)
    const drawRangeEnd = viewStart + viewBeats
    const subSteps = Math.max(20, Math.round((drawRangeEnd - viewStart) * 8))
    let currentBeat = 0
    for (const seg of segments) {
      const segEnd = currentBeat + seg.beats
      if (segEnd < viewStart || currentBeat > drawRangeEnd) {
        currentBeat = segEnd
        continue
      }
      ctx.strokeStyle =
        seg.direction === 'up' ? ACCENT_COLOR : seg.direction === 'down' ? SUB_COLOR : STAY_COLOR
      ctx.lineWidth = 2.5
      ctx.beginPath()
      for (let s = 0; s <= subSteps; s++) {
        const b = viewStart + (s / subSteps) * (drawRangeEnd - viewStart)
        const x = beatToX(b)
        const y = mapY(engine.waveYAt(b))
        if (s === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      currentBeat = segEnd
    }

    if (segments.length === 0) {
      ctx.strokeStyle = ACCENT_COLOR
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(beatToX(0), mapY(GAME_CENTER_Y - ampVal))
      ctx.lineTo(beatToX(Math.max(lastBeat, viewBeats)), mapY(GAME_CENTER_Y - ampVal))
      ctx.stroke()
    }

    // Recording trajectory overlay (dashed) + live ball
    if (recording && recording.trajectory.length > 0) {
      ctx.strokeStyle = 'rgba(34,211,238,0.9)'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 5])
      ctx.beginPath()
      recording.trajectory.forEach((p, i) => {
        const x = beatToX(p.beat)
        const y = mapY(p.y)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.setLineDash([])
      const liveX = beatToX(recording.beat)
      const liveY = mapY(recording.y)
      ctx.fillStyle = '#22d3ee'
      ctx.beginPath()
      ctx.arc(liveX, liveY, 9, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#0a0a0a'
      ctx.beginPath()
      ctx.arc(liveX, liveY, 9, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Playhead (current playback position)
    if (Number.isFinite(positionMs) && positionMs! > 0) {
      const headBeat = timeline.msToBeat(positionMs!)
      const hx = beatToX(headBeat)
      if (hx >= -2 && hx <= cssW + 2) {
        ctx.strokeStyle = 'rgba(74,222,128,0.85)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.moveTo(hx, RULER_H)
        ctx.lineTo(hx, cssH)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(74,222,128,0.95)'
        ctx.font = '10px Inter, system-ui, sans-serif'
        ctx.fillText('PLAY', hx + 4, RULER_H + 4)
      }
    }

    // Rings (X axis = beat position)
    rings.forEach((r, i) => {
      const rx = beatToX(r.beat)
      if (rx < -40 || rx > cssW + 40) return
      const isSelected = i === selectedRing
      const ry = mapY(engine.waveYAt(r.beat))
      const isHold = r.type === 'hold'
      ctx.strokeStyle = isSelected ? SELECT_COLOR : 'rgba(251,191,36,0.75)'
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(rx, RULER_H)
      ctx.lineTo(rx, cssH)
      ctx.stroke()

      if (isHold && Number.isFinite(r.duration) && r.duration! > 0) {
        const tailBeat = r.beat + r.duration!
        const tx = beatToX(tailBeat)
        ctx.strokeStyle = isSelected ? SELECT_COLOR : 'rgba(251,191,36,0.6)'
        ctx.lineWidth = 8
        ctx.beginPath()
        ctx.moveTo(rx, ry)
        ctx.lineTo(tx, ry)
        ctx.stroke()
      }

      // Note marker — clear filled circle, larger when selected
      ctx.fillStyle = isSelected ? SELECT_COLOR : STAY_COLOR
      ctx.beginPath()
      ctx.arc(rx, ry, isSelected ? 12 : 9, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = isSelected ? 3 : 2
      ctx.strokeStyle = isSelected ? ACCENT_COLOR : 'rgba(0,0,0,0.55)'
      ctx.beginPath()
      ctx.arc(rx, ry, isSelected ? 12 : 9, 0, Math.PI * 2)
      ctx.stroke()
      if (isHold) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.font = '9px Inter, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText('H', rx, ry)
        ctx.textAlign = 'left'
      }
    })
  }, [segments, bpm, bpmChanges, rings, amplitude, selectedRing, positionMs, view, recording])

  const xToBeatLocal = (x: number, width: number): number => {
    const g = geoRef.current
    return g.viewStart + (x / width) * g.viewBeats
  }

  const addRingAt = (beat: number) => {
    const snapped = Math.round(beat / safeSnap) * safeSnap
    const added = onAddRing?.(snapped)
    if (added != null) onSelectRing?.(added)
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      if (dragRef.current) {
        const x = e.clientX - rect.left
        const beat = xToBeatLocal(x, rect.width)
        onMoveRing?.(dragRef.current.index, beat)
        return
      }
      if (panRef.current) {
        const dx = e.clientX - panRef.current.startX
        if (Math.abs(dx) > 3 || Math.abs(e.clientY - panRef.current.startY) > 3) {
          panRef.current.moved = true
        }
        const dxBeat = (dx / rect.width) * panRef.current.viewBeats
        onViewChange?.({
          startBeat: Math.max(0, panRef.current.startBeat - dxBeat),
          beats: panRef.current.viewBeats,
        })
      }
    }
    const onUp = (e: MouseEvent) => {
      if (panRef.current && !panRef.current.moved) {
        const canvas = canvasRef.current
        if (canvas) {
          const rect = canvas.getBoundingClientRect()
          const beat = xToBeatLocal(e.clientX, rect.width)
          addRingAt(beat)
        }
      }
      dragRef.current = null
      panRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onMoveRing, onViewChange])

  const nearestRingIndex = (clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const clickX = clientX - rect.left
    const g = geoRef.current
    let nearest = -1
    let nearestDist = Infinity
    rings.forEach((r, i) => {
      const rx = ((r.beat - g.viewStart) / g.viewBeats) * rect.width
      const d = Math.abs(rx - clickX)
      if (d < nearestDist) {
        nearestDist = d
        nearest = i
      }
    })
    return nearestDist < 35 ? nearest : -1
  }

  const handleMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const clickY = e.clientY - rect.top

    // Click on the top ruler strip seeks playback instead of placing a ring.
    if (onSeek && clickY < RULER_H) {
      const x = e.clientX - rect.left
      const beat = xToBeatLocal(x, rect.width)
      onSeek(Math.max(0, beat))
      return
    }

    const hit = nearestRingIndex(e.clientX)
    if (hit >= 0) {
      onSelectRing?.(hit)
      dragRef.current = { index: hit }
      e.preventDefault()
      return
    }
    // empty area: begin a potential pan; if no movement, treat as add on mouseup
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startBeat: geoRef.current.viewStart,
      viewBeats: geoRef.current.viewBeats,
      moved: false,
    }
    e.preventDefault()
  }

  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = nearestRingIndex(e.clientX)
    if (hit >= 0) onDeleteRing?.(hit)
  }

  const handleWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    if (!onViewChange) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const g = geoRef.current
    const bCursor = g.viewStart + (x / rect.width) * g.viewBeats
    const factor = e.deltaY < 0 ? 0.85 : 1.15
    const newBeats = Math.max(1, Math.min(200, g.viewBeats * factor))
    const newStart = bCursor - (x / rect.width) * newBeats
    onViewChange({ startBeat: Math.max(0, newStart), beats: newBeats })
  }

  return (
    <div className="wave-preview-wrap" data-testid="wave-preview">
      <canvas
        ref={canvasRef}
        className="wave-preview"
        data-testid="wave-preview-canvas"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      />
      <p className="editor-hint">
        クリックでリング追加・ドラッグで移動・ダブルクリックで削除。空白ドラッグでパン、ホイールでズーム
      </p>
    </div>
  )
}
