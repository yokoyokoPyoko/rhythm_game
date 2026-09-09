export interface Segment { direction: 'up' | 'down' | 'stay'; beats: number; }
export type EasingType = 'linear' | 'ease-out' | 'ease-in';
export interface BpmChange { beat: number; bpm: number; amplitude?: number; zoom?: number; easeToNext?: 'linear' | 'ease-out' | 'ease-in'; }
export interface RingDef {
  beat: number;
  duration?: number;
  type?: 'single' | 'hold';
}
export interface Chart {
  title: string; artist: string; audio: string;
  audio_offset: number;
  amplitude: number;
  start_position: number;
  end_beat?: number;
  bpm_changes: BpmChange[]; segments: Segment[]; rings: RingDef[];
}
export interface SongEntry {
  id: string; title: string; artist: string; chartPath: string; difficulty: number;
}
export interface RingState {
  id: number; spawnTime: number; hitTime: number; targetY: number;
  resolved: boolean; hit: boolean;
  type?: 'single' | 'hold';
  duration?: number;
  releaseTime?: number;
  holding?: boolean;
  holdCompleted?: boolean;
}
export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}
export type HitResult = 'great' | 'perfect' | 'good' | 'miss';
export type GameMode = 'select' | 'playing' | 'result' | 'editor' | 'calibration';
export interface HitJudgement { result: HitResult; errorMs: number; }
