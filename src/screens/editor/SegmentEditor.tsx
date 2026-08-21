import type { Segment } from '../../types'

interface SegmentEditorProps {
  segments: Segment[]
  onSegmentsChange: (next: Segment[]) => void
}

export default function SegmentEditor({ segments, onSegmentsChange }: SegmentEditorProps) {
  const addSegment = () => {
    onSegmentsChange([...segments, { direction: 'up', beats: 1 }])
  }

  const removeSegment = (index: number) => {
    onSegmentsChange(segments.filter((_, i) => i !== index))
  }

  const updateDirection = (index: number, direction: 'up' | 'down' | 'stay') => {
    onSegmentsChange(segments.map((seg, i) => (i === index ? { ...seg, direction } : seg)))
  }

  const updateBeats = (index: number, beats: number) => {
    const v = Number.isFinite(beats) && beats > 0 ? beats : 1
    onSegmentsChange(segments.map((seg, i) => (i === index ? { ...seg, beats: v } : seg)))
  }

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir
    if (target < 0 || target >= segments.length) return
    const next = [...segments]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onSegmentsChange(next)
  }

  return (
    <details className="editor-accordion" data-testid="segment-list-details">
      <summary className="editor-accordion-summary">
        <span>セグメント ({segments.length})</span>
        <button
          type="button"
          className="editor-accordion-add"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            addSegment()
          }}
          aria-label="セグメントを追加"
        >
          追加
        </button>
      </summary>
      <p className="editor-hint">再生中に ↑/↓/→ (W/S/D) でリアルタイムにセグメントをスタンプ録音</p>
      {segments.length === 0 ? (
        <p className="editor-empty">セグメントなし</p>
      ) : (
        <ul className="segment-list">
          {segments.map((seg, i) => (
            <li key={i} className="segment-list-item">
              <span className="segment-index">{i + 1}</span>
              <select
                className="editor-input segment-direction"
                value={seg.direction}
                onChange={(e) => updateDirection(i, e.target.value as 'up' | 'down' | 'stay')}
                aria-label={`セグメント${i + 1}の方向`}
                data-testid={`segment-direction-${i}`}
              >
                <option value="up">↑</option>
                <option value="down">↓</option>
                <option value="stay">―</option>
              </select>
              <input
                className="editor-input segment-beats"
                type="number"
                min={0.25}
                step={0.25}
                value={seg.beats}
                onChange={(e) => updateBeats(i, Number(e.target.value))}
                aria-label={`セグメント${i + 1}の拍数`}
                data-testid={`segment-beats-${i}`}
              />
              <div className="segment-actions">
                <button
                  type="button"
                  className="segment-move"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`セグメント${i + 1}を上に移動`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="segment-move"
                  disabled={i === segments.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`セグメント${i + 1}を下に移動`}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="segment-delete"
                  onClick={() => removeSegment(i)}
                  aria-label={`セグメント${i + 1}を削除`}
                  data-testid={`segment-delete-${i}`}
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}