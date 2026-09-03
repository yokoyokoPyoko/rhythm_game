import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { quantizeBeat } from '../../chart/quantize'
import { TW_CENTER_Y, TW_AMP, WaveEngine } from '../../game/waveEngine'
import type { BpmChange, RingDef, Segment } from '../../types'

const RULER_H = 22
const ACCENT_COLOR = '#6366f1'
const SUB_COLOR = '#22d3ee'
const STAY_COLOR = '#fbbf24'
const SELECT_COLOR = '#ededed'
// T131: the preview is list-driven by bpm_changes[].amplitude. It renders with a
// fixed base amplitude (matching the editor) so editing the main #amplitude input
// does not immediately change the wave.
const EDITOR_BASE_AMP = 1.0

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
  const edgeDragRef = useRef<{ index: number; startBeat: number; startPrevBeat: number; startNextBeat: number } | null>(null)
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

    const startPosNorm = Number.isFinite(startPosition) ? Math.max(-1.0, Math.min(1.0, startPosition)) : 0.0
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
    const engine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosNorm)

    const centerY = RULER_H + (cssH - RULER_H) / 2
    const fieldH = cssH - RULER_H
    // T123: physical height fixed at TW_AMP; amplitude only affects slope, not display scale.
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * cssH)
    const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
    const mapY = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp

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

    // Horizontal guide lines: top / center / bottom (high visibility) - fixed TW_AMP
    ctx.lineWidth = 1
    for (const gy of [mapY(TW_CENTER_Y - TW_AMP), centerY, mapY(TW_CENTER_Y + TW_AMP)]) {
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

    // T128: Segment drawing via waveYAt-sampled polyline (climb + clamp).
    // Instead of single lineTo between clamped endpoints, sample waveYAt at fine
    // intervals to correctly show the steep climb and flat stay after boundary.
    const drawRangeEnd = viewStart + viewBeats
    const points = engine.getPoints()
    const SAMPLE_STEP = 0.125 // beats between samples; fine enough for smooth polyline
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

      const effColor = isSelectedEdge ? SELECT_COLOR : isHoveredEdge ? 'rgba(237,237,237,0.95)' : color
      ctx.strokeStyle = effColor
      ctx.lineWidth = isSelectedEdge ? 4 : isHoveredEdge ? 3.5 : 2.5
      ctx.beginPath()
      // Sample waveYAt at fine intervals to capture climb + flat stay
      let first = true
      for (let b = segStartB; b <= segEndB + 1e-9; b += SAMPLE_STEP) {
        const bx = beatToX(b)
        const by = mapY(engine.waveYAt(b))
        if (first) {
          ctx.moveTo(bx, by)
          first = false
        } else {
          ctx.lineTo(bx, by)
        }
      }
      // Ensure the end point is exact
      const endX = beatToX(segEndB)
      const endY = mapY(engine.waveYAt(segEndB))
      if (!first) ctx.lineTo(endX, endY)
      ctx.stroke()
      if (isHighlighted) {
        ctx.strokeStyle = isSelectedEdge ? 'rgba(237,237,237,0.25)' : 'rgba(237,237,237,0.18)'
        ctx.lineWidth = isSelectedEdge ? 10 : 8
        ctx.beginPath()
        first = true
        for (let b = segStartB; b <= segEndB + 1e-9; b += SAMPLE_STEP) {
          const bx = beatToX(b)
          const by = mapY(engine.waveYAt(b))
          if (first) {
            ctx.moveTo(bx, by)
            first = false
          } else {
            ctx.lineTo(bx, by)
          }
        }
        if (!first) ctx.lineTo(endX, endY)
        ctx.stroke()
      }
    }

    if (segments.length === 0) {
      ctx.strokeStyle = ACCENT_COLOR
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(beatToX(0), mapY(TW_CENTER_Y - TW_AMP))
      ctx.lineTo(beatToX(Math.max(lastBeat, viewBeats)), mapY(TW_CENTER_Y - TW_AMP))
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
      // T139: Vertex drag — free X/Y movement, adjusting up to 2 adjacent segments.
      // Y is free (not constrained by previous direction); direction and beats of
      // adjacent segments are recalculated to match the new vertex position.
      if (vertexDragRef.current && onSegmentsChange) {
        const x = e.clientX - rect.left
        const rectH = rect.height
        const fieldH = rectH - RULER_H
        let beat = xToBeatLocal(x, rect.width)
        beat = quantizeBeat(beat, safeSnap)
        const yRaw = ((e.clientY - rect.top - RULER_H) / fieldH - 0.5) * 2
        let newY = TW_CENTER_Y + yRaw * TW_AMP
        newY = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, newY))
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
        const engineTmp = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
        const pts = engineTmp.getPoints()
        const idx = vertexDragRef.current.index
        const last = pts.length - 1

        if (segments.length === 0) return

        // --- Endpoint cases: only adjust the single adjacent segment ---
        if (idx === 0 && segments.length > 0) {
          const nextBeat = pts[1]?.beat ?? pts[0].beat + safeSnap
          const clampedBeat = Math.min(nextBeat - safeSnap, beat)
          const segBeats = Math.max(safeSnap, quantizeBeat(clampedBeat - 0, safeSnap))
          const dir = newY < TW_CENTER_Y - 1 ? 'up' : newY > TW_CENTER_Y + 1 ? 'down' : segments[0].direction
          const next = segments.map((s, i) => (i === 0 ? { ...s, beats: segBeats, direction: dir } : s))
          onSegmentsChange(next)
          return
        }
        if (idx === last && segments.length > 0) {
          const prevBeat = pts[idx - 1]?.beat ?? 0
          const segBeats = Math.max(safeSnap, quantizeBeat(beat - prevBeat, safeSnap))
          const next = segments.map((s, i) => (i === idx - 1 ? { ...s, beats: segBeats } : s))
          onSegmentsChange(next)
          return
        }

        // --- Interior vertex: adjust 2 adjacent segments (idx-1 and idx) ---
        const prevBeat = pts[idx - 1].beat
        const nextBeat = pts[idx + 1].beat
        const clampedBeat = Math.max(prevBeat + safeSnap, Math.min(nextBeat - safeSnap, beat))

        // Per-beat pixel displacement at each segment's start beat (T131 list-driven)
        const perBeatPrev = 2 * TW_AMP * timeline.amplitudeAt(prevBeat)
        const perBeatNext = 2 * TW_AMP * timeline.amplitudeAt(clampedBeat)

        // Calculate direction and beats for both adjacent segments
        const deltaPrev = newY - pts[idx - 1].y
        let dirPrev: 'up' | 'down' | 'stay'
        let beatsPrev: number
        const prevAtTop = pts[idx - 1].y <= (TW_CENTER_Y - TW_AMP) + 1
        const prevAtBottom = pts[idx - 1].y >= (TW_CENTER_Y + TW_AMP) - 1
        if (Math.abs(deltaPrev) < 0.5) {
          dirPrev = 'stay'
          beatsPrev = safeSnap
        } else if (prevAtTop && deltaPrev > 0) {
          dirPrev = 'down'
          beatsPrev = Math.max(safeSnap, quantizeBeat(Math.abs(deltaPrev) / perBeatPrev, safeSnap))
        } else if (prevAtBottom && deltaPrev < 0) {
          dirPrev = 'up'
          beatsPrev = Math.max(safeSnap, quantizeBeat(Math.abs(deltaPrev) / perBeatPrev, safeSnap))
        } else {
          dirPrev = deltaPrev < 0 ? 'up' : 'down'
          beatsPrev = Math.max(safeSnap, quantizeBeat(Math.abs(deltaPrev) / perBeatPrev, safeSnap))
        }

        const deltaNext = pts[idx + 1].y - newY
        let dirNext: 'up' | 'down' | 'stay'
        let beatsNext: number
        const nextAtTop = pts[idx + 1].y <= (TW_CENTER_Y - TW_AMP) + 1
        const nextAtBottom = pts[idx + 1].y >= (TW_CENTER_Y + TW_AMP) - 1
        if (Math.abs(deltaNext) < 0.5) {
          dirNext = 'stay'
          beatsNext = safeSnap
        } else if (nextAtTop && deltaNext < 0) {
          dirNext = 'up'
          beatsNext = Math.max(safeSnap, quantizeBeat(Math.abs(deltaNext) / perBeatNext, safeSnap))
        } else if (nextAtBottom && deltaNext > 0) {
          dirNext = 'down'
          beatsNext = Math.max(safeSnap, quantizeBeat(Math.abs(deltaNext) / perBeatNext, safeSnap))
        } else {
          dirNext = deltaNext < 0 ? 'up' : 'down'
          beatsNext = Math.max(safeSnap, quantizeBeat(Math.abs(deltaNext) / perBeatNext, safeSnap))
        }

        // Build candidate segments: only seg idx-1 and seg idx change
        const candidateSegs = segments.map((s, i) => {
          if (i === idx - 1) return { ...s, beats: beatsPrev, direction: dirPrev }
          if (i === idx) return { ...s, beats: beatsNext, direction: dirNext }
          return s
        })

        onSegmentsChange(candidateSegs)
        return
      }
      if (edgeDragRef.current && onSegmentsChange) {
        const x = e.clientX - rect.left
        const rectH = rect.height
        const fieldH = rectH - RULER_H
        const drag = edgeDragRef.current
        const idx = drag.index

        // Horizontal delta in beats (quantized to safeSnap)
        const beatRaw = xToBeatLocal(x, rect.width)
        const dxBeat = beatRaw - drag.startBeat
        const dxSnap = quantizeBeat(dxBeat, safeSnap)

        // Vertical delta in field pixels, then converted to TW_AMP px
        const yRaw = ((e.clientY - rect.top - RULER_H) / fieldH - 0.5) * 2
        const yNow = TW_CENTER_Y + yRaw * TW_AMP
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
        const engineTmp = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
        const pts = engineTmp.getPoints()
        if (segments.length === 0) return

        const dyRaw = yNow - pts[idx].y
        const dy = Math.max(TW_CENTER_Y - TW_AMP - pts[idx].y, Math.min(TW_CENTER_Y + TW_AMP - pts[idx].y, dyRaw))

        // New translated positions for both edge endpoints
        const beatI = pts[idx].beat + dxSnap
        const beatI1 = pts[idx + 1].beat + dxSnap
        const clampBeat = Math.max(0, beatI)
        let yI = pts[idx].y + dy
        let yI1 = pts[idx + 1].y + dy
        yI = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, yI))
        yI1 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, yI1))

        // per-beat pixel displacement (T131 list-driven) at each start beat
        const perBeat = (b: number) => 2 * TW_AMP * timeline.amplitudeAt(b)

        // Helper to compute beats/dir for a segment between two points
        const segmentFor = (fromBeat: number, fromY: number, toY: number): Segment => {
          const delta = toY - fromY
          if (Math.abs(delta) < 0.5) return { direction: 'stay', beats: safeSnap }
          const rawBeat = Math.max(safeSnap, Math.abs(delta) / perBeat(fromBeat))
          const beats = Math.max(safeSnap, quantizeBeat(rawBeat, safeSnap))
          const dir: 'up' | 'down' | 'stay' = delta < 0 ? 'up' : 'down'
          return { direction: dir, beats }
        }

        const candidateSegs = segments.map((s, i) => {
          // seg i-1: p_{i-1} -> p_i'
          if (i === idx - 1 && i >= 0) {
            const pPrev = pts[idx - 1]
            return segmentFor(pPrev.beat, pPrev.y, yI)
          }
          // seg i: edge itself — translated by parallel shift; beat length preserved
          if (i === idx) {
            const origLen = pts[idx + 1].beat - pts[idx].beat
            const dyPx = Math.abs(yI1 - yI)
            // Horizontal priority (dx dominant): edge keeps its translated horizontal span
            const dxDominant = Math.abs(dxSnap) > Math.abs(dyPx / perBeat(clampBeat))
            let beatsI: number
            if (dxDominant) {
              beatsI = Math.max(safeSnap, quantizeBeat(origLen, safeSnap))
            } else {
              beatsI = Math.max(safeSnap, quantizeBeat(dyPx / perBeat(clampBeat), safeSnap))
            }
            const dir: 'up' | 'down' | 'stay' = dyPx < 0.5 ? 'stay' : yI1 < yI ? 'up' : 'down'
            return { direction: dir, beats: beatsI }
          }
          // seg i+1: p_{i+1}' -> p_{i+2}
          if (i === idx + 1 && i + 1 < pts.length) {
            const pAfter = pts[idx + 2]
            if (!pAfter) return s
            return segmentFor(beatI1, yI1, pAfter.y)
          }
          return s
        })

        onSegmentsChange(candidateSegs)
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
      if (edgeDragRef.current) {
        edgeDragRef.current = null
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
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
    const engine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
    const pts = engine.getPoints()
    const centerY = RULER_H + (rect.height - RULER_H) / 2
    const fieldH = rect.height - RULER_H
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * rect.height)
    const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
    const mapY = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp
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
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
    const engine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
    const pts = engine.getPoints()
    const centerY = RULER_H + (rect.height - RULER_H) / 2
    const fieldH = rect.height - RULER_H
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * rect.height)
    const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
    const mapY = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp
    const clickX = clientX - rect.left
    const clickY = clientY - rect.top
    // T128: use waveYAt-sampled polyline to match the visual rendering.
    const SAMPLE_STEP = 0.125
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]
      const p1 = pts[i + 1]
      if (clickX < ((p0.beat - g.viewStart) / g.viewBeats) * rect.width - 20) continue
      if (clickX > ((p1.beat - g.viewStart) / g.viewBeats) * rect.width + 20) continue
      // Sample polyline within this segment and check distance to each sub-segment
      const segStartB = p0.beat
      const segEndB = p1.beat
      let prevX = ((segStartB - g.viewStart) / g.viewBeats) * rect.width
      let prevY = mapY(engine.waveYAt(segStartB))
      for (let b = segStartB + SAMPLE_STEP; b <= segEndB + 1e-9; b += SAMPLE_STEP) {
        const bx = ((Math.min(b, segEndB) - g.viewStart) / g.viewBeats) * rect.width
        const by = mapY(engine.waveYAt(Math.min(b, segEndB)))
        const len2 = (bx - prevX) ** 2 + (by - prevY) ** 2
        if (len2 >= 1e-6) {
          const t = Math.max(0, Math.min(1, ((clickX - prevX) * (bx - prevX) + (clickY - prevY) * (by - prevY)) / len2))
          const projX = prevX + t * (bx - prevX)
          const projY = prevY + t * (by - prevY)
          const d = Math.hypot(clickX - projX, clickY - projY)
          if (d < 16) return i
        }
        prevX = bx
        prevY = by
      }
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
        // T140: begin edge drag — record translation baseline for the segment
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
        const engineTmp = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
        const pts = engineTmp.getPoints()
        const startPrevBeat = eHit > 0 ? pts[eHit - 1].beat : 0
        const startNextBeat = eHit + 1 < pts.length ? pts[eHit + 1].beat : pts[pts.length - 1]?.beat ?? 0
        edgeDragRef.current = {
          index: eHit,
          startBeat: pts[eHit].beat,
          startPrevBeat,
          startNextBeat,
        }
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
    if (dragRef.current || vertexDragRef.current || edgeDragRef.current || panRef.current) return
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
        {editMode === 'edge' && '辺モード: 辺をドラッグで左右上下に移動・選択。空白ドラッグでパン、ホイールでズーム'}
        {editMode === 'ring' && 'リングモード: クリックで追加・ドラッグで移動・ダブルクリックで削除。空白ドラッグでパン、ホイールでズーム'}
      </p>
    </div>
  )
}
