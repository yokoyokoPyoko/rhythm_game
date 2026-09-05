import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { quantizeBeat } from '../../chart/quantize'
import { calculateVertexDrag, calculateEdgeDrag } from '../../game/editorDrag'
import { TW_CENTER_Y, TW_AMP, WaveEngine } from '../../game/waveEngine'
import type { BpmChange, RingDef, Segment } from '../../types'

export function computeVertexDrag(input: any) {
  return calculateVertexDrag(input)
}
export function computeEdgeDrag(input: any) {
  return calculateEdgeDrag(input)
}

const RULER_H = 22
const ACCENT_COLOR = '#6366f1'
const SUB_COLOR = '#22d3ee'
const STAY_COLOR = '#fbbf24'
const SELECT_COLOR = '#ededed'
// T154: Y-snapping zones (matching editorDrag.ts)
const ZONE_MID_START = 256.7
const ZONE_MID_END = 343.3
const TOP_Y = TW_CENTER_Y - TW_AMP
const CENTER_Y = TW_CENTER_Y
const BOTTOM_Y = TW_CENTER_Y + TW_AMP
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
  selectedRings?: number[]
  selectedSegments?: number[]
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
  onSelectRings?: (indices: number[]) => void
  onSelectSegments?: (indices: number[]) => void
  onMultiMoveRings?: (moves: { index: number; beat: number }[]) => void
  onMultiMoveSegments?: (next: Segment[]) => void
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
  selectedRings = [],
  selectedSegments = [],
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
  onSelectRings,
  onSelectSegments,
  onMultiMoveRings,
  onMultiMoveSegments,
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
  const edgeDragRef = useRef<{ index: number; startBeat: number; startPrevBeat: number; startNextBeat: number; startY: number } | null>(null)
  // T154: vertex creation drag (empty mousedown → drag → mouseup commits new vertex)
  const vertexCreateRef = useRef<{ anchorSeg: number; anchorBeat: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; startBeat: number; viewBeats: number; moved: boolean } | null>(null)
  // T156: rubber band selection (right-drag)
  const rubberRef = useRef<{ startBeat: number; startX: number; startY: number; mode: EditMode } | null>(null)
  const rubberDraggedRef = useRef(false)
  const [rubberRect, setRubberRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // T156: multi-item drag (left-drag on selected items)
  const multiDragRef = useRef<{ startBeat: number; startY: number; origRingBeats?: number[]; origSegIndices?: number[] } | null>(null)
  const [multiDragSegments, setMultiDragSegments] = useState<Segment[] | null>(null)
  const [ringDragOffset, setRingDragOffset] = useState(0)
  const onViewChangeRef = useRef(onViewChange)
  onViewChangeRef.current = onViewChange

  // T150: vertex/edge drags render a local preview only. mousemove updates
  // dragPreview (no onSegmentsChange); mouseup commits once. This avoids the
  // old direct-commit that caused edge drags to diverge/accumulate.
  const [dragPreview, setDragPreview] = useState<Segment[] | null>(null)
  const dragPreviewRef = useRef<Segment[] | null>(null)

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

  // T156: coordinate helpers (defined before renderCanvas)
  const geo = geoRef.current
  const beatToXLocal = (b: number, w: number) => ((b - geo.viewStart) / geo.viewBeats) * w
  const xToBeatLocal = (x: number, width: number): number => {
    const g = geoRef.current
    return g.viewStart + (x / width) * g.viewBeats
  }

  // T156: compute multi-drag preview segments from original segments + selectedIndices + offset.
  // Supports 左右上下 (horizontal + vertical): each selected segment shifts by dxBeat
  // (clamped to >= safeSnap, snap-quantized) and, when the mouse moves across a Y zone,
  // re-points its direction toward the drag zone (up/down). Unit moves stay idempotent
  // (no direction change when dy stays inside the same third of the wave band).
  const computeMultiDragSegs = (origSegs: Segment[], selSegIdxs: number[], dxBeat: number, dy: number): Segment[] => {
    if (selSegIdxs.length === 0) return null as unknown as Segment[]
    const result = origSegs.map((s) => ({ ...s }))
    const selectedSet = new Set(selSegIdxs)
    const dx = quantizeBeat(dxBeat, safeSnap)
    // 3-zone vertical move: -1 = up, +1 = down, 0 = stay inside current zone.
    const moveZone = dy < -0.5 ? -1 : dy > 0.5 ? 1 : 0
    for (let i = 0; i < result.length; i++) {
      if (!selectedSet.has(i)) continue
      const base = result[i]
      result[i] = {
        ...base,
        beats: Math.max(safeSnap, quantizeBeat(base.beats + dx, safeSnap)),
        direction: moveZone !== 0 ? (moveZone < 0 ? ('up' as const) : ('down' as const)) : base.direction,
      }
    }
    return result
  }

  // T156: find items inside a rubber band rectangle
  const findItemsInRect = (
    x0: number, y0: number, x1: number, y1: number,
    rectW: number, rectH: number,
  ): { rings: number[]; segs: number[] } => {
    const minX = Math.min(x0, x1)
    const maxX = Math.max(x0, x1)
    const minY = Math.min(y0, y1)
    const maxY = Math.max(y0, y1)
    const minBX = minX / rectW * geo.viewBeats + geo.viewStart
    const maxBX = maxX / rectW * geo.viewBeats + geo.viewStart
    const foundRings: number[] = []
    const foundSegs: number[] = []
    if (editMode === 'ring') {
      rings.forEach((r, i) => {
        const rx = beatToXLocal(r.beat, rectW)
        if (rx >= minX - 35 && rx <= maxX + 35) foundRings.push(i)
      })
    } else {
      const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
      const engine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
      const fieldH = rectH - RULER_H
      const centerY = RULER_H + fieldH / 2
      const maxAmp = (fieldH - 24) / 2
      const minAmpV = Math.max(8, 0.2 * rectH)
      const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmpV))
      const mapYLocal = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp
      const SAMPLE_STEP = 0.25
      for (let i = 0; i < segments.length; i++) {
        const segStart = segments.slice(0, i).reduce((s, seg) => s + seg.beats, 0)
        const segEnd = segStart + segments[i].beats
        if (segEnd < minBX || segStart > maxBX) continue
        if (editMode === 'vertex') {
          const vPt = engine.getPoints()[i]
          if (!vPt) continue
          const vx = beatToXLocal(vPt.beat, rectW)
          const vy = mapYLocal(vPt.y)
          if (vx >= minX - 14 && vx <= maxX + 14 && vy >= minY - 14 && vy <= maxY + 14) foundSegs.push(i)
        } else {
          let hit = false
          for (let b = Math.max(segStart, minBX); b <= Math.min(segEnd, maxBX) + 1e-9 && !hit; b += SAMPLE_STEP) {
            const bx = beatToXLocal(Math.min(b, segEnd), rectW)
            const by = mapYLocal(engine.waveYAt(Math.min(b, segEnd)))
            if (bx >= minX - 16 && bx <= maxX + 16 && by >= minY - 16 && by <= maxY + 16) { hit = true; foundSegs.push(i) }
          }
        }
      }
    }
    return { rings: foundRings, segs: foundSegs }
  }

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
    // T150: while a vertex/edge drag is in flight, render the local preview wave
    // instead of the committed segments; rings follow the preview engine too.
    const renderSegs = multiDragSegments ?? dragPreview ?? segments
    const engine = new WaveEngine(renderSegs, timeline, EDITOR_BASE_AMP, startPosNorm)

    const centerY = RULER_H + (cssH - RULER_H) / 2
    const fieldH = cssH - RULER_H
    // T123: physical height fixed at TW_AMP; amplitude only affects slope, not display scale.
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * cssH)
    const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
    const mapY = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp

    const totalBeats = renderSegs.reduce((sum, seg) => sum + seg.beats, 0)
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
    const minorStep =
      viewBeats <= 4  ? 0.25 :
      viewBeats <= 8  ? 0.5  :
      viewBeats <= 16 ? 1    :
      viewBeats <= 64 ? 2    :
                         4
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
        ctx.fillText(String(Math.round(b / 4)), gx + 4, 4)
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
      const seg = renderSegs[i]
      const isSelectedEdge = editMode !== 'ring' && (selectedSegments.includes(i) || i === selectedSegment)
      const isHoveredEdge = editMode !== 'ring' && i === hoveredSegment
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

    if (renderSegs.length === 0) {
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
        const isSelectedVertex = (selectedSegments.includes(idx) || selectedSegments.includes(idx - 1)) || (selectedSegment != null && (selectedSegment === idx || selectedSegment === idx - 1))
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

    // Rings (X axis = beat position). During a vertex/edge drag, ring Y is derived
    // from the preview wave (dragPreview ?? segments) so rings follow the drag.
    rings.forEach((r, i) => {
      // T156: apply ringDragOffset to selected rings during multi-drag
      const beatOff = selectedRings.includes(i) ? ringDragOffset : 0
      const rx = beatToX(r.beat + beatOff)
      if (rx < -40 || rx > cssW + 40) return
      const isSelected = editMode === 'ring' && (selectedRings.includes(i) || i === selectedRing)
      const isHovered = editMode === 'ring' && i === hoveredRing
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

    // T156: rubber band selection rectangle (dashed)
    if (rubberRect) {
      ctx.strokeStyle = 'rgba(99,102,241,0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.rect(rubberRect.x, rubberRect.y, rubberRect.w, rubberRect.h)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(99,102,241,0.1)'
      ctx.beginPath()
      ctx.rect(rubberRect.x, rubberRect.y, rubberRect.w, rubberRect.h)
      ctx.fill()
    }
  }, [segments, dragPreview, multiDragSegments, bpm, bpmChanges, rings, amplitude, startPosition, selectedRing, selectedSegment, selectedRings, selectedSegments, hoveredRing, hoveredSegment, positionMs, view, recording, editMode, ringDragOffset, rubberRect])

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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      // T156: rubber band selection (right-drag) — draw rect only, no state change
      if (rubberRef.current) {
        const x = Math.min(rubberRef.current.startX, e.clientX - rect.left)
        const y = Math.min(rubberRef.current.startY, e.clientY - rect.top)
        const w = Math.abs(e.clientX - rect.left - rubberRef.current.startX)
        const h = Math.abs(e.clientY - rect.top - rubberRef.current.startY)
        setRubberRect({ x, y, w, h })
        return
      }
      // T156: multi-selection drag (left-drag on selected items) — preview only
      if (multiDragRef.current) {
        const x = e.clientX - rect.left
        const dxBeat = quantizeBeat(xToBeatLocal(x, rect.width) - multiDragRef.current.startBeat, safeSnap)
        if (editMode === 'ring') {
          setRingDragOffset(dxBeat)
        } else if (multiDragRef.current.origSegIndices) {
          // Vertical component via the same dispAmp-based inverse mapping used by
          // vertex/edge drags, so preview Y follows the mouse inside the wave band.
          const fieldH = rect.height - RULER_H
          const centerY = RULER_H + fieldH / 2
          const maxAmpV = (fieldH - 24) / 2
          const minAmpV = Math.max(8, 0.2 * rect.height)
          const dispAmpV = Math.min(maxAmpV, Math.max(TW_AMP, minAmpV))
          const mapYInverseV = (mouseY: number) => TW_CENTER_Y + ((mouseY - centerY) / dispAmpV) * TW_AMP
          const dy = mapYInverseV(e.clientY - rect.top) - multiDragRef.current.startY
          const preview = computeMultiDragSegs(segments, multiDragRef.current.origSegIndices, dxBeat, dy)
          setMultiDragSegments(preview)
        }
        return
      }
      if (vertexDragRef.current) {
        const x = e.clientX - rect.left
        const fieldH = rect.height - RULER_H
        const beat = quantizeBeat(xToBeatLocal(x, rect.width), safeSnap)
        const centerY = RULER_H + fieldH / 2
        // T149: unified Y inverse mapping (dispAmp based) via mapYInverse.
        const maxAmp = (fieldH - 24) / 2
        const minAmp = Math.max(8, 0.2 * rect.height)
        const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
        const mapYInverse = (mouseY: number) => TW_CENTER_Y + ((mouseY - centerY) / dispAmp) * TW_AMP
        const yPrime = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, mapYInverse(e.clientY - rect.top)))
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)

        if (segments.length === 0) {
          dragPreviewRef.current = null
          setDragPreview(null)
          return
        }

        // T150: boundary留め clamp for vertex preview — keep neighbors at least snap wide.
        const tmpEngine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
        const tmpPts = tmpEngine.getPoints()
        const idx = vertexDragRef.current.index
        const prevBeat = idx > 0 ? tmpPts[idx - 1].beat : 0
        const nextBeat = idx < tmpPts.length - 1 ? tmpPts[idx + 1].beat : tmpPts[tmpPts.length - 1]?.beat ?? beat + safeSnap
        const clampedBeat = Math.max(prevBeat + safeSnap, Math.min(nextBeat - safeSnap, beat))

        const result = calculateVertexDrag({
          segments,
          bpmTimeline: timeline,
          startPosition,
          pointIndex: idx,
          targetBeat: clampedBeat,
          targetY: yPrime,
          snap: safeSnap,
        })
        dragPreviewRef.current = result
        setDragPreview(result)
        return
      }
      if (vertexCreateRef.current && onSegmentsChange) {
        const x = e.clientX - rect.left
        const fieldH = rect.height - RULER_H
        const beat = xToBeatLocal(x, rect.width)
        const centerY = RULER_H + fieldH / 2
        const maxAmp = (fieldH - 24) / 2
        const minAmp = Math.max(8, 0.2 * rect.height)
        const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
        const mapYInverse = (mouseY: number) => TW_CENTER_Y + ((mouseY - centerY) / dispAmp) * TW_AMP
        const yPrime = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, mapYInverse(e.clientY - rect.top)))

        const k = vertexCreateRef.current.anchorSeg
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
        const engineTmp = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
        const pts = engineTmp.getPoints()
        if (k < 0 || k >= pts.length - 1) return

        const beatAdd = Math.max(pts[k].beat + safeSnap, Math.min(pts[k + 1].beat - safeSnap, quantizeBeat(beat, safeSnap)))

        const snappedY = yPrime < ZONE_MID_START ? TOP_Y : yPrime < ZONE_MID_END ? CENTER_Y : BOTTOM_Y
        const yPrev = pts[k].y
        const yNext = pts[k + 1].y

        const beatsA = Math.max(safeSnap, quantizeBeat(beatAdd - pts[k].beat, safeSnap))
        const beatsB = Math.max(safeSnap, quantizeBeat(pts[k + 1].beat - beatAdd, safeSnap))
        const dirA = Math.abs(snappedY - yPrev) < 0.5 ? ('stay' as const) : snappedY < yPrev ? ('up' as const) : ('down' as const)
        const dirB = Math.abs(yNext - snappedY) < 0.5 ? ('stay' as const) : yNext < snappedY ? ('up' as const) : ('down' as const)

        const preview = [...segments]
        preview.splice(k, 1, { direction: dirA, beats: beatsA }, { direction: dirB, beats: beatsB })
        dragPreviewRef.current = preview
        setDragPreview(preview)
        return
      }
      if (edgeDragRef.current) {
        const x = e.clientX - rect.left
        const fieldH = rect.height - RULER_H
        const drag = edgeDragRef.current
        const dxBeat = quantizeBeat(xToBeatLocal(x, rect.width) - drag.startBeat, safeSnap)
        const centerY = RULER_H + fieldH / 2
        const maxAmp = (fieldH - 24) / 2
        const minAmp = Math.max(8, 0.2 * rect.height)
        const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
        const mapYInverse = (mouseY: number) => TW_CENTER_Y + ((mouseY - centerY) / dispAmp) * TW_AMP
        const newYMouse = mapYInverse(e.clientY - rect.top)
        const dy = Math.max(TW_CENTER_Y - TW_AMP - drag.startY, Math.min(TW_CENTER_Y + TW_AMP - drag.startY, newYMouse - drag.startY))
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)

        const result = calculateEdgeDrag({
          segments,
          bpmTimeline: timeline,
          startPosition,
          edgeIndex: drag.index,
          startBeat: drag.startBeat,
          startY: drag.startY,
          startPrevBeat: drag.startPrevBeat,
          startNextBeat: drag.startNextBeat,
          dxBeat,
          dy,
          snap: safeSnap,
        })
        dragPreviewRef.current = result
        setDragPreview(result)
        return
      }
      if (dragRef.current) {
        onMoveRing?.(dragRef.current.index, xToBeatLocal(e.clientX - rect.left, rect.width))
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
      const canvas = canvasRef.current
      const rect = canvas?.getBoundingClientRect()
      // T156: rubber band selection commit on right-button mouseup.
      // If the drag moved >= 4px, populate multi-selection; otherwise delegate to
      // the single-delete path (right-click remove).
      if (rubberRef.current) {
        const r = rubberRef.current
        rubberRef.current = null
        const relX = rect ? e.clientX - rect.left : r.startX
        const relY = rect ? e.clientY - rect.top : r.startY
        const moved = Math.hypot(relX - r.startX, relY - r.startY)
        setRubberRect(null)
        if (rect && moved >= 4) {
          rubberDraggedRef.current = true
          const found = findItemsInRect(r.startX, r.startY, relX, relY, rect.width, rect.height)
          if (editMode === 'ring') {
            if (found.rings.length === 1) onSelectRing?.(found.rings[0])
            else if (found.rings.length > 1) onSelectRings?.(found.rings)
            else onSelectRing?.(null)
          } else {
            const segs = found.segs
            if (segs.length === 1) onSelectSegment?.(segs[0])
            else if (segs.length > 1) onSelectSegments?.(segs)
            else onSelectSegment?.(null)
          }
        }
        return
      }
      // T156: multi-selection move commit — single commit per mouseup
      if (multiDragRef.current) {
        multiDragRef.current = null
        if (editMode === 'ring') {
          if (ringDragOffset !== 0) {
            const selected = selectedRings.length > 0 ? selectedRings : selectedRing != null ? [selectedRing] : []
            // Skip rings that no longer exist; clamp to non-negative snapped beats.
            const moves = selected
              .filter((i) => rings[i] != null)
              .map((i) => ({ index: i, beat: Math.max(0, Math.round((rings[i].beat + ringDragOffset) / safeSnap) * safeSnap) }))
            if (moves.length > 0) onMultiMoveRings?.(moves)
          }
          setRingDragOffset(0)
        } else {
          if (multiDragSegments) onMultiMoveSegments?.(multiDragSegments)
          setMultiDragSegments(null)
        }
        return
      }
      if (vertexDragRef.current) {
        // T150: commit the local preview exactly once on mouseup.
        const preview = dragPreviewRef.current
        if (preview && onSegmentsChange) onSegmentsChange(preview)
        vertexDragRef.current = null
        dragPreviewRef.current = null
        setDragPreview(null)
        return
      }
      if (vertexCreateRef.current) {
        const preview = dragPreviewRef.current
        if (preview && onSegmentsChange) onSegmentsChange(preview)
        vertexCreateRef.current = null
        dragPreviewRef.current = null
        setDragPreview(null)
        return
      }
      if (edgeDragRef.current) {
        const preview = dragPreviewRef.current
        if (preview && onSegmentsChange) onSegmentsChange(preview)
        edgeDragRef.current = null
        dragPreviewRef.current = null
        setDragPreview(null)
        return
      }
      if (dragRef.current) {
        dragRef.current = null
        return
      }

      panRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onMoveRing, onViewChange, editMode, segments, bpm, bpmChanges, amplitude, startPosition, onSegmentsChange, safeSnap, selectedRings, selectedRing, ringDragOffset, multiDragSegments, onMultiMoveRings, onMultiMoveSegments, onSelectRing, onSelectRings, onSelectSegment, onSelectSegments, rings, findItemsInRect])

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
    const isRight = e.button === 2

    // Click on the top ruler strip seeks playback instead of placing a ring.
    if (onSeek && clickY < RULER_H) {
      if (isRight) { e.preventDefault(); return }
      const x = e.clientX - rect.left
      const beat = xToBeatLocal(x, rect.width)
      onSeek(Math.max(0, beat))
      return
    }

    // T156: right-button always starts rubber band selection (all modes).
    // Right single-click (< 4px drag) delegates to delete via onUp commit path.
    if (isRight) {
      // Reset any stale drag flag so a *fresh* right-click always falls through to
      // the single-item delete path (right-click remove) when the mouse is released.
      rubberDraggedRef.current = false
      rubberRef.current = {
        startBeat: xToBeatLocal(e.clientX - rect.left, rect.width),
        startX: e.clientX - rect.left,
        startY: clickY,
        mode: editMode,
      }
      // clear any existing rubber rect (fresh start)
      setRubberRect({ x: e.clientX - rect.left, y: clickY, w: 0, h: 0 })
      e.preventDefault()
      return
    }

    // Left-button multi-drag: if clicking on a selected item, move the whole
    // selection (preview only → commit on mouseup).
    const selectedSet = editMode === 'ring'
      ? new Set(selectedRings.length ? selectedRings : selectedRing != null ? [selectedRing] : [])
      : new Set(selectedSegments.length ? selectedSegments : selectedSegment != null ? [selectedSegment] : [])
    if (e.button === 0) {
      let onSel = false
      if (editMode === 'ring') {
        onSel = nearestRingIndex(e.clientX) >= 0 && selectedRings.includes(nearestRingIndex(e.clientX))
      } else if (editMode === 'vertex') {
        const vHit = nearestVertexIndex(e.clientX, e.clientY)
        onSel = vHit >= 0 && (selectedSegments.includes(vHit === 0 ? 0 : vHit - 1) || (selectedSegment === (vHit === 0 ? 0 : vHit - 1)))
      } else if (editMode === 'edge') {
        const eHit = nearestEdgeIndex(e.clientX, e.clientY)
        onSel = eHit >= 0 && (selectedSegments.includes(eHit) || selectedSegment === eHit)
      }
      if (onSel && selectedSet.size > 0) {
        multiDragRef.current = { startBeat: xToBeatLocal(e.clientX - rect.left, rect.width), startY: clickY }
        if (editMode !== 'ring') {
          multiDragRef.current.origSegIndices = selectedSegments.length ? selectedSegments : (selectedSegment != null ? [selectedSegment] : [])
        }
        e.preventDefault()
        return
      }
    }

    // Mode-specific hit testing — complete separation per T116 (left button only)
    if (editMode === 'vertex') {
      const vHit = nearestVertexIndex(e.clientX, e.clientY)
      if (vHit >= 0) {
        onSelectSegment?.(vHit === 0 ? 0 : vHit - 1)
        vertexDragRef.current = { index: vHit }
        e.preventDefault()
        return
      }
      // T154: vertex mode empty drag = vertex creation (preview → commit on mouseup)
      {
        const x = e.clientX - rect.left
        const clickBeat = xToBeatLocal(x, rect.width)
        const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
        const engineTmp = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
        const pts = engineTmp.getPoints()
        let k = 0
        for (let i = 0; i < pts.length - 1; i++) {
          if (clickBeat >= pts[i].beat - 1e-6) k = i
        }
        vertexCreateRef.current = { anchorSeg: k, anchorBeat: clickBeat }
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
          startY: pts[eHit].y,
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

    // ring mode: isolated layer for add/drag/delete (T142: left-click only for select/drag)
    const hit = nearestRingIndex(e.clientX)
    if (hit >= 0) {
      if (e.button === 0) {
        onSelectRing?.(hit)
        dragRef.current = { index: hit }
      }
      e.preventDefault()
      return
    }
    // empty area: begin a potential pan (left button)
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
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()

    if (editMode === 'ring') {
      panRef.current = null
      const hit = nearestRingIndex(e.clientX)
      if (hit < 0) {
        const beat = quantizeBeat(xToBeatLocal(e.clientX - rect.left, rect.width), safeSnap)
        const snapped = Math.round(beat / safeSnap) * safeSnap
        const added = onAddRing?.(snapped)
        if (added != null) onSelectRing?.(added)
      }
      return
    }

    if (editMode === 'vertex' && onSegmentsChange) {
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const beatAdd = quantizeBeat(xToBeatLocal(x, rect.width), safeSnap)
      const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
      const engine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
      const pts = engine.getPoints()

      let k = -1
      for (let i = 0; i < pts.length - 1; i++) {
        if (beatAdd > pts[i].beat + 1e-6 && beatAdd < pts[i + 1].beat - 1e-6) {
          k = i
          break
        }
      }
      if (k < 0 || k >= segments.length) return

      const fieldH = rect.height - RULER_H
      const centerY = RULER_H + fieldH / 2
      const maxAmpV = (fieldH - 24) / 2
      const minAmpV = Math.max(8, 0.2 * rect.height)
      const dispAmpV = Math.min(maxAmpV, Math.max(TW_AMP, minAmpV))
      const mapYInverse = (mouseY: number) => TW_CENTER_Y + ((mouseY - centerY) / dispAmpV) * TW_AMP
      const yAdd = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, mapYInverse(y)))

      const yPrev = pts[k].y
      const yNext = pts[k + 1].y

      // T149: beats from horizontal position (preserve original time span)
      const beatsA = Math.max(safeSnap, quantizeBeat(beatAdd - pts[k].beat, safeSnap))
      const beatsB = Math.max(safeSnap, quantizeBeat(pts[k + 1].beat - beatAdd, safeSnap))
      // direction from Y only
      const dirA = Math.abs(yAdd - yPrev) < 0.5 ? ('stay' as const) : yAdd < yPrev ? ('up' as const) : ('down' as const)
      const dirB = Math.abs(yNext - yAdd) < 0.5 ? ('stay' as const) : yNext < yAdd ? ('up' as const) : ('down' as const)

      const newSegments = [...segments]
      newSegments.splice(k, 1, { direction: dirA, beats: beatsA }, { direction: dirB, beats: beatsB })
      onSegmentsChange(newSegments)
    }
  }

  const handleContextMenu = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    // T156: single right-click = delete; right-drag (rubber selection) is handled
    // in onUp and must not also delete, so suppress here after a drag.
    if (rubberDraggedRef.current) {
      rubberDraggedRef.current = false
      return
    }
    if (editMode === 'ring') {
      // Inline nearestRingIndex with 35px threshold
      const canvas = canvasRef.current
      if (!canvas) return
      const g = geoRef.current
      const rect = canvas.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      let hit = -1
      let nearestDist = Infinity
      rings.forEach((r, i) => {
        const rx = ((r.beat - g.viewStart) / g.viewBeats) * rect.width
        const d = Math.abs(rx - clickX)
        if (d < nearestDist) { nearestDist = d; hit = i }
      })
      if (nearestDist < 35) onDeleteRing?.(hit)
      return
    }
    if ((editMode !== 'vertex' && editMode !== 'edge') || !onSegmentsChange || vertexCreateRef.current) return

    const canvas2 = canvasRef.current
    if (!canvas2) return
    const rect2 = canvas2.getBoundingClientRect()
    const g2 = geoRef.current
    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, bpmChanges, EDITOR_BASE_AMP)
    const engine = new WaveEngine(segments, timeline, EDITOR_BASE_AMP, startPosition)
    const pts = engine.getPoints()
    const centerY = RULER_H + (rect2.height - RULER_H) / 2
    const fieldH = rect2.height - RULER_H
    const maxAmp = (fieldH - 24) / 2
    const minAmp = Math.max(8, 0.2 * rect2.height)
    const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
    const mapY = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp

    let vi = -1
    if (editMode === 'vertex') {
      const clickX2 = e.clientX - rect2.left
      const clickY2 = e.clientY - rect2.top
      let viDist = Infinity
      pts.forEach((p, i) => {
        const vx = ((p.beat - g2.viewStart) / g2.viewBeats) * rect2.width
        const vy = mapY(p.y)
        const d = Math.hypot(vx - clickX2, vy - clickY2)
        if (d < viDist) { viDist = d; vi = i }
      })
      if (viDist >= 14) vi = -1
    } else if (editMode === 'edge') {
      const ei = nearestEdgeIndex(e.clientX, e.clientY)
      if (ei >= 0 && ei < segments.length - 1) {
        vi = ei + 1
      }
    }

    if (vi <= 0) return
    if (vi >= pts.length - 1) return

    const yPrev = pts[vi - 1].y
    const yNext = pts[vi + 1].y
    const totalBeats = segments[vi - 1].beats + segments[vi].beats
    const beats = Math.max(safeSnap, quantizeBeat(totalBeats, safeSnap))
    const d = yNext - yPrev
    const dir = Math.abs(d) < 0.5 ? ('stay' as const) : d < 0 ? ('up' as const) : ('down' as const)

    const newSegments = [...segments]
    newSegments.splice(vi - 1, 2, { direction: dir, beats })
    onSegmentsChange(newSegments)
  }

  const handleMouseMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current || vertexDragRef.current || vertexCreateRef.current || edgeDragRef.current || panRef.current || rubberRef.current || multiDragRef.current) return
    // Hover interlink: detect nearest ring/edge/vertex under cursor and notify parent for list highlight
    if (editMode === 'ring') {
      const ringHit = nearestRingIndex(e.clientX)
      if (ringHit >= 0) {
        onHoverRing?.(ringHit)
        onHoverSegment?.(null)
        return
      }
    }
    if (editMode === 'vertex') {
      const vHit = nearestVertexIndex(e.clientX, e.clientY)
      if (vHit >= 0) {
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
        data-canvas-testid="wave-canvas"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      <p className="editor-hint" data-testid="wave-preview-hint">
        {editMode === 'vertex' && '頂点モード: 右ドラッグで範囲選択・左ドラッグで集合移動、右クリックで削除、空ドラッグで頂点作成（プレビュー→確定）。ホイールでズーム'}
        {editMode === 'edge' && '辺モード: 左ドラッグで辺移動・右ドラッグで範囲選択。空白ドラッグでパン、ホイールでズーム'}
        {editMode === 'ring' && 'リングモード: ダブルクリックで追加・右クリック削除・左ドラッグ移動・右ドラッグで範囲選択。ホイールでズーム'}
      </p>
    </div>
  )
}
