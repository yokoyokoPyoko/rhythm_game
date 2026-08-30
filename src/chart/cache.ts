import type { Chart } from '../types'

const chartCache = new Map<string, Chart>()

export const ChartCache = {
  set(key: string, chart: Chart) {
    chartCache.set(key, chart)
  },
  get(key: string): Chart | undefined {
    return chartCache.get(key)
  },
  has(key: string): boolean {
    return chartCache.has(key)
  },
  clear() {
    chartCache.clear()
  },
}
