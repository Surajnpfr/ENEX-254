/**
 * IndexedDB — multi-user local database for EM exam prep.
 * Stores: meta, users, progress
 */

const DB_NAME = 'em-exam-prep-db';
const DB_VERSION = 1;
const LEGACY_LS_KEY = 'em-exam-prep-v1';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'userId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createEmptyProgress(userId) {
  return {
    userId,
    version: 2,
    updatedAt: new Date().toISOString(),
    prefs: {
      examDate: null,
      studyHoursPerDay: 6,
      sleepHours: 7,
      breakMinutes: 10,
      focusMode: false,
    },
    topics: {},
    questions: {},
    mcqs: {},
    attempts: [],
    mistakes: [],
    revisions: {},
    sessions: [],
    mockHistory: [],
    planOverrides: {},
    planTasks: {}, // taskId -> { id, day, status, startedAt, completedAt, elapsedSeconds, title, ... }
    syllabus: {},
    daily: {},
  };
}

export function createLocalUser(name = 'Local Student') {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? `local_${crypto.randomUUID()}`
      : `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt: now,
    lastActiveAt: now,
  };
}

export async function getMeta(key) {
  const db = await openDb();
  return reqToPromise(db.transaction('meta', 'readonly').objectStore('meta').get(key));
}

export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

export async function getUser(userId) {
  const db = await openDb();
  return reqToPromise(db.transaction('users', 'readonly').objectStore('users').get(userId));
}

export async function putUser(user) {
  const db = await openDb();
  const tx = db.transaction('users', 'readwrite');
  tx.objectStore('users').put(user);
  await txDone(tx);
}

export async function listUsers() {
  const db = await openDb();
  return reqToPromise(db.transaction('users', 'readonly').objectStore('users').getAll());
}

export async function getProgress(userId) {
  const db = await openDb();
  return reqToPromise(db.transaction('progress', 'readonly').objectStore('progress').get(userId));
}

/**
 * Atomic write of full progress document for one user.
 */
export async function putProgress(progress) {
  if (!progress?.userId) throw new Error('progress.userId required');
  const db = await openDb();
  const doc = {
    ...progress,
    userId: progress.userId,
    updatedAt: new Date().toISOString(),
  };
  const tx = db.transaction('progress', 'readwrite');
  tx.objectStore('progress').put(doc);
  await txDone(tx);
  return doc;
}

/**
 * Atomic reset: replace progress with empty shell; keep user identity.
 * Optionally stores a short-lived pre_reset_snapshot in meta.
 */
export async function resetProgressAtomic(userId, { backup = true } = {}) {
  if (!userId) throw new Error('userId required');
  const db = await openDb();
  const tx = db.transaction(['progress', 'meta', 'users'], 'readwrite');
  const progressStore = tx.objectStore('progress');
  const metaStore = tx.objectStore('meta');
  const usersStore = tx.objectStore('users');

  const existing = await reqToPromise(progressStore.get(userId));
  if (backup && existing) {
    metaStore.put({
      key: `pre_reset_snapshot_${userId}`,
      value: {
        at: new Date().toISOString(),
        progress: existing,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  }

  const fresh = createEmptyProgress(userId);
  // Preserve prefs (exam date / study hours) — not learning progress
  if (existing?.prefs) {
    fresh.prefs = { ...fresh.prefs, ...existing.prefs };
  }
  progressStore.put(fresh);

  const user = await reqToPromise(usersStore.get(userId));
  if (user) {
    user.lastActiveAt = new Date().toISOString();
    usersStore.put(user);
  }

  await txDone(tx);
  return fresh;
}

/**
 * Bootstrap: ensure active user + progress. Migrate legacy localStorage once.
 */
export async function bootstrapLocalUser() {
  await openDb();

  let activeUserId = (await getMeta('activeUserId'))?.value || null;
  let user = activeUserId ? await getUser(activeUserId) : null;

  if (!user) {
    user = createLocalUser();
    await putUser(user);
    await setMeta('activeUserId', user.id);
    activeUserId = user.id;
  } else {
    user.lastActiveAt = new Date().toISOString();
    await putUser(user);
    if ((await getMeta('activeUserId'))?.value !== user.id) {
      await setMeta('activeUserId', user.id);
    }
  }

  let progress = await getProgress(user.id);
  if (!progress) {
    // One-time migration from legacy localStorage
    let migrated = null;
    try {
      const raw = localStorage.getItem(LEGACY_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        migrated = {
          ...createEmptyProgress(user.id),
          ...parsed,
          userId: user.id,
          version: 2,
        };
        localStorage.setItem(`${LEGACY_LS_KEY}-migrated`, new Date().toISOString());
        // Keep legacy key as backup but stop using it as source of truth
      }
    } catch (e) {
      console.warn('Legacy migration skipped', e);
    }
    progress = migrated || createEmptyProgress(user.id);
    await putProgress(progress);
  }

  return { user, progress, activeUserId: user.id };
}

export async function exportProgressBundle(user, progress) {
  return {
    version: 2,
    kind: 'em-exam-progress',
    userId: user.id,
    userName: user.name,
    exportedAt: new Date().toISOString(),
    progress: {
      ...progress,
      userId: user.id,
    },
  };
}

export { LEGACY_LS_KEY, DB_NAME };
