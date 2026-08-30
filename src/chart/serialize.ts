import type { Chart } from '../types'
import { getBasename } from '../audio/AudioCache'

function fmt(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  return String(rounded)
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function chartToToml(chart: Chart): string {
  const lines: string[] = []
  lines.push(`title = ${tomlString(chart.title)}`)
  lines.push(`artist = ${tomlString(chart.artist)}`)
  lines.push(`bpm = ${fmt(chart.bpm)}`)
  lines.push(`audio = ${tomlString(getBasename(chart.audio))}`)
  lines.push(`audio_offset = ${fmt(chart.audio_offset)}`)
  lines.push(`scroll_speed = ${fmt(chart.scroll_speed)}`)
  lines.push(`amplitude = ${fmt(chart.amplitude)}`)
  if (chart.start_position !== 0.0) {
    lines.push(`start_position = ${fmt(chart.start_position)}`)
  }

  if (chart.bpm_changes.length === 0) {
    lines.push(`bpm_changes = []`)
  } else {
    for (const change of chart.bpm_changes) {
      lines.push('', '[[bpm_changes]]', `beat = ${fmt(change.beat)}`, `bpm = ${fmt(change.bpm)}`)
    }
  }

  for (const seg of chart.segments) {
    lines.push('', '[[segments]]', `direction = "${seg.direction}"`, `beats = ${fmt(seg.beats)}`)
  }

  for (const ring of chart.rings) {
    const ringLines = ['', '[[rings]]', `beat = ${fmt(ring.beat)}`];
    if (ring.type === 'hold') {
      ringLines.push(`type = "hold"`);
    }
    if (typeof ring.duration === 'number' && Number.isFinite(ring.duration) && ring.duration > 0) {
      ringLines.push(`duration = ${fmt(ring.duration)}`);
    }
    lines.push(...ringLines);
  }

  return lines.join('\n') + '\n'
}
