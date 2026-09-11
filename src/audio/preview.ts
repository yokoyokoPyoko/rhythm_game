// Hover preview playback for the song select screen.
// Music only (no metronome), from buffer position 0, ignoring audio_offset.
// Volume is fixed at 1/5 of gameplay volume (game connects source directly,
// i.e. gain 1.0).

export const PREVIEW_VOLUME = 0.2;

export interface PreviewHandle {
  stop: () => void;
}

/**
 * Start preview playback. Returns a handle to stop it.
 * Does not throw on already-stopped sources.
 */
export function startPreview(
  buffer: AudioBuffer,
  ctx: AudioContext,
  volume: number = PREVIEW_VOLUME,
): PreviewHandle {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(ctx.currentTime, 0);
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        /* already stopped/ended */
      }
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}
