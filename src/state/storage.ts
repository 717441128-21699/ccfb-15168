// IndexedDB 持久化：对局记录、照片元数据、照片 Blob。
// 全部走 Promise 封装，页面只依赖这个模块，不直接碰 IDB。
import type { GameRecord, PhotoRecord, PhotoObservation, CellLabel, BoardSize } from '../core/types';

const DB_NAME = 'go-replay-db';
const DB_VERSION = 1;
const STORE_GAMES = 'games';
const STORE_PHOTOS = 'photos';
const STORE_BLOBS = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_GAMES)) db.createObjectStore(STORE_GAMES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putGame(game: GameRecord): Promise<void> {
  await tx(STORE_GAMES, 'readwrite', (s) => s.put(game));
}

export async function getGame(id: string): Promise<GameRecord | undefined> {
  return tx<GameRecord | undefined>(STORE_GAMES, 'readonly', (s) => s.get(id));
}

export async function listGames(): Promise<GameRecord[]> {
  const all = await tx<GameRecord[]>(STORE_GAMES, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteGame(id: string): Promise<void> {
  const photos = await listPhotos(id);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_GAMES, STORE_PHOTOS, STORE_BLOBS], 'readwrite');
    t.objectStore(STORE_GAMES).delete(id);
    for (const p of photos) {
      t.objectStore(STORE_PHOTOS).delete(p.id);
      t.objectStore(STORE_BLOBS).delete(p.blobKey);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function putPhoto(photo: PhotoRecord, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_PHOTOS, STORE_BLOBS], 'readwrite');
    t.objectStore(STORE_PHOTOS).put(photo);
    t.objectStore(STORE_BLOBS).put(blob, photo.blobKey);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function listPhotos(gameId: string): Promise<PhotoRecord[]> {
  const all = await tx<PhotoRecord[]>(STORE_PHOTOS, 'readonly', (s) => s.getAll());
  return all
    .filter((p) => p.gameId === gameId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPhotoBlob(blobKey: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(STORE_BLOBS, 'readonly', (s) => s.get(blobKey));
}

export async function updatePhotoObservation(
  photoId: string,
  observation: PhotoObservation,
): Promise<void> {
  const db = await openDb();
  const photo = await tx<PhotoRecord>(STORE_PHOTOS, 'readonly', (s) => s.get(photoId));
  if (!photo) return;
  photo.observation = observation;
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_PHOTOS, 'readwrite');
    t.objectStore(STORE_PHOTOS).put(photo);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function saveOverrides(
  photoId: string,
  overrides: Record<number, CellLabel>,
): Promise<void> {
  const db = await openDb();
  const photo = await tx<PhotoRecord>(STORE_PHOTOS, 'readonly', (s) => s.get(photoId));
  if (!photo) return;
  photo.overrides = overrides;
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_PHOTOS, 'readwrite');
    t.objectStore(STORE_PHOTOS).put(photo);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createGame(name: string, size: BoardSize, komi = 7.5): GameRecord {
  return {
    id: newId('game'),
    name,
    createdAt: Date.now(),
    boardSize: size,
    moves: [],
    initialStones: new Array(size * size).fill(0),
    photoIds: [],
    komi,
  };
}
