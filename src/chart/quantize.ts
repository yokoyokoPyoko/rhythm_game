import type { Segment } from '../types'

const DEFAULT_CENTER_Y = 300

function interpolateY(traj: { beat: number; y: number }[], beat: number): number {
  if (traj.length === 0) return DEFAULT_CENTER_Y
  if (beat <= traj[0].beat) return traj[0].y
  const last = traj[traj.length - 1]
  if (beat >= last.beat) return last.y
  for (let i = 0; i < traj.length - 1; i++) {
    const a = traj[i]
    const b = traj[i + 1]
    if (beat >= a.beat && beat <= b.beat) {
      if (b.beat <= a.beat) return b.y
      const t = (beat - a.beat) / (b.beat - a.beat)
      return a.y + (b.y - a.y) * t
    }
  }
  return last.y
}

export function quantizeBeat(beat: number, snap: number): number {
  if (!(snap > 0) || !Number.isFinite(beat)) return beat
  return Number((Math.round(beat / snap) * snap).toFixed(4))
}

/**
 * Convert a recorded cursor trajectory into wave segments.
 * Every produced segment's `beats` is a multiple of `snap` (quantized),
 * so recordings stay aligned to the selected grid resolution.
 */
export function segmentize(
  traj: { beat: number; y: number }[],
  snap: number,
  amplitude: number,
): Segment[] {
  if (traj.length < 2 || !(snap > 0)) return []
  const sorted = [...traj].sort((a, b) => a.beat - b.beat)
  const start = sorted[0].beat
  const end = sorted[sorted.length - 1].beat
  const threshold = Math.max((amplitude * snap) / 16, 0.5)

  const micro: Segment[] = []
  for (let b = start; b < end - 1e-6; b += snap) {
    const y1 = interpolateY(sorted, b)
    const y2 = interpolateY(sorted, b + snap)
    const dy = y2 - y1
    let dir: 'up' | 'down' | 'stay'
    if (Math.abs(dy) <= threshold) {
      dir = 'stay'
    } else {
      dir = dy > 0 ? 'down' : 'up'
    }
    micro.push({ direction: dir, beats: snap })
  }

  const merged: Segment[] = []
  for (const m of micro) {
    const last = merged[merged.length - 1]
    if (last && last.direction === m.direction) {
      last.beats = Number((last.beats + m.beats).toFixed(4))
    } else {
      merged.push({ direction: m.direction, beats: Number(m.beats.toFixed(4)) })
    }
  }
  // Quantize every produced segment's beats to an integer multiple of `snap`
  // so recordings stay aligned to the selected grid resolution.
  return merged
    .filter((s) => s.beats > 1e-6)
    .map((s) => {
      const snapped = Math.round(s.beats / snap) * snap
      return { direction: s.direction, beats: Number(snapped.toFixed(4)) }
    })
}

export function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true
  const remainder = ((beats % snap) + snap) % snap
  return remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6
}
