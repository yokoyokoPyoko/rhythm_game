import type { Chart } from '../types';
import { chartToToml } from './serialize';
import { parseChartText } from './loader';

export const AUTOSAVE_PREFIX = 'rhythmEditorAutosave::';
export const PREFIX = AUTOSAVE_PREFIX;
export const AUTOSAVE_INTERVAL_KEY = 'rhythmEditorAutosaveInterval';
export const INTERVAL_KEY = AUTOSAVE_INTERVAL_KEY;
export const AUTOSAVE_MAX = 10;
export const DEFAULT_AUTOSAVE_INTERVAL = 3;

export interface AutosaveSlot {
  slug: string;
  title: string;
  savedAt: number;
}

const slugify = (str: string): string => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
};

const keyFor = (slug: string): string => `${AUTOSAVE_PREFIX}${slug}`;

function readSlotRaw(slug: string): { toml: string; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(keyFor(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { toml?: string; savedAt?: number };
    if (typeof parsed.toml !== 'string' || typeof parsed.savedAt !== 'number') return null;
    return { toml: parsed.toml, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

function titleFromToml(toml: string, fallback: string): string {
  const m = toml.match(/^title\s*=\s*"([^"]+)"/m);
  return m ? m[1] : fallback;
}

export function saveAutosave(chart: Chart): { slug: string; savedAt: number } {
  const slug = slugify(chart.title) || 'untitled';
  const normalized: Chart = { ...chart, title: chart.title.trim() || 'Untitled' };
  const toml = chartToToml(normalized);
  const savedAt = Date.now();
  localStorage.setItem(keyFor(slug), JSON.stringify({ toml, savedAt }));
  enforceCap();
  return { slug, savedAt };
}
export const saveSlot = saveAutosave;

export function listAutosaves(): AutosaveSlot[] {
  const slots: AutosaveSlot[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(AUTOSAVE_PREFIX)) continue;
    const slug = key.slice(AUTOSAVE_PREFIX.length);
    const raw = readSlotRaw(slug);
    if (!raw) continue;
    const fallback = slug === 'untitled' ? '無題' : slug;
    slots.push({ slug, title: titleFromToml(raw.toml, fallback), savedAt: raw.savedAt });
  }
  slots.sort((a, b) => a.savedAt - b.savedAt);
  return slots;
}
export const getAutosaveList = listAutosaves;
export const listSlots = listAutosaves;

function enforceCap(): void {
  const slots = listAutosaves();
  if (slots.length <= AUTOSAVE_MAX) return;
  const excess = slots.length - AUTOSAVE_MAX;
  for (let i = 0; i < excess; i++) {
    deleteAutosave(slots[i].slug);
  }
}

export function loadAutosave(slug: string): Chart {
  const raw = readSlotRaw(slug);
  if (!raw) {
    throw new Error(`保存データが見つかりません: ${slug}`);
  }
  return parseChartText(raw.toml, slug);
}
export const getAutosave = loadAutosave;

export function deleteAutosave(slug: string): void {
  try {
    localStorage.removeItem(keyFor(slug));
  } catch {
    /* ignore */
  }
}
export const removeSlot = deleteAutosave;

export function getAutosaveInterval(): number {
  try {
    const raw = localStorage.getItem(AUTOSAVE_INTERVAL_KEY);
    if (raw === null) return DEFAULT_AUTOSAVE_INTERVAL;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_AUTOSAVE_INTERVAL;
    return Math.max(1, Math.min(5, n));
  } catch {
    return DEFAULT_AUTOSAVE_INTERVAL;
  }
}

export function setAutosaveInterval(n: number): void {
  const clamped = Math.max(1, Math.min(5, Number.isFinite(n) ? n : DEFAULT_AUTOSAVE_INTERVAL));
  try {
    localStorage.setItem(AUTOSAVE_INTERVAL_KEY, String(clamped));
  } catch {
    /* ignore */
  }
}
