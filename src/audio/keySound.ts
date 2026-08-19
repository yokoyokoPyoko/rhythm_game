import { AudioManager } from './AudioManager';

const KEY_SOUND_KEY = 'rhythmKeySound';

export function isKeySoundEnabled(): boolean {
  return localStorage.getItem(KEY_SOUND_KEY) !== '0';
}

export function setKeySoundEnabled(enabled: boolean): void {
  localStorage.setItem(KEY_SOUND_KEY, enabled ? '1' : '0');
}

export function playKeyClick(): void {
  const audioMgr = AudioManager.getInstance();
  let ctx: AudioContext;
  try {
    ctx = audioMgr.ctx;
  } catch {
    return;
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  const duration = 0.03;

  osc.type = 'sine';
  osc.frequency.value = 1320;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.2, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration);
}