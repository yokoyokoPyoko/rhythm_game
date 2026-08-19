export async function loadAudio(url: string, audioCtx: AudioContext): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[audio] failed to fetch ${url}: ${res.status} ${res.statusText}`);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    console.warn(`[audio] failed to load ${url}`, err);
    return null;
  }
}