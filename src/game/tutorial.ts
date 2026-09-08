import type { Chart } from '../types';

/**
 * T210 — パブリックモード限定・譜面開始前チュートリアル（自動進行＋スキップ付き）
 *
 * 固定・コード生成のチュートリアル譜面。BPM120、メトロノームのみ（約 8 秒）。
 * 波形: stay 4拍 → up 2拍 → down 2拍 → stay 8拍
 * リング: beat 4 / 8 / 12（single）
 * 修了: 成否不問・最終リング + 2 秒で本編へ自動進行。
 */

export interface TutorialInstruction {
  beat: number;
  /** 拍連動の指示文（0 拍=移動説明 → 4/8 拍=Space → 12 拍=ねぎらい） */
  text: string;
}

export const TUTORIAL_INSTRUCTIONS: TutorialInstruction[] = [
  { beat: 0, text: '↑↓ キーで波形に沿って移動しよう' },
  { beat: 4, text: '波形に重ねて Space でリングを叩こう！' },
  { beat: 8, text: 'もう一度 Space でリングを叩こう！' },
  { beat: 12, text: 'お疲れさま！このリズムで本編に進むよ' },
];

/**
 * 拍位置に対応する指示文を返す（ステップ関数・オフグリッドでも安定）。
 * beat 以下の最新エントリの文言を採用。負値は先頭エントリ相当。
 */
export function getTutorialInstruction(beat: number): string {
  const b = Number.isFinite(beat) ? beat : 0;
  let current = TUTORIAL_INSTRUCTIONS[0];
  for (const entry of TUTORIAL_INSTRUCTIONS) {
    if (b >= entry.beat) {
      current = entry;
    } else {
      break;
    }
  }
  return current.text;
}

export function generateTutorialChart(): Chart {
  return {
    title: 'チュートリアル',
    artist: '',
    audio: '',
    audio_offset: 0,
    amplitude: 1.0,
    start_position: 0.0,
    bpm_changes: [{ beat: 0, bpm: 120 }],
    segments: [
      { direction: 'stay', beats: 4 },
      { direction: 'up', beats: 2 },
      { direction: 'down', beats: 2 },
      { direction: 'stay', beats: 8 },
    ],
    rings: [
      { beat: 4, type: 'single' },
      { beat: 8, type: 'single' },
      { beat: 12, type: 'single' },
    ],
  };
}