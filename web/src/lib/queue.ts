/**
 * Client half of the offline capture queue. The service worker owns flushing;
 * this owns enqueueing and reporting depth to the UI.
 */

const DB_NAME = 'planner-queue';
const STORE = 'captures';

export interface QueuedCapture {
  id: string;
  text: string;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function enqueueCapture(text: string): Promise<QueuedCapture> {
  const db = await open();
  const item: QueuedCapture = {
    id: crypto.randomUUID(),
    text,
    createdAt: Date.now(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await requestFlush();
  return item;
}

export async function queueDepth(): Promise<number> {
  try {
    const db = await open();
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

/**
 * Prefers Background Sync — it fires even if the app has been closed — and
 * falls back to nudging the active worker where Background Sync is missing
 * (notably Safari, which is what iOS runs).
 */
export async function requestFlush(): Promise<void> {
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (!registration) return;

  const sync = (registration as ServiceWorkerRegistration & {
    sync?: { register(tag: string): Promise<void> };
  }).sync;

  if (sync) {
    try {
      await sync.register('planner-captures');
      return;
    } catch {
      /* fall through to the message-based nudge */
    }
  }

  registration.active?.postMessage({ type: 'flush-queue' });
}
