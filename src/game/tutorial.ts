import type { Chart } from '../types';

/**
 * T211 — チュートリアルの2段階・押下確認式への刷新
 *
 * ステージA（波形練習）: BPM90, stay 1 + up 1 + down 1 + up 1 + down 1 (5拍), リングなし
 * ステージB（リング練習）: BPM90, stay 波形 + リング4個 (1拍おとずつ)
 * 両ステージともキー押下で練習開始（待機中は時計を進めない）
 */

export type TutorialStage = 'wave' | 'ring';
export const TUTORIAL_BPM = 90;
const TUTORIAL_BEATS_A = 5; // wave practice: 1 + 1 + 1 + 1 + 1
const TUTORIAL_BEATS_B = 6; // ring practice: 4 rings + 2拍余剰

interface TutorialInstruction {
  beat: number;
  text: string;
}

const WAVE_INSTRUCTIONS: TutorialInstruction[] = [
  { beat: 0, text: '↑ ↓ キーで波形に沿って移動しよう' },
  { beat: TUTORIAL_BEATS_A, text: 'おつかれさま！次はリングを叩く練習だよ' },
];

const RING_INSTRUCTIONS: TutorialInstruction[] = [
  { beat: 0, text: 'Space キーでリングを叩こう！' },
];

function lookupInstruction(instructions: TutorialInstruction[], beat: number): string {
  const b = Number.isFinite(beat) ? beat : 0;
  let current = instructions[0];
  for (const entry of instructions) {
    if (b >= entry.beat) current = entry;
    else break;
  }
  return current.text;
}

export function getTutorialInstruction(beat: number, stage: TutorialStage): string {
  if (stage === 'ring') return lookupInstruction(RING_INSTRUCTIONS, beat);
  return lookupInstruction(WAVE_INSTRUCTIONS, beat);
}

/** ステージA: 波形練習 (stay 1 + up 1 + down 1 + up 1 + down 1 = 5拍、リングなし。
 * 開始位置は下端(-1.0): 下から上へ動かす練習になる) */
export function generateWavePracticeChart(): Chart {
  return {
    title: 'チュートリアル - 波形練習',
    artist: '',
    audio: '',
    audio_offset: 0,
    amplitude: 1.0,
    start_position: -1.0,
    bpm_changes: [{ beat: 0, bpm: TUTORIAL_BPM }],
    segments: [
      { direction: 'stay', beats: 1 },
      { direction: 'up', beats: 1 },
      { direction: 'down', beats: 1 },
      { direction: 'up', beats: 1 },
      { direction: 'down', beats: 1 },
    ],
    rings: [],
  };
}

/** ステージB: リング練習 (stay 波形 + リング4個を1拍おとずつ) */
export function generateRingPracticeChart(): Chart {
  return {
    title: 'チュートリアル - リング練習',
    artist: '',
    audio: '',
    audio_offset: 0,
    amplitude: 1.0,
    start_position: 0.0,
    bpm_changes: [{ beat: 0, bpm: TUTORIAL_BPM }],
    segments: [
      { direction: 'stay', beats: TUTORIAL_BEATS_B },
    ],
    rings: [
      { beat: 1, type: 'single' },
      { beat: 2, type: 'single' },
      { beat: 3, type: 'single' },
      { beat: 4, type: 'single' },
    ],
  };
}
