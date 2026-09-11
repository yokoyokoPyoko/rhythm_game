import { useMemo } from 'react'
import { bucketEventsToSlots } from '../storage/playCounts'

const SLOT_MS = 30 * 60 * 1000;
const SLOT_COUNT = 48; // 24h in 30-minute slots
const W = 560;
const H = 120;
const PAD = 8;

function fmtHour(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const h = d.getUTCHours();
  return `${h}時`;
}

export default function TodayTrendsPane({
  eventMs,
  dayStartMs,
}: {
  eventMs: number[];
  dayStartMs: number;
}) {
  const slots = useMemo(
    () => bucketEventsToSlots(eventMs, dayStartMs, SLOT_MS, SLOT_COUNT),
    [eventMs, dayStartMs],
  );
  const total = useMemo(() => slots.reduce((a, s) => a + s.count, 0), [slots]);
  const max = Math.max(1, ...slots.map((s) => s.count));
  const points = slots
    .map((s, i) => {
      const x = PAD + (i / Math.max(1, SLOT_COUNT - 1)) * (W - PAD * 2);
      const y = H - PAD - (s.count / max) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div
      className="custom-import-section"
      data-testid="trends-pane"
      style={{
        marginBottom: '20px',
        padding: '16px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-surface)',
      }}
    >
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        本日の推移（全曲合計 {total}プレイ・30分単位）
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        data-testid="trends-chart"
        style={{ display: 'block' }}
        role="img"
        aria-label={`本日のプレイ推移 合計${total}回`}
      >
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
        />
        {[0, 12, 24, 36, 47].map((i) => (
          <text
            key={i}
            x={PAD + (i / (SLOT_COUNT - 1)) * (W - PAD * 2)}
            y={H - 1}
            fontSize="9"
            fill="var(--text-muted)"
            textAnchor="middle"
          >
            {fmtHour(dayStartMs + i * SLOT_MS)}
          </text>
        ))}
      </svg>
    </div>
  );
}
