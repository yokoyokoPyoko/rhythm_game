import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
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

export type EditMode = 'vertex' | 'edge' | 'ring'

export interface WavePreviewProps {
  segments: Segment[]
  bpm: number
  bpmChanges?: BpmChange[]
  rings?: RingDef[]
  amplitude?: number
  startPosition?: number
  snap?: number
  selectedRing?: number | null
  selectedSegment?: number | null
  hoveredRing?: number | null
  hoveredSegment?: number | null
  positionMs?: number
  view?: WaveView
  recording?: RecordingState | null
  editMode?: EditMode
  onViewChange?: (view: WaveView) => void
  onAddRing?: (beat: number) => number | undefined
  onMoveRing?: (index: number, beat: number) => void
  onSelectRing?: (index: number | null) => void
  onSelectSegment?: (index: number | null) => void
  onHoverRing?: (index: number | null) => void
  onHoverSegment?: (index: number | null) => void
  onDeleteRing?: (index: number) => void
  onSegmentsChange?: (next: Segment[]) => void
  onSeek?: (beat: number) => void
}

export default function WavePreview({
  segments,
  bpm,
  bpmChanges = [],
  rings = [],
  amplitude = 1.0,
  startPosition = 0.0,
  snap = 0.25,
  selectedRing = null,
  selectedSegment = null,
  hoveredRing = null,
  hoveredSegment = null,
  positionMs,
  view,
  recording = null,
  editMode = 'ring',
  onViewChange,
  onAddRing,
  onMoveRing,
  onSelectRing,
  onSelectSegment,
  onHoverRing,
  onHoverSegment,
  onDeleteRing,
  onSegmentsChange,
  onSeek,
}: WavePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geoRef = useRef<{ lastBeat: number; viewStart: number; viewBeats: number }>({
    lastBeat: 4,
    viewStart: 0,
    viewBeats: 16,
  })
  const dragRef = useRef<{ index: number } | null>(null)
  const vertexDragRef = useRef<{ index: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; startBeat: number; viewBeats: number; moved: boolean } | null>(null)
  const onViewChangeRef = useRef(onViewChange)
  onViewChangeRef.current = onViewChange

  // T115: auto-scroll is driven by EditorScreen (positionMs/view) - keep view sync via geoRef
  // Native non-passive wheel listener so preventDefault() actually blocks
  // page scrolling (React's synthetic onWheel is attached as passive).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const g = geoRef.current
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const bCursor = g.viewStart + (x / rect.width) * g.viewBeats
      const factor = e.deltaY < 0 ? 0.85 : 1.15
      const newBeats = Math.max(1, Math.min(200, g.viewBeats * factor))
      const newStart = bCursor - (x / rect.width) * newBeats
      onViewChangeRef.current?.({ startBeat: Math.max(0, newStart), beats: newBeats })
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  const safeSnap = snap > 0 ? snap : 0.25

  const renderCanvas = useCallback(() => {
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

    const ampNorm = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0
    const startPosNorm = Number.isFinite(startPosition) ? Math.max(-1.0, Math.min(1.0, startPosition)) : 0.0
    const ampPx = ampNorm * 130
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges)
    const engine = new WaveEngine(segments, timeline, ampNorm, startPosNorm)

    const centerY = RULER_H + (cssH - RULER_H) / 2
    const fieldH = cssH - RULER_H
    // Expand the wave's vertical display area to use most of the available
    // field height while reflecting the chart amplitude. The displayed
    // amplitude is scaled to the chart amplitude, but clamped so it never
    // exceeds the field (leaving room for the ruler strip and not overlapping
    // SCORE/COMBO or the operation hint) and never drops below ~20% of the
    // canvas height so small amplitudes remain clearly visible.
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * cssH)
    const dispAmp = Math.min(maxAmp, Math.max(ampPx, minAmp))
    const mapY = (y: number) => centerY + ((y - GAME_CENTER_Y) / ampPx) * dispAmp

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
    for (const gy of [mapY(GAME_CENTER_Y - ampPx), centerY, mapY(GAME_CENTER_Y + ampPx)]) {
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

    // Segment color coding (up = accent, down = sub, stay = warning).
    // Vertex-direct rendering: each segment's own interval [b0, b1] is drawn by
    // connecting its endpoints (vertices) directly via lineTo — no fixed-step
    // resampling, so corners stay sharp at any zoom. Each segment is drawn only
    // within its own beat range, eliminating the previous whole-wave multi-draw.
    const drawRangeEnd = viewStart + viewBeats
    const points = engine.getPoints()
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i]
      const p1 = points[i + 1]
      const seg = segments[i]
      const isSelectedEdge = i === selectedSegment
      const isHoveredEdge = i === hoveredSegment
      const isHighlighted = isSelectedEdge || isHoveredEdge
      const color =
        seg && seg.direction === 'down'
          ? SUB_COLOR
          : seg && seg.direction === 'stay'
            ? STAY_COLOR
            : ACCENT_COLOR

      // Visible span of this segment's interval within the current view.
      const segStartB = Math.max(p0.beat, viewStart)
      const segEndB = Math.min(p1.beat, drawRangeEnd)
      if (segEndB <= segStartB) continue

      const x0 = beatToX(segStartB)
      const y0 = mapY(engine.waveYAt(segStartB))
      const x1 = beatToX(segEndB)
      const y1 = mapY(engine.waveYAt(segEndB))
      // Hover highlight: slightly thicker and brighter, selected takes precedence
      const effColor = isSelectedEdge ? SELECT_COLOR : isHoveredEdge ? 'rgba(237,237,237,0.95)' : color
      ctx.strokeStyle = effColor
      ctx.lineWidth = isSelectedEdge ? 4 : isHoveredEdge ? 3.5 : 2.5
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
      if (isHighlighted) {
        ctx.strokeStyle = isSelectedEdge ? 'rgba(237,237,237,0.25)' : 'rgba(237,237,237,0.18)'
        ctx.lineWidth = isSelectedEdge ? 10 : 8
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        ctx.stroke()
      }
    }

    if (segments.length === 0) {
      ctx.strokeStyle = ACCENT_COLOR
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(beatToX(0), mapY(GAME_CENTER_Y - ampPx))
      ctx.lineTo(beatToX(Math.max(lastBeat, viewBeats)), mapY(GAME_CENTER_Y - ampPx))
      ctx.stroke()
    }

    // Vertex handles (vertex mode) — draw circles at each wave point
    if (editMode === 'vertex' && points.length > 0) {
      points.forEach((p, idx) => {
        const vx = beatToX(p.beat)
        if (vx < -10 || vx > cssW + 10) return
        const vy = mapY(p.y)
        const isStart = p.beat === 0
        const isHoveredVertex = hoveredSegment != null && (hoveredSegment === idx || hoveredSegment === idx - 1)
        const isSelectedVertex = selectedSegment != null && (selectedSegment === idx || selectedSegment === idx - 1)
        const isHighlightedV = isSelectedVertex || isHoveredVertex
        ctx.fillStyle = isHighlightedV ? SELECT_COLOR : isStart ? 'rgba(99,102,241,0.95)' : 'rgba(237,237,237,0.95)'
        ctx.beginPath()
        ctx.arc(vx, vy, isHighlightedV ? 7 : 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = isHighlightedV ? 'rgba(237,237,237,0.9)' : 'rgba(10,10,10,0.9)'
        ctx.lineWidth = isHighlightedV ? 2.5 : 2
        ctx.beginPath()
        ctx.arc(vx, vy, isHighlightedV ? 7 : 6, 0, Math.PI * 2)
        ctx.stroke()
      })
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
      const isHovered = i === hoveredRing
      const isHighlighted = isSelected || isHovered
      const ry = mapY(engine.waveYAt(r.beat))
      const isHold = r.type === 'hold'
      ctx.strokeStyle = isHighlighted ? SELECT_COLOR : 'rgba(251,191,36,0.75)'
      ctx.lineWidth = isHighlighted ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(rx, RULER_H)
      ctx.lineTo(rx, cssH)
      ctx.stroke()

      if (isHold && Number.isFinite(r.duration) && r.duration! > 0) {
        const tailBeat = r.beat + r.duration!
        const tx = beatToX(tailBeat)
        ctx.strokeStyle = isHighlighted ? SELECT_COLOR : 'rgba(251,191,36,0.6)'
        ctx.lineWidth = 8
        ctx.beginPath()
        ctx.moveTo(rx, ry)
        ctx.lineTo(tx, ry)
        ctx.stroke()
      }

      // Note marker — clear filled circle, larger when selected/hovered (hover = 10, selected = 12)
      const rad = isSelected ? 12 : isHovered ? 10 : 9
      ctx.fillStyle = isHighlighted ? SELECT_COLOR : STAY_COLOR
      ctx.beginPath()
      ctx.arc(rx, ry, rad, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = isHighlighted ? 3 : 2
      ctx.strokeStyle = isHighlighted ? ACCENT_COLOR : 'rgba(0,0,0,0.55)'
      ctx.beginPath()
      ctx.arc(rx, ry, rad, 0, Math.PI * 2)
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
  }, [segments, bpm, bpmChanges, rings, amplitude, startPosition, selectedRing, selectedSegment, hoveredRing, hoveredSegment, positionMs, view, recording, editMode])

  // ResizeObserver guarantees the canvas intrinsic size is set after layout
  // completes (and on any container resize), so the first paint is never blank.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => renderCanvas())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [renderCanvas])

  useEffect(() => {
    renderCanvas()
  }, [renderCanvas])

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
      // Vertex drag: adjust segment beats (position) and direction (height)
      if (vertexDragRef.current && onSegmentsChange) {
        const x = e.clientX - rect.left
        let beat = xToBeatLocal(x, rect.width)
        beat = Math.round(beat / safeSnap) * safeSnap
        const ampNorm = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges)
        const engineTmp = new WaveEngine(segments, timeline, ampNorm, startPosition)
        const pts = engineTmp.getPoints()
        const idx = vertexDragRef.current.index
        if (idx <= 0 || idx >= pts.length - 1) {
          // last vertex or single point: adjust last segment beats only
          if (segments.length > 0 && idx === pts.length - 1) {
            const prevBeat = pts[idx - 1]?.beat ?? 0
            const newBeats = Math.max(safeSnap, Number((beat - prevBeat).toFixed(4)))
            const next = segments.map((s, i) => (i === segments.length - 1 ? { ...s, beats: newBeats } : s))
            onSegmentsChange(next)
          }
          return
        }
        const prevBeat = pts[idx - 1].beat
        const nextBeat = pts[idx + 1].beat
        const clamped = Math.max(prevBeat + safeSnap, Math.min(nextBeat - safeSnap, beat))
        const newBeatsPrev = Number((clamped - prevBeat).toFixed(4))
        const newBeatsNext = Number((nextBeat - clamped).toFixed(4))
        if (newBeatsPrev < safeSnap - 1e-9 || newBeatsNext < safeSnap - 1e-9) return
        // height micro-adjust: infer direction from vertical delta
        const centerY = RULER_H + (rect.height - RULER_H) / 2
        const fieldH = rect.height - RULER_H
        const ampPx = ampNorm * 130
        const maxAmp = (fieldH - 24) / 2
        const minAmp = Math.max(8, 0.2 * rect.height)
        const dispAmp = Math.min(maxAmp, Math.max(ampPx, minAmp))
        const y = e.clientY - rect.top
        const gameY = GAME_CENTER_Y + ((y - centerY) / dispAmp) * ampPx
        const prevY = pts[idx - 1].y
        const delta = gameY - prevY
        const thresh = 10
        let newDir: 'up' | 'down' | 'stay' = segments[idx - 1].direction
        if (delta < -thresh) newDir = 'up'
        else if (delta > thresh) newDir = 'down'
        else if (Math.abs(delta) < thresh * 0.6) newDir = 'stay'
        const nextSegs = segments.map((s, i) => {
          if (i === idx - 1) return { ...s, beats: newBeatsPrev, direction: newDir }
          if (i === idx) return { ...s, beats: newBeatsNext }
          return s
        })
        onSegmentsChange(nextSegs)
        return
      }
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
      if (vertexDragRef.current) {
        vertexDragRef.current = null
        return
      }
      if (dragRef.current) {
        dragRef.current = null
        return
      }
      if (panRef.current && !panRef.current.moved) {
        const canvas = canvasRef.current
        if (canvas) {
          const rect = canvas.getBoundingClientRect()
          const beat = xToBeatLocal(e.clientX - rect.left, rect.width)
          // Ring mode only: click on empty area adds ring; other modes do not
          if (editMode === 'ring') {
            addRingAt(beat)
          }
        }
      }
      panRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onMoveRing, onViewChange, editMode, segments, bpm, bpmChanges, amplitude, startPosition, onSegmentsChange, safeSnap])

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

  const nearestVertexIndex = (clientX: number, clientY: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const g = geoRef.current
    const ampNorm = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0
    const ampPx = ampNorm * 130
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges)
    const engine = new WaveEngine(segments, timeline, ampNorm, startPosition)
    const pts = engine.getPoints()
    const centerY = RULER_H + (rect.height - RULER_H) / 2
    const fieldH = rect.height - RULER_H
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * rect.height)
    const dispAmp = Math.min(maxAmp, Math.max(ampPx, minAmp))
    const mapY = (y: number) => centerY + ((y - GAME_CENTER_Y) / ampPx) * dispAmp
    const clickX = clientX - rect.left
    const clickY = clientY - rect.top
    let nearest = -1
    let nearestDist = Infinity
    pts.forEach((p, i) => {
      const vx = ((p.beat - g.viewStart) / g.viewBeats) * rect.width
      const vy = mapY(p.y)
      const d = Math.hypot(vx - clickX, vy - clickY)
      if (d < nearestDist) {
        nearestDist = d
        nearest = i
      }
    })
    return nearestDist < 14 ? nearest : -1
  }

  const nearestEdgeIndex = (clientX: number, clientY: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const g = geoRef.current
    const ampNorm = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0
    const ampPx = ampNorm * 130
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges)
    const engine = new WaveEngine(segments, timeline, ampNorm, startPosition)
    const pts = engine.getPoints()
    const centerY = RULER_H + (rect.height - RULER_H) / 2
    const fieldH = rect.height - RULER_H
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * rect.height)
    const dispAmp = Math.min(maxAmp, Math.max(ampPx, minAmp))
    const mapY = (y: number) => centerY + ((y - GAME_CENTER_Y) / ampPx) * dispAmp
    const beat = xToBeatLocal(clientX - rect.left, rect.width)
    const clickY = clientY - rect.top
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]
      const p1 = pts[i + 1]
      if (beat < p0.beat - 0.05 || beat > p1.beat + 0.05) continue
      const x0 = ((p0.beat - g.viewStart) / g.viewBeats) * rect.width
      const x1 = ((p1.beat - g.viewStart) / g.viewBeats) * rect.width
      const y0 = mapY(p0.y)
      const y1 = mapY(p1.y)
      // distance from point to segment
      const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2
      if (len2 < 1e-6) continue
      const t = Math.max(0, Math.min(1, ((clientX - rect.left - x0) * (x1 - x0) + (clickY - y0) * (y1 - y0)) / len2))
      const projX = x0 + t * (x1 - x0)
      const projY = y0 + t * (y1 - y0)
      const d = Math.hypot(clientX - rect.left - projX, clickY - projY)
      if (d < 16) return i
    }
    return -1
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

    // Mode-specific hit testing — complete separation per T116
    if (editMode === 'vertex') {
      const vHit = nearestVertexIndex(e.clientX, e.clientY)
      if (vHit >= 0) {
        vertexDragRef.current = { index: vHit }
        e.preventDefault()
        return
      }
      // vertex mode: empty drag = pan (no ring creation)
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startBeat: geoRef.current.viewStart,
        viewBeats: geoRef.current.viewBeats,
        moved: false,
      }
      e.preventDefault()
      return
    }

    if (editMode === 'edge') {
      const eHit = nearestEdgeIndex(e.clientX, e.clientY)
      if (eHit >= 0) {
        onSelectSegment?.(eHit)
        e.preventDefault()
        return
      }
      // click empty in edge mode clears selection and pans
      onSelectSegment?.(null)
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startBeat: geoRef.current.viewStart,
        viewBeats: geoRef.current.viewBeats,
        moved: false,
      }
      e.preventDefault()
      return
    }

    // ring mode: isolated layer for add/drag/delete
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
    if (editMode !== 'ring') return
    const hit = nearestRingIndex(e.clientX)
    if (hit >= 0) onDeleteRing?.(hit)
  }

  const handleMouseMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current || vertexDragRef.current || panRef.current) return
    // Hover interlink: detect nearest ring/edge/vertex under cursor and notify parent for list highlight
    const ringHit = nearestRingIndex(e.clientX)
    if (ringHit >= 0) {
      onHoverRing?.(ringHit)
      onHoverSegment?.(null)
      return
    }
    if (editMode === 'vertex') {
      const vHit = nearestVertexIndex(e.clientX, e.clientY)
      if (vHit >= 0) {
        // vertex idx maps to adjacent segment; highlight that segment
        const segIdx = vHit === 0 ? 0 : vHit - 1
        if (segIdx >= 0 && segIdx < segments.length) {
          onHoverSegment?.(segIdx)
          onHoverRing?.(null)
          return
        }
      }
    } else if (editMode === 'edge') {
      const eHit = nearestEdgeIndex(e.clientX, e.clientY)
      if (eHit >= 0) {
        onHoverSegment?.(eHit)
        onHoverRing?.(null)
        return
      }
    } else {
      // ring mode: no segment hover
      const eHit = nearestEdgeIndex(e.clientX, e.clientY)
      if (eHit >= 0) {
        onHoverSegment?.(eHit)
        onHoverRing?.(null)
        return
      }
    }
    onHoverRing?.(null)
    onHoverSegment?.(null)
  }

  const handleMouseLeave = () => {
    onHoverRing?.(null)
    onHoverSegment?.(null)
  }

  return (
    <div className="wave-preview-wrap" data-testid="wave-preview">
      <canvas
        ref={canvasRef}
        className="wave-preview"
        data-testid="wave-preview-canvas"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      <p className="editor-hint" data-testid="wave-preview-hint">
        {editMode === 'vertex' && '頂点モード: 頂点をドラッグで位置・高さを微調整。空白ドラッグでパン、ホイールでズーム'}
        {editMode === 'edge' && '辺モード: 辺をクリックで一括選択・プロパティ変更。空白ドラッグでパン、ホイールでズーム'}
        {editMode === 'ring' && 'リングモード: クリックで追加・ドラッグで移動・ダブルクリックで削除。空白ドラッグでパン、ホイールでズーム'}
      </p>
    </div>
  )
}
