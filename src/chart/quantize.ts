import type { Segment } from '../types'

export interface TrajPoint {
  beat: number
  y: number
  /** true while a direction key (up/down) is held, false while released (stay). */
  down: boolean
}

export function quantizeBeat(beat: number, snap: number): number {
  if (!(snap > 0) || !Number.isFinite(beat)) return beat
  return Number((Math.round(beat / snap) * snap).toFixed(4))
}

/**
 * Convert a recorded cursor trajectory into wave segments.
 *
 * The trajectory records the pressed state (`down`) per sampled point. A run of
 * consecutive points sharing the same `down` value defines one segment:
 *   - `down === true`  -> moving run (up/down based on y delta)
 *   - `down === false` -> stay run (horizontal)
 *
 * Every produced segment's `beats` is a multiple of `snap` (quantized), so
 * recordings stay aligned to the selected grid resolution.
 *
 * Release snapping (T105): the end beat of a moving run is taken from the first
 * point *after* the run (the release point, which is already snapped to the grid
 * in `onKeyUp`). This makes the moving segment end exactly at
 *   b_end = round(b_rel / s) * s
 * and guarantees no overshoot into the next snap cell.
 */
export function segmentize(
  traj: TrajPoint[],
  snap: number,
  amplitude: number,
): Segment[] {
  if (traj.length < 2 || !(snap > 0)) return []
  const pts = [...traj].sort((a, b) => a.beat - b.beat)
  const threshold = Math.max((amplitude * 130 * snap) / 16, 0.5)
  // T126: physically correct beats = nearest multiple of the beat duration that
  // allows full-span traversal at the configured amplitude, snapped to the grid.
  // basePhysical = 1 / amplitude  (beats to traverse 2*TW_AMP at speed amplitude)
  const safeAmp = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 1.0
  const basePhysical = 1 / safeAmp
  let physicalSnap = quantizeBeat(basePhysical, snap)
  if (!(physicalSnap > 1e-9)) physicalSnap = snap
  // Ensure physicalSnap is at least snap (and not zero) so it remains snap-aligned
  if (physicalSnap < snap - 1e-9) physicalSnap = snap

  const segs: Segment[] = []
  let i = 0
  while (i < pts.length) {
    // Extend the current run while the `down` state stays identical.
    let j = i
    while (j + 1 < pts.length && pts[j + 1].down === pts[i].down) j++

    const startBeat = pts[i].beat
    const endBeat = j + 1 < pts.length ? pts[j + 1].beat : pts[j].beat
    const rawBeats = endBeat - startBeat
    if (rawBeats <= 1e-9) {
      i = j + 1
      continue
    }

    let direction: 'up' | 'down' | 'stay'
    if (!pts[i].down) {
      direction = 'stay'
    } else {
      const y0 = pts[i].y
      const y1 = j + 1 < pts.length ? pts[j + 1].y : pts[j].y
      const dy = y1 - y0
      if (Math.abs(dy) <= threshold) direction = 'stay'
      else direction = dy > 0 ? 'down' : 'up'
    }

    // T126: do not use rawBeats directly; snap raw to physical grid so any
    // recording speed maps to the nearest physically consistent duration.
    const rawQuant = quantizeBeat(rawBeats, snap)
    let beats = quantizeBeat(rawQuant, physicalSnap)
    // If rawQuant was smaller than half a physical unit, quantize yields 0;
    // clamp to one physical unit to prohibit zero-length free segments.
    if (beats < 1e-6) beats = physicalSnap
    if (beats > 1e-6) {
      const last = segs[segs.length - 1]
      if (last && last.direction === direction) {
        last.beats = Number((last.beats + beats).toFixed(4))
      } else {
        segs.push({ direction, beats: Number(beats.toFixed(4)) })
      }
    }
    i = j + 1
  }

  // Final pass: re-quantize every produced segment's beats so recordings stay
  // perfectly aligned to the physical grid (and thus also to snap), then drop empties.
  return segs
    .map((s) => ({ direction: s.direction, beats: Number(quantizeBeat(s.beats, physicalSnap).toFixed(4)) }))
    .filter((s) => s.beats > 1e-6)
}

export function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true
  const remainder = ((beats % snap) + snap) % snap
  return remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6
}
