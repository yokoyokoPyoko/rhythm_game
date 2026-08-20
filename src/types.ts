export interface Segment { direction: 'up' | 'down'; beats: number; }
export interface BpmChange { beat: number; bpm: number; }
export interface RingDef { beat: number; }
export interface Chart {
  title: string; artist: string; bpm: number; audio: string;
  audio_offset: number;
  scroll_speed: number;
  amplitude: number;
  bpm_changes: BpmChange[]; segments: Segment[]; rings: RingDef[];
}
export interface SongEntry {
  id: string; title: string; artist: string; chartPath: string; difficulty: number;
}
export interface RingState {
  id: number; spawnTime: number; hitTime: number; targetY: number;
  resolved: boolean; hit: boolean;
}
export type HitResult = 'perfect' | 'good' | 'miss';
export type GameMode = 'select' | 'playing' | 'result' | 'editor' | 'calibration';
export interface HitJudgement { result: HitResult; errorMs: number; }
