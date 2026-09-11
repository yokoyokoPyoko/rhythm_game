import { useMemo, useState } from 'react'
import { bucketEventsToSlots, type PlayEvent } from '../storage/playCounts'

const SLOT_MS = 60 * 1000;
const SLOT_COUNT = 24 * 60; // 1 day in 1-minute slots
const W = 560;
const H = 150;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 16;

const LINE_COLORS = ['#6366f1', '#22d3ee', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185', '#94a3b8'];

function fmtHour(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const h = d.getUTCHours();
  return `${h}時`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export default function TodayTrendsPane({
  events,
  dayStartMs,
}: {
  events: PlayEvent[];
  dayStartMs: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const songs = useMemo(() => {
    const order: string[] = [];
    for (const e of events) {
      if (e && typeof e.song_id === 'string' && !order.includes(e.song_id)) {
        order.push(e.song_id);
      }
    }
    return order;
  }, [events]);

  const series = useMemo(
    () =>
      songs.map((song) => {
        const ms = events
          .filter((e) => e.song_id === song)
          .map((e) => Date.parse(e.played_at))
          .filter((t) => Number.isFinite(t));
        return { song, slots: bucketEventsToSlots(ms, dayStartMs, SLOT_MS, SLOT_COUNT) };
      }),
    [songs, events, dayStartMs],
  );

  const total = useMemo(
    () => series.reduce((a, s) => a + s.slots.reduce((x, r) => x + r.count, 0), 0),
    [series],
  );
  const max = Math.max(1, ...series.flatMap((s) => s.slots.map((r) => r.count)));
  const mid = Math.ceil(max / 2);
  const xOf = (i: number) => PAD_L + (i / Math.max(1, SLOT_COUNT - 1)) * (W - PAD_L - PAD_R);
  const yOf = (c: number) => H - PAD_B - (c / max) * (H - PAD_T - PAD_B);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
    const idx = Math.round(((px - PAD_L) / Math.max(1, W - PAD_L - PAD_R)) * (SLOT_COUNT - 1));
    setHoverIdx(Math.max(0, Math.min(SLOT_COUNT - 1, idx)));
  };

  const hoverSlotMs = hoverIdx !== null ? dayStartMs + hoverIdx * SLOT_MS : 0;

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
        本日の推移（全曲合計 {total}プレイ・1分単位）
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '8px' }}>
        {series.map((s, si) => (
          <span key={s.song} style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '3px',
                background: LINE_COLORS[si % LINE_COLORS.length],
                marginRight: '4px',
                verticalAlign: 'middle',
              }}
            />
            {s.song}（{s.slots.reduce((a, r) => a + r.count, 0)}）
          </span>
        ))}
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        data-testid="trends-chart"
        style={{ display: 'block' }}
        role="img"
        aria-label={`本日のプレイ推移 合計${total}回`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, mid, max].map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yOf(v)} y2={yOf(v)} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
            <text x={PAD_L - 4} y={yOf(v) + 3} fontSize="9" fill="var(--text-muted)" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {series.map((s, si) => (
          <polyline
            key={s.song}
            points={s.slots.map((r, i) => `${xOf(i).toFixed(1)},${yOf(r.count).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={LINE_COLORS[si % LINE_COLORS.length]}
            strokeWidth="2"
          />
        ))}
        {[0, 6 * 60, 12 * 60, 18 * 60, 24 * 60 - 1].map((i) => (
          <text
            key={i}
            x={xOf(Math.min(i, SLOT_COUNT - 1))}
            y={H - 3}
            fontSize="9"
            fill="var(--text-muted)"
            textAnchor="middle"
          >
            {fmtHour(dayStartMs + i * SLOT_MS)}
          </text>
        ))}
        {hoverIdx !== null && (
          <g data-testid="trends-tooltip">
            <line
              x1={xOf(hoverIdx)}
              x2={xOf(hoverIdx)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke="rgba(255,255,255,0.4)"
              strokeWidth="1"
            />
            <rect
              x={Math.min(xOf(hoverIdx) + 6, W - 150)}
              y={PAD_T}
              width="144"
              height={14 + series.length * 12}
              fill="rgba(10,10,10,0.9)"
              stroke="var(--border)"
              rx="4"
            />
            <text x={Math.min(xOf(hoverIdx) + 12, W - 144)} y={PAD_T + 12} fontSize="10" fill="var(--text)">
              {fmtTime(hoverSlotMs)}
            </text>
            {series.map((s, si) => (
              <text
                key={s.song}
                x={Math.min(xOf(hoverIdx) + 12, W - 144)}
                y={PAD_T + 24 + si * 12}
                fontSize="10"
                fill={LINE_COLORS[si % LINE_COLORS.length]}
              >
                {s.song.slice(0, 10)}: {s.slots[hoverIdx].count}
              </text>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}
