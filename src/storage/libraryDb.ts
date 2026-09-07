/**
 * T193 — Custom chart library IndexedDB foundation
 * DB: trace-wave-library
 * Stores:
 *   charts: key=id, value={id,title,artist,difficulty,toml,audioId,addedAt}
 *   audio:  key=id, value={id,name,mime,bytes}
 * bytes stored as-is (compressed file bytes), restore via decodeAudioData(bytes.slice(0))
 */

export const DB_NAME = 'trace-wave-library';
export const CHARTS_STORE = 'charts';
export const AUDIO_STORE = 'audio';
export const DB_VERSION = 1;

export interface StoredChart {
  id: string;
  title: string;
  artist: string;
  difficulty: number;
  toml: string;
  audioId: string | null;
  addedAt: number;
}

export interface StoredAudio {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let dbInstance: IDBDatabase | null = null;

function getIndexedDB(): IDBFactory {
  const g = globalThis as unknown as { indexedDB?: IDBFactory };
  if (g.indexedDB) return g.indexedDB;
  throw new Error('indexedDB not available');
}

export function openLibraryDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = getIndexedDB();
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHARTS_STORE)) {
        db.createObjectStore(CHARTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      // close handler resets cache if DB closed externally
      dbInstance.onclose = () => {
        dbInstance = null;
        dbPromise = null;
      };
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error ?? new Error('openLibraryDB failed'));
    req.onblocked = () => {
      // not fatal, still resolve when possible
    };
  });
  return dbPromise;
}

export function closeLibraryDB(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
  }
  dbInstance = null;
  dbPromise = null;
}

export async function deleteLibraryDB(): Promise<void> {
  closeLibraryDB();
  const idb = getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const req = idb.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// internal helper: run transaction
// ---------------------------------------------------------------------------
function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putOnce(storeName: string, value: unknown): Promise<void> {
  const db = await openLibraryDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const req = store.put(value as never);
  await requestToPromise(req);
  // ensure transaction commits
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isQuotaError(e: unknown): boolean {
  if (!e) return false;
  const err = e as { name?: string; code?: number; message?: string };
  if (err.name === 'QuotaExceededError') return true;
  // DOMException code 22
  if (err.code === 22) return true;
  if (typeof err.message === 'string' && /QuotaExceeded/i.test(err.message)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CHARTS CRUD
// ---------------------------------------------------------------------------
export async function putChart(entry: StoredChart): Promise<void> {
  // validate minimal
  if (!entry || typeof entry.id !== 'string' || !entry.id) {
    throw new Error('putChart: id is required');
  }
  const toStore: StoredChart = {
    id: entry.id,
    title: entry.title ?? '',
    artist: entry.artist ?? '',
    difficulty: entry.difficulty ?? 1,
    toml: entry.toml ?? '',
    audioId: entry.audioId ?? null,
    addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
  };
  try {
    await putOnce(CHARTS_STORE, toStore);
  } catch (e) {
    if (isQuotaError(e)) {
      // oldest-first eviction retry
      const all = await listCharts();
      if (all.length === 0) throw e;
      // sort by addedAt ascending (oldest first)
      const sorted = [...all].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
      // delete oldest one and retry once (recursive handles further quota)
      await deleteChart(sorted[0].id);
      // notify via console.warn as spec "エラー通知"
      try {
        console.warn('[libraryDb] QuotaExceededError: evicted oldest chart', sorted[0].id);
      } catch {
        /* ignore */
      }
      await putChart(toStore);
      return;
    }
    throw e;
  }
}

export async function getChart(id: string): Promise<StoredChart | undefined> {
  const db = await openLibraryDB();
  const tx = db.transaction(CHARTS_STORE, 'readonly');
  const store = tx.objectStore(CHARTS_STORE);
  const req = store.get(id);
  const result = await requestToPromise<StoredChart | undefined>(req as unknown as IDBRequest<StoredChart | undefined>);
  return result ?? undefined;
}

export async function listCharts(): Promise<StoredChart[]> {
  const db = await openLibraryDB();
  const tx = db.transaction(CHARTS_STORE, 'readonly');
  const store = tx.objectStore(CHARTS_STORE);
  const req = store.getAll();
  const result = await requestToPromise<StoredChart[]>(req as unknown as IDBRequest<StoredChart[]>);
  return result ?? [];
}

export async function deleteChart(id: string): Promise<void> {
  const db = await openLibraryDB();
  const tx = db.transaction(CHARTS_STORE, 'readwrite');
  const store = tx.objectStore(CHARTS_STORE);
  const req = store.delete(id);
  await requestToPromise(req);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// AUDIO CRUD
// ---------------------------------------------------------------------------
export async function putAudio(entry: StoredAudio): Promise<void> {
  if (!entry || typeof entry.id !== 'string' || !entry.id) {
    throw new Error('putAudio: id is required');
  }
  // ensure bytes is Uint8Array (clone for safety)
  let bytes = entry.bytes;
  if (bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(bytes);
  } else if (!(bytes instanceof Uint8Array)) {
    // if plain number[] etc, convert
    const maybe = entry.bytes as unknown as { buffer?: ArrayBuffer; byteLength?: number };
    if (maybe && typeof maybe.byteLength === 'number') {
      bytes = new Uint8Array(maybe as unknown as ArrayBuffer);
    } else {
      throw new Error('putAudio: bytes must be Uint8Array or ArrayBuffer');
    }
  }
  // store a copy to ensure immutability
  const clone = new Uint8Array(bytes as Uint8Array);
  const toStore: StoredAudio = {
    id: entry.id,
    name: entry.name ?? '',
    mime: entry.mime ?? 'application/octet-stream',
    bytes: clone,
  };
  try {
    await putOnce(AUDIO_STORE, toStore);
  } catch (e) {
    if (isQuotaError(e)) {
      const allCharts = await listCharts();
      const allAudio = await listAudio();
      // Prefer evicting oldest chart+its audio if exists, else oldest audio
      if (allCharts.length > 0) {
        const sorted = [...allCharts].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
        const oldest = sorted[0];
        await deleteChart(oldest.id);
        if (oldest.audioId) {
          try {
            await deleteAudio(oldest.audioId);
          } catch {
            /* ignore */
          }
        }
        try {
          console.warn('[libraryDb] QuotaExceededError: evicted oldest chart for audio', oldest.id);
        } catch {
          /* ignore */
        }
        await putAudio(entry);
        return;
      }
      if (allAudio.length > 0) {
        // fallback: delete first audio
        await deleteAudio(allAudio[0].id);
        await putAudio(entry);
        return;
      }
      throw e;
    }
    throw e;
  }
}

export async function getAudio(id: string): Promise<StoredAudio | undefined> {
  const db = await openLibraryDB();
  const tx = db.transaction(AUDIO_STORE, 'readonly');
  const store = tx.objectStore(AUDIO_STORE);
  const req = store.get(id);
  const result = await requestToPromise<StoredAudio | undefined>(req as unknown as IDBRequest<StoredAudio | undefined>);
  if (!result) return undefined;
  // ensure bytes is Uint8Array and return a defensive copy note: stored bytes copy via slice
  let bytes = result.bytes;
  if (bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(bytes);
  } else if (!(bytes instanceof Uint8Array) && bytes && typeof (bytes as unknown as { byteLength: number }).byteLength === 'number') {
    // fake-indexeddb may store as plain object with buffer
    try {
      bytes = new Uint8Array(bytes as unknown as ArrayBuffer);
    } catch {
      // keep as is
    }
  }
  return { ...result, bytes: bytes as Uint8Array };
}

export async function listAudio(): Promise<StoredAudio[]> {
  const db = await openLibraryDB();
  const tx = db.transaction(AUDIO_STORE, 'readonly');
  const store = tx.objectStore(AUDIO_STORE);
  const req = store.getAll();
  const result = await requestToPromise<StoredAudio[]>(req as unknown as IDBRequest<StoredAudio[]>);
  return result ?? [];
}

export async function deleteAudio(id: string): Promise<void> {
  const db = await openLibraryDB();
  const tx = db.transaction(AUDIO_STORE, 'readwrite');
  const store = tx.objectStore(AUDIO_STORE);
  const req = store.delete(id);
  await requestToPromise(req);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function clearLibraryDB(): Promise<void> {
  const db = await openLibraryDB();
  const tx = db.transaction([CHARTS_STORE, AUDIO_STORE], 'readwrite');
  tx.objectStore(CHARTS_STORE).clear();
  tx.objectStore(AUDIO_STORE).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// helper to simulate bytes.slice(0) usage for decode
export function cloneBytesForDecode(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0);
}
