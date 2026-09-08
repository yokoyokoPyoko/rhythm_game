import type { BpmChange } from '../../types'

const BPM_MIN = 1
const BPM_MAX = 1000

function safeBpm (v: number): number {
  if (Number.isNaN(v) || v < BPM_MIN || v > BPM_MAX) return 120
  return v
}

function safeBeat (v: number): number {
  if (Number.isNaN(v) || v < 0) return 0
  return v
}

function safeZoom (v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 1.0
}

function sortByBeat (arr: BpmChange[]): BpmChange[] {
  return [...arr].sort((a, b) => a.beat - b.beat)
}

interface BpmEditorProps {
  bpmChanges: BpmChange[]
  onSectionsChange: (next: BpmChange[]) => void
  amplitude: number
  startPosition: number
  onStartPositionChange: (val: number) => void
  endBeat?: number
  onEndBeatChange: (val: number | undefined) => void
  onRequestAddSection: () => void
}

export default function BpmEditor({
  bpmChanges,
  onSectionsChange,
  amplitude,
  startPosition,
  onStartPositionChange,
  endBeat,
  onEndBeatChange,
  onRequestAddSection,
}: BpmEditorProps) {
  const removeChange = (index: number) => {
    onSectionsChange(sortByBeat(bpmChanges.filter((_, i) => i !== index)))
  }

  const updateChange = (index: number, patch: Partial<BpmChange>) => {
    onSectionsChange(bpmChanges.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const commitBeatChange = (index: number, newBeat: number) => {
    const next = bpmChanges.map((c, i) => (i === index ? { ...c, beat: newBeat } : c))
    onSectionsChange(sortByBeat(next))
  }

  return (
    <div>
      <div className="editor-field">
        <label className="editor-label" htmlFor="start-position">
          開始位置 (-1.0=下端, 0=中央, 1.0=上端)
        </label>
        <input
          id="start-position"
          className="editor-input"
          type="range"
          min={-1}
          max={1}
          step={0.1}
          value={Number.isFinite(startPosition) ? startPosition : 0}
          onChange={(e) => onStartPositionChange(Number(e.target.value))}
          data-testid="start-position"
        />
        <span className="editor-hint" style={{display: 'block', marginTop: '4px'}}>
          現在値: {Number.isFinite(startPosition) ? startPosition.toFixed(1) : '0.0'}
        </span>
      </div>

      <div className="editor-field">
        <label className="editor-label" htmlFor="end-beat">
          楽曲終了位置 (ビート)
        </label>
        <input
          id="end-beat"
          className="editor-input"
          type="number"
          min={0}
          step={1}
          value={endBeat !== undefined && Number.isFinite(endBeat) ? endBeat : ''}
          placeholder="自動 (最後のリング + 2秒)"
          onChange={(e) => {
            const v = Number(e.target.value)
            onEndBeatChange(Number.isFinite(v) && v >= 0 ? v : undefined)
          }}
          data-testid="end-beat"
        />
      </div>

      <h3 className="editor-subhead">セクション設定</h3>
      {bpmChanges.length === 0 ? (
        <p className="editor-empty">セクションなし</p>
      ) : (
        <>
          <div className="bpm-change-header">
            <span>beat</span>
            <span>BPM</span>
            <span>速度係数</span>
            <span>横拡大率</span>
            <span />
          </div>
          <ul className="bpm-change-list">
          {bpmChanges.map((change, i) => (
            <li key={i} className="bpm-change-item">
              <input
                className="editor-input bpm-change-beat"
                type="number"
                min={0}
                step={0.25}
                defaultValue={safeBeat(change.beat)}
                onBlur={(e) => commitBeatChange(i, safeBeat(Number(e.target.value)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitBeatChange(i, safeBeat(Number((e.target as HTMLInputElement).value)))
                  }
                }}
                aria-label={`セクション${i + 1}のbeat`}
              />
              <input
                className="editor-input bpm-change-bpm"
                type="number"
                min={BPM_MIN}
                max={BPM_MAX}
                value={safeBpm(change.bpm)}
                onChange={(e) => updateChange(i, { bpm: safeBpm(Number(e.target.value)) })}
                aria-label={`セクション${i + 1}のBPM`}
              />
              <input
                className="editor-input bpm-change-amplitude"
                type="number"
                min={0.1}
                max={5.0}
                step={0.1}
                value={change.amplitude !== undefined ? change.amplitude : amplitude}
                placeholder="base"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  const val = Number.isFinite(v) && v > 0 ? v : undefined
                  updateChange(i, { amplitude: val })
                }}
                aria-label={`セクション${i + 1}の振幅`}
                title="空欄なら基本振幅を継続"
              />
              <input
                className="editor-input bpm-change-zoom"
                type="number"
                min={0.1}
                step={0.1}
                value={change.zoom !== undefined ? safeZoom(change.zoom) : 1.0}
                placeholder="1.0"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  updateChange(i, { zoom: Number.isFinite(v) && v > 0 ? v : undefined })
                }}
                aria-label={`セクション${i + 1}の横拡大率`}
                title="空欄なら横拡大率1.0を継続"
              />
              <button
                type="button"
                className="bpm-change-delete"
                onClick={() => removeChange(i)}
                aria-label={`セクション${i + 1}を削除`}
              >
                −
              </button>
            </li>
          ))}
          </ul>
        </>
      )}
      <button type="button" className="bpm-change-add" onClick={onRequestAddSection}>
        セクションを追加
      </button>
    </div>
  )
}
