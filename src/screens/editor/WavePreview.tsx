import { useEffect, useRef } from 'react'
import { BpmTimeline } from '../../audio/bpmTimeline'
import { WaveEngine } from '../../game/waveEngine'
import type { Segment } from '../../types'

const GAME_CENTER_Y = 300
const GAME_AMP = 80
const WAVE_COLOR = '#6366f1'

export default function WavePreview({ segments, bpm }: { segments: Segment[]; bpm: number }) {
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
    const lastBeat = Math.max(totalBeats, 1)
    const steps = Math.max(120, Math.round(cssW * 2))

    ctx.strokeStyle = WAVE_COLOR
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * cssW
      const y = mapY(engine.waveYAt((i / steps) * lastBeat))
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [segments, bpm])

  return <canvas ref={canvasRef} className="wave-preview" />
}