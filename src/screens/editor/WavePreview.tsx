import { useEffect, useRef } from 'react'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { WaveEngine } from '../../game/waveEngine'
import type { RingDef, Segment } from '../../types'

const GAME_CENTER_Y = 300
const GAME_AMP = 80
const ACCENT_COLOR = '#6366f1'
const SUB_COLOR = '#22d3ee'

export default function WavePreview({
  segments,
  bpm,
  rings = [],
}: {
  segments: Segment[]
  bpm: number
  rings?: RingDef[]
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

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

    const timeline = new BpmTimeline(bpm > 0 ? bpm : 120, [])
    const engine = new WaveEngine(segments, timeline)

    const centerY = cssH / 2
    const amp = Math.min(40, centerY - 8)
    const mapY = (y: number) => centerY + ((y - GAME_CENTER_Y) / GAME_AMP) * amp

    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centerY)
    ctx.lineTo(cssW, centerY)
    ctx.stroke()

    const totalBeats = segments.reduce((sum, seg) => sum + seg.beats, 0)
    const lastBeat = Math.max(totalBeats, 4)

    // Render ring vertical lines (X axis = beat position)
    if (rings && rings.length > 0) {
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)'
      ctx.lineWidth = 1
      for (const r of rings) {
        const rx = (r.beat / lastBeat) * cssW
        ctx.beginPath()
        ctx.moveTo(rx, 0)
        ctx.lineTo(rx, cssH)
        ctx.stroke()
      }
    }

    // Segment color coding (up = accent, down = sub)
    let currentBeat = 0
    for (const seg of segments) {
      const subSteps = Math.max(10, Math.round((seg.beats / lastBeat) * cssW))
      ctx.strokeStyle = seg.direction === 'up' ? ACCENT_COLOR : SUB_COLOR
      ctx.lineWidth = 2
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
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, mapY(GAME_CENTER_Y - GAME_AMP))
      ctx.lineTo(cssW, mapY(GAME_CENTER_Y - GAME_AMP))
      ctx.stroke()
    }
  }, [segments, bpm, rings])

  return <canvas ref={canvasRef} className="wave-preview" />
}