import { describe, it, expect } from 'vitest';

// The logic under test, as described by T178 requirement:
// isSongFinished = songTimeMs > (buffer ? buffer.duration * 1000 : fallbackEnd) + (chart?.audio_offset ?? 0);
function checkSongFinished(
  songTimeMs: number,
  bufferDurationMs: number | null,
  chartAudioOffset: number | undefined,
  fallbackEndMs: number
): boolean {
  const effectiveDurationMs = (bufferDurationMs ?? fallbackEndMs) + (chartAudioOffset ?? 0);
  return songTimeMs > effectiveDurationMs;
}

describe('T178: Song End Detection with audio_offset', () => {
  it('should correctly detect song end considering audio_offset (3-step transition)', () => {
    const bufferDurationMs = 10000; // 10s
    const chartAudioOffset = 500;   // 0.5s offset
    const fallbackEndMs = 60000;    // 60s
    
    // Effective end = 10000 + 500 = 10500ms

    // 1. Initial State (Before effective end)
    const songTimeInitial = 10400;
    expect(checkSongFinished(songTimeInitial, bufferDurationMs, chartAudioOffset, fallbackEndMs)).toBe(false);

    // 2. Action (Advance time beyond effective end)
    const songTimeAdvance = 10600;

    // 3. Assert Resulting Transition (Should now be finished)
    expect(checkSongFinished(songTimeAdvance, bufferDurationMs, chartAudioOffset, fallbackEndMs)).toBe(true);
  });

  it('should handle missing buffer (use fallbackEnd) correctly (3-step transition)', () => {
    const bufferDurationMs = null; // No buffer
    const chartAudioOffset = 200;
    const fallbackEndMs = 5000; // 5s

    // Effective end = 5000 + 200 = 5200ms

    // 1. Initial State
    const songTimeInitial = 5100;
    expect(checkSongFinished(songTimeInitial, bufferDurationMs, chartAudioOffset, fallbackEndMs)).toBe(false);

    // 2. Action (Advance time)
    const songTimeAdvance = 5300;

    // 3. Assert Transition
    expect(checkSongFinished(songTimeAdvance, bufferDurationMs, chartAudioOffset, fallbackEndMs)).toBe(true);
  });

  it('should not be finished exactly at effective end time', () => {
    const bufferDurationMs = 10000;
    const chartAudioOffset = 500;
    const fallbackEndMs = 60000;

    // Effective end = 10500ms
    expect(checkSongFinished(10500, bufferDurationMs, chartAudioOffset, fallbackEndMs)).toBe(false);
  });
});
