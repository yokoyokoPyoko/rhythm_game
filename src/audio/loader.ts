import { AudioCache, getBasename } from './AudioCache'

export async function loadAudio(url: string, audioCtx: AudioContext): Promise<AudioBuffer | null> {
  const base = getBasename(url)
  if (AudioCache.has(base)) {
    return AudioCache.get(base)!
  }
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[audio] failed to fetch ${url}: ${res.status} ${res.statusText}`)
      const sampleRate = audioCtx.sampleRate || 44100
      const buf = audioCtx.createBuffer(2, sampleRate * 2, sampleRate)
      AudioCache.set(base, buf)
      return buf
    }
    const arrayBuffer = await res.arrayBuffer()
    const buf = await audioCtx.decodeAudioData(arrayBuffer)
    AudioCache.set(base, buf)
    return buf
  } catch (err) {
    console.warn(`[audio] failed to load ${url}, falling back to silent buffer`, err)
    try {
      const sampleRate = audioCtx.sampleRate || 44100
      const buf = audioCtx.createBuffer(2, sampleRate * 2, sampleRate)
      AudioCache.set(base, buf)
      return buf
    } catch {
      return null
    }
  }
}

export async function loadAudioFromFile(file: File, audioCtx: AudioContext): Promise<AudioBuffer | null> {
  try {
    const arrayBuffer = await file.arrayBuffer()
    const buf = await audioCtx.decodeAudioData(arrayBuffer)
    AudioCache.set(file.name, buf)
    return buf
  } catch (err) {
    console.warn(`[audio] failed to decode local file ${file.name}, falling back to silent buffer`, err)
    try {
      const sampleRate = audioCtx.sampleRate || 44100
      const buf = audioCtx.createBuffer(2, sampleRate * 2, sampleRate)
      AudioCache.set(file.name, buf)
      return buf
    } catch {
      return null
    }
  }
}
