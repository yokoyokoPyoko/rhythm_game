import { useRef, useState } from 'react'
import type { BpmChange } from '../../types'

const TAP_COUNT = 4
const BPM_MIN = 1
const BPM_MAX = 1000

interface BpmEditorProps {
  bpm: number
  onBpmChange: (bpm: number) => void
  bpmChanges: BpmChange[]
  onBpmChangesChange: (next: BpmChange[]) => void
}

export default function BpmEditor({ bpm, onBpmChange, bpmChanges, onBpmChangesChange }: BpmEditorProps) {
  const tapTimesRef = useRef<number[]>([])
  const [tapCount, setTapCount] = useState(0)

  const addChange = () => {
    const defaultBeat = bpmChanges.length > 0 ? Math.floor(bpmChanges[bpmChanges.length - 1].beat) + 4 : 4
    onBpmChangesChange([...bpmChanges, { beat: defaultBeat, bpm }])
  }

  const removeChange = (index: number) => {
    onBpmChangesChange(bpmChanges.filter((_, i) => i !== index))
  }

  const updateChange = (index: number, patch: Partial<BpmChange>) => {
    onBpmChangesChange(bpmChanges.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const handleTap = () => {
    const now = performance.now()
    const times = [...tapTimesRef.current, now]
    if (times.length < TAP_COUNT) {
      tapTimesRef.current = times
      setTapCount(times.length)
      return
    }
    let total = 0
    for (let i = 1; i < times.length; i++) {
      total += times[i] - times[i - 1]
    }
    const avgInterval = total / (times.length - 1)
    if (avgInterval > 0) {
      const tappedBpm = Math.round(60000 / avgInterval)
      if (tappedBpm >= BPM_MIN && tappedBpm <= BPM_MAX) {
        onBpmChange(tappedBpm)
      }
    }
    tapTimesRef.current = []
    setTapCount(0)
  }

  const resetTap = () => {
    tapTimesRef.current = []
    setTapCount(0)
  }

  return (
    <div>
      <div className="editor-field">
        <label className="editor-label" htmlFor="bpm">
          基本BPM
        </label>
        <input
          id="bpm"
          className="editor-input"
          type="number"
          min={BPM_MIN}
          value={bpm}
          onChange={(e) => onBpmChange(Number(e.target.value))}
        />
      </div>

      <div className="editor-field">
        <label className="editor-label">タップテンポ</label>
        <div className="editor-controls">
          <button type="button" onClick={handleTap}>
            タップ ({tapCount}/{TAP_COUNT})
          </button>
          <button type="button" onClick={resetTap}>
            リセット
          </button>
        </div>
        <p className="editor-hint">リズムに合わせて{TAP_COUNT}回タップ → 平均BPMを基本BPMに反映</p>
      </div>

      <h3 className="editor-subhead">BPM変更</h3>
      {bpmChanges.length === 0 ? (
        <p className="editor-empty">BPM変更なし</p>
      ) : (
        <ul className="bpm-change-list">
          {bpmChanges.map((change, i) => (
            <li key={i} className="bpm-change-item">
              <input
                className="editor-input bpm-change-beat"
                type="number"
                min={0}
                step={0.25}
                value={change.beat}
                onChange={(e) => updateChange(i, { beat: Math.max(0, Number(e.target.value)) })}
                aria-label={`BPM変更${i + 1}のbeat`}
              />
              <input
                className="editor-input bpm-change-bpm"
                type="number"
                min={BPM_MIN}
                max={BPM_MAX}
                value={change.bpm}
                onChange={(e) => updateChange(i, { bpm: Number(e.target.value) })}
                aria-label={`BPM変更${i + 1}のBPM`}
              />
              <button
                type="button"
                className="bpm-change-delete"
                onClick={() => removeChange(i)}
                aria-label={`BPM変更${i + 1}を削除`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="bpm-change-add" onClick={addChange}>
        BPM変更を追加
      </button>
    </div>
  )
}
