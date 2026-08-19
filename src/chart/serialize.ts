import type { Chart } from '../types'

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
  lines.push(`audio = ${tomlString(chart.audio)}`)

  for (const change of chart.bpm_changes) {
    lines.push('', '[[bpm_changes]]', `beat = ${fmt(change.beat)}`, `bpm = ${fmt(change.bpm)}`)
  }

  for (const seg of chart.segments) {
    lines.push('', '[[segments]]', `direction = "${seg.direction}"`, `beats = ${fmt(seg.beats)}`)
  }

  for (const ring of chart.rings) {
    lines.push('', '[[rings]]', `beat = ${fmt(ring.beat)}`)
  }

  return lines.join('\n') + '\n'
}