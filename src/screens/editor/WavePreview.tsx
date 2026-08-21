import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { WaveEngine } from '../../game/waveEngine'
import type { BpmChange, RingDef, Segment } from '../../types'

const GAME_CENTER_Y = 300
const ACCENT_COLOR = '#6366f1'
const SUB_COLOR = '#22d3ee'
const STAY_COLOR = '#fbbf24'
const SELECT_COLOR = '#ededed'

export interface WavePreviewProps {
  segments: Segment[]
  bpm: number
  bpmChanges?: BpmChange[]
  rings?: RingDef[]
  amplitude?: number
  snap?: number
  selectedRing?: number | null
  onAddRing?: (beat: number) => number | undefined
  onMoveRing?: (index: number, beat: number) => void
  onSelectRing?: (index: number | null) => void
  onDeleteRing?: (index: number) => void
}

export default function WavePreview({
  segments,
  bpm,
  bpmChanges = [],
  rings = [],
  amplitude = 130,
  snap = 0.25,
  selectedRing = null,
  onAddRing,
  onMoveRing,
  onSelectRing,
  onDeleteRing,
}: WavePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geoRef = useRef<{ lastBeat: number }>({ lastBeat: 4 })
  const dragRef = useRef<{ index: number } | null>(null)

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

    const centerY = cssH / 2
    const amp = Math.min((cssH - 24) / 2, ampVal)
    const mapY = (y: number) => centerY + ((y - GAME_CENTER_Y) / ampVal) * amp

    const totalBeats = segments.reduce((sum, seg) => sum + seg.beats, 0)
    const lastBeat = Math.max(totalBeats, 4)
    geoRef.current = { lastBeat }

    // Horizontal grid: top / center / bottom guide lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (const gy of [mapY(GAME_CENTER_Y - ampVal), centerY, mapY(GAME_CENTER_Y + ampVal)]) {
      ctx.beginPath()
      ctx.moveTo(0, gy)
      ctx.lineTo(cssW, gy)
      ctx.stroke()
    }

    // Vertical beat grid
    for (let b = 0; b <= lastBeat; b += 1) {
      const gx = (b / lastBeat) * cssW
      const strong = Math.round(b) % 4 === 0
      ctx.strokeStyle = strong ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(gx, 0)
      ctx.lineTo(gx, cssH)
      ctx.stroke()
    }

    // Start / judgment line (left edge)
    ctx.strokeStyle = 'rgba(99,102,241,0.5)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(2, 0)
    ctx.lineTo(2, cssH)
    ctx.stroke()

    // Segment color coding (up = accent, down = sub, stay = warning)
    let currentBeat = 0
    for (const seg of segments) {
      const subSteps = Math.max(10, Math.round((seg.beats / lastBeat) * cssW))
      ctx.strokeStyle =
        seg.direction === 'up' ? ACCENT_COLOR : seg.direction === 'down' ? SUB_COLOR : STAY_COLOR
      ctx.lineWidth = 2.5
      ctx.beginPath()
      for (let s = 0; s <= subSteps; s++) {
        const b = currentBeat + (s / subSteps) * seg.beats
        const x = (b / lastBeat) * cssW
        const y = mapY(engine.waveYAt(b))
        if (s === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      currentBeat += seg.beats
    }

    if (segments.length === 0) {
      ctx.strokeStyle = ACCENT_COLOR
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(0, mapY(GAME_CENTER_Y - ampVal))
      ctx.lineTo(cssW, mapY(GAME_CENTER_Y - ampVal))
      ctx.stroke()
    }

    // Rings (X axis = beat position)
    rings.forEach((r, i) => {
      const rx = (r.beat / lastBeat) * cssW
      const isSelected = i === selectedRing
      const ry = mapY(engine.waveYAt(r.beat))
      ctx.strokeStyle = isSelected ? SELECT_COLOR : 'rgba(251,191,36,0.55)'
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(rx, 0)
      ctx.lineTo(rx, cssH)
      ctx.stroke()

      ctx.fillStyle = isSelected ? SELECT_COLOR : STAY_COLOR
      ctx.beginPath()
      ctx.arc(rx, ry, isSelected ? 7 : 5, 0, Math.PI * 2)
      ctx.fill()
    })
  }, [segments, bpm, bpmChanges, rings, amplitude, selectedRing])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const beat = (x / rect.width) * geoRef.current.lastBeat
      onMoveRing?.(dragRef.current.index, beat)
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onMoveRing])

  const nearestRingIndex = (clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const clickX = clientX - rect.left
    const lastBeat = geoRef.current.lastBeat
    let nearest = -1
    let nearestDist = Infinity
    rings.forEach((r, i) => {
      const rx = (r.beat / lastBeat) * rect.width
      const d = Math.abs(rx - clickX)
      if (d < nearestDist) {
        nearestDist = d
        nearest = i
      }
    })
    return nearestDist < 14 ? nearest : -1
  }

  const handleMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = nearestRingIndex(e.clientX)
    if (hit >= 0) {
      onSelectRing?.(hit)
      dragRef.current = { index: hit }
      e.preventDefault()
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const beat = (x / rect.width) * geoRef.current.lastBeat
    const snapped = Math.round(beat / safeSnap) * safeSnap
    const added = onAddRing?.(snapped)
    if (added != null) onSelectRing?.(added)
  }

  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = nearestRingIndex(e.clientX)
    if (hit >= 0) onDeleteRing?.(hit)
  }

  return (
    <div className="wave-preview-wrap" data-testid="wave-preview">
      <canvas
        ref={canvasRef}
        className="wave-preview"
        data-testid="wave-preview-canvas"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      />
      <p className="editor-hint">
        クリックでリング追加・ドラッグで移動・ダブルクリックで削除。セグメントは波形に沿って描画
      </p>
    </div>
  )
}
