const audioCache = new Map<string, AudioBuffer>()

export const AudioCache = {
  set(basename: string, buffer: AudioBuffer) {
    audioCache.set(basename, buffer)
  },
  get(basename: string): AudioBuffer | undefined {
    return audioCache.get(basename)
  },
  has(basename: string): boolean {
    return audioCache.has(basename)
  },
  clear() {
    audioCache.clear()
  },
}

export function getBasename(pathOrName: string): string {
  if (!pathOrName) return ''
  const parts = pathOrName.split(/[/\\]/)
  return parts[parts.length - 1]
}
