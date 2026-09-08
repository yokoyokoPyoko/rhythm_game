import { useState } from 'react'
import type { BpmChange } from '../../types'

const BPM_MIN = 1
const BPM_MAX = 1000

interface SectionAddDialogProps {
  sections: BpmChange[]
  onSectionsChange: (next: BpmChange[]) => void
  baseAmplitude?: number
  onClose: () => void
}

export default function SectionAddDialog({
  sections,
  onSectionsChange,
  baseAmplitude = 1.0,
  onClose,
}: SectionAddDialogProps) {
  const last = sections[sections.length - 1]
  const defaultBeat = last ? Math.floor(last.beat) + 4 : 0
  const defaultBpm = last ? last.bpm : 120
  const defaultAmp = last?.amplitude ?? baseAmplitude
  const defaultZoom = last?.zoom ?? 1.0

  const [beat, setBeat] = useState(String(defaultBeat))
  const [bpm, setBpm] = useState(String(defaultBpm))
  const [amplitude, setAmplitude] = useState(String(defaultAmp))
  const [zoom, setZoom] = useState(String(defaultZoom))
  const [taps, setTaps] = useState<number[]>([])

  const handleTap = () => {
    const now = performance.now()
    const kept = taps.length >= 4 ? taps.slice(taps.length - 3) : taps
    const all = [...kept, now]
    setTaps(all)
    if (all.length >= 4) {
      let sum = 0
      for (let i = 1; i < all.length; i++) sum += all[i] - all[i - 1]
      const avgMs = all.length > 1 ? sum / (all.length - 1) : 0
      if (avgMs > 0) {
        const computed = 60000 / avgMs
        setBpm(String(Math.max(1, Math.min(1000, Math.round(computed)))))
      }
    }
  }

  function sortByBeat(arr: BpmChange[]): BpmChange[] {
    return [...arr].sort((a, b) => a.beat - b.beat)
  }

  const confirmAdd = () => {
    const beatVal = Number(beat)
    const bpmVal = Number(bpm)
    const ampVal = Number(amplitude)
    const zoomVal = Number(zoom)
    const next = sortByBeat([
      ...sections,
      {
        beat: Number.isFinite(beatVal) && beatVal >= 0 ? beatVal : 0,
        bpm: Number.isFinite(bpmVal) ? Math.max(BPM_MIN, Math.min(BPM_MAX, bpmVal)) : 120,
        amplitude: Number.isFinite(ampVal) && ampVal > 0 ? ampVal : undefined,
        zoom: Number.isFinite(zoomVal) && zoomVal > 0 ? zoomVal : undefined,
      },
    ])
    onSectionsChange(next)
    onClose()
  }

  return (
    <div className="editor-dialog-backdrop" onClick={onClose}>
      <div
        className="editor-dialog"
        role="dialog"
        aria-label="セクションを追加"
        data-testid="section-add-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="editor-subhead">セクションを追加</h3>
        <div className="editor-field">
          <label className="editor-label" htmlFor="section-add-beat">
            beat
          </label>
          <input
            id="section-add-beat"
            className="editor-input"
            type="number"
            min={0}
            step={0.25}
            value={beat}
            onChange={(e) => setBeat(e.target.value)}
            data-testid="section-add-beat"
          />
        </div>
        <div className="editor-field">
          <label className="editor-label" htmlFor="section-add-bpm">
            BPM
          </label>
          <input
            id="section-add-bpm"
            className="editor-input"
            type="number"
            min={BPM_MIN}
            max={BPM_MAX}
            value={bpm}
            onChange={(e) => setBpm(e.target.value)}
            data-testid="section-add-bpm"
          />
        </div>
        <div className="editor-field">
          <label className="editor-label" htmlFor="section-add-amplitude">
            速度係数
          </label>
          <input
            id="section-add-amplitude"
            className="editor-input"
            type="number"
            min={0.1}
            step={0.1}
            value={amplitude}
            onChange={(e) => setAmplitude(e.target.value)}
            data-testid="section-add-amplitude"
          />
        </div>
        <div className="editor-field">
          <label className="editor-label" htmlFor="section-add-zoom">
            横拡大率
          </label>
          <input
            id="section-add-zoom"
            className="editor-input"
            type="number"
            min={0.1}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(e.target.value)}
            data-testid="section-add-zoom"
          />
        </div>
        <div className="editor-field">
          <div className="editor-controls">
            <button type="button" onClick={handleTap} data-testid="section-tap-tempo">
              タップテンポ
            </button>
            <button type="button" onClick={() => setTaps([])}>
              リセット
            </button>
          </div>
          <p className="editor-hint">4回タップすると平均BPMがBPM欄へ反映されます</p>
        </div>
        <div className="editor-controls">
          <button type="button" onClick={confirmAdd} data-testid="section-add-confirm">
            確定
          </button>
          <button type="button" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}