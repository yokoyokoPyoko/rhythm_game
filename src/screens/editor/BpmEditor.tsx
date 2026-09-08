import { Fragment, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { BpmChange, EasingType } from '../../types'

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
  const [beatValues, setBeatValues] = useState<number[]>(bpmChanges.map((c) => safeBeat(c.beat)))

  useEffect(() => {
    setBeatValues(bpmChanges.map((c) => safeBeat(c.beat)))
  }, [bpmChanges])

  const removeChange = (index: number) => {
    onSectionsChange(sortByBeat(bpmChanges.filter((_, i) => i !== index)))
  }

  const updateChange = (index: number, patch: Partial<BpmChange>) => {
    onSectionsChange(bpmChanges.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const [selectedSection, setSelectedSection] = useState<number | null>(null)
  const [dragGap, setDragGap] = useState<number | null>(null)
  const [dropGap, setDropGap] = useState<number | null>(null)
  const dragGapRef = useRef<number | null>(null)

  const setEase = (ownerIdx: number, ease: EasingType | undefined) => {
    updateChange(ownerIdx, { easeToNext: ease })
  }

  const handleDragStart = (gap: number) => (e: DragEvent) => {
    dragGapRef.current = gap
    setDragGap(gap)
    setDropGap(null)
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', String(gap)) } catch { /* dataTransfer unavailable in some test envs */ }
    }
  }

  const handleDragEnd = () => {
    dragGapRef.current = null
    setDragGap(null)
    setDropGap(null)
  }

  const handleDragOver = (gap: number) => (e: DragEvent) => {
    if (dragGapRef.current === null) return
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    e.preventDefault()
    setDropGap(gap)
  }

  const handleDragLeave = () => {
    setDropGap(null)
  }

  const handleDrop = (gap: number) => (e: DragEvent) => {
    e.preventDefault()
    let from = dragGapRef.current
    if (from === null) {
      try { from = Number(e.dataTransfer?.getData('text/plain')) } catch { from = Number.NaN }
    }
    const n = bpmChanges.length
    const validFrom = typeof from === 'number' && Number.isFinite(from) && from >= 0 && from < n - 1
    const validGap = gap >= 0 && gap < n - 1
    if (!validFrom || !validGap || from === gap) {
      dragGapRef.current = null
      setDragGap(null)
      setDropGap(null)
      return
    }
    const moving = bpmChanges[from].easeToNext
    if (moving) {
      const next = bpmChanges.map((c, i) => {
        if (i === from) return { ...c, easeToNext: undefined }
        if (i === gap) return { ...c, easeToNext: moving }
        return c
      })
      onSectionsChange(next)
    }
    setSelectedSection(gap)
    dragGapRef.current = null
    setDragGap(null)
    setDropGap(null)
  }

  const addEasing = () => {
    const n = bpmChanges.length
    if (n < 2) return
    const owner = selectedSection !== null && selectedSection >= 0 && selectedSection < n - 1
      ? selectedSection
      : n - 2
    setEase(owner, 'linear')
    setSelectedSection(owner)
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
          {bpmChanges.map((change, i) => {
            const isLast = i === bpmChanges.length - 1
            const hasEasing = change.easeToNext !== undefined
            const dragActive = dragGap !== null && dragGap !== i
            const dropHot = dragActive && dropGap === i
            return (
            <Fragment key={i}>
            <li
              className={`bpm-change-item${selectedSection === i ? ' bpm-change-item-selected' : ''}`}
              onClick={() => { setSelectedSection(i); setDropGap(null) }}
            >
              <input
                className="editor-input bpm-change-beat"
                type="number"
                min={0}
                step={0.25}
                value={beatValues[i] ?? safeBeat(change.beat)}
                onChange={(e) => setBeatValues((prev) => { const next = [...prev]; next[i] = safeBeat(Number(e.target.value)); return next })}
                onBlur={(e) => {
                  const newBeat = safeBeat(Number(e.target.value))
                  const next = bpmChanges.map((c, idx) => (idx === i ? { ...c, beat: newBeat } : c))
                  onSectionsChange(sortByBeat(next))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const newBeat = safeBeat(Number((e.target as HTMLInputElement).value))
                    const next = bpmChanges.map((c, idx) => (idx === i ? { ...c, beat: newBeat } : c))
                    onSectionsChange(sortByBeat(next))
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
            {!isLast && (
              hasEasing ? (
                <li
                  key={`ease-${i}`}
                  className={`bpm-change-ease-row${selectedSection === i ? ' bpm-change-ease-selected' : ''}${dropHot ? ' bpm-change-ease-dragover' : ''}`}
                  onClick={() => { setSelectedSection(i); setDropGap(null) }}
                  onDragOver={handleDragOver(i)}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop(i)}
                >
                  <span
                    className="bpm-change-ease-grip"
                    draggable
                    onDragStart={handleDragStart(i)}
                    onDragEnd={handleDragEnd}
                    title="ドラッグで別の隙間へ移動"
                  >
                    ⠿
                  </span>
                  <span className="bpm-change-ease-label">イージング</span>
                  <select
                    className="editor-input bpm-change-ease-select"
                    value={change.easeToNext as EasingType}
                    onChange={(e) => setEase(i, e.target.value as EasingType)}
                    aria-label={`セクション${i + 1}のイージング曲線`}
                  >
                    <option value="linear">直線</option>
                    <option value="ease-out">イーズアウト</option>
                    <option value="ease-in">イーズイン</option>
                  </select>
                  <button
                    type="button"
                    className="bpm-change-delete"
                    onClick={(e) => { e.stopPropagation(); setEase(i, undefined) }}
                    aria-label={`セクション${i + 1}のイージングを削除`}
                  >
                    −
                  </button>
                </li>
              ) : (
                <li
                  key={`ease-slot-${i}`}
                  className={`bpm-change-ease-slot${dropHot ? ' bpm-change-ease-dragover' : ''}`}
                  onClick={() => { setSelectedSection(i); setDropGap(null) }}
                  onDragOver={handleDragOver(i)}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop(i)}
                  title="ここへドロップしてイージングを追加"
                >
                  <span className="bpm-change-ease-slot-line" />
                </li>
              )
            )}
            </Fragment>
            )
          })}
          </ul>
        </>
      )}
      <div className="bpm-change-actions">
        <button type="button" className="bpm-change-add" onClick={onRequestAddSection}>
          セクションを追加
        </button>
        <button
          type="button"
          className="bpm-change-add"
          onClick={addEasing}
          disabled={bpmChanges.length < 2}
          title="選択中セクションの直後（未選択なら末尾）にイージングを設定"
        >
          イージング追加
        </button>
      </div>
    </div>
  )
}
