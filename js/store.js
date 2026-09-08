/**
 * Progress service — per-user state helpers + persistence via IndexedDB.
 * UI holds an in-memory copy; LocalDB is source of truth after each save.
 */

import {
  bootstrapLocalUser,
  putProgress,
  resetProgressAtomic,
  exportProgressBundle,
  createEmptyProgress,
  putUser,
  getUser,
} from './db.js';

let currentUser = null;

export function getCurrentUser() {
  return currentUser;
}

export function defaultState(userId = currentUser?.id) {
  return createEmptyProgress(userId || 'local_pending');
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Async boot: load (or create) local user + progress from IndexedDB.
 */
export async function initStore() {
  const { user, progress } = await bootstrapLocalUser();
  currentUser = user;
  const state = deepMerge(defaultState(user.id), progress);
  state.userId = user.id;
  return { user, state };
}

/**
 * Persist current user's progress. Must include userId.
 * Returns only after IndexedDB commit succeeds.
 */
export async function saveState(state) {
  if (!currentUser?.id) throw new Error('No active local user');
  const userId = currentUser.id;
  const doc = {
    ...state,
    userId,
    updatedAt: new Date().toISOString(),
  };
  await putProgress(doc);
  currentUser.lastActiveAt = doc.updatedAt;
  await putUser(currentUser);
  return doc;
}

/** @deprecated sync load — use initStore(). Kept for safety. */
export function loadState() {
  return defaultState(currentUser?.id);
}

export function exportState(state, user = currentUser) {
  return JSON.stringify(
    {
      version: 2,
      kind: 'em-exam-progress',
      userId: user?.id || state.userId,
      userName: user?.name || 'Local Student',
      exportedAt: new Date().toISOString(),
      progress: { ...state, userId: user?.id || state.userId },
    },
    null,
    2
  );
}

/**
 * Parse import JSON into a progress document for the CURRENT user
 * (keeps identity; replaces learning data).
 */
export function parseImportProgress(jsonText, userId = currentUser?.id) {
  const data = JSON.parse(jsonText);
  if (!data || typeof data !== 'object') throw new Error('Invalid export file');
  const payload = data.progress && typeof data.progress === 'object' ? data.progress : data;
  if (data.kind && data.kind !== 'em-exam-progress') {
    throw new Error('Not an EM exam progress export');
  }
  const merged = deepMerge(defaultState(userId), payload);
  merged.userId = userId;
  merged.updatedAt = new Date().toISOString();
  return merged;
}

/** @deprecated — prefer parseImportProgress + saveState after confirm */
export function importState(jsonText) {
  return parseImportProgress(jsonText);
}

export async function resetCurrentUserProgress() {
  if (!currentUser?.id) throw new Error('No active local user');
  const fresh = await resetProgressAtomic(currentUser.id, { backup: true });
  return deepMerge(defaultState(currentUser.id), fresh);
}

export async function renameCurrentUser(name) {
  if (!currentUser) return;
  currentUser.name = String(name || 'Local Student').trim() || 'Local Student';
  currentUser.lastActiveAt = new Date().toISOString();
  await putUser(currentUser);
  return currentUser;
}

export function ensureTopic(state, topicId) {
  if (!state.topics[topicId]) {
    state.topics[topicId] = {
      mastery: 0,
      checklist: {},
      studiedMinutes: 0,
      lastStudied: null,
      status: 'not_started',
    };
  }
  return state.topics[topicId];
}

export function ensureQuestion(state, qid) {
  if (!state.questions[qid]) {
    state.questions[qid] = {
      attempted: false,
      correct: null,
      markedForRevision: false,
      lastAttempt: null,
    };
  }
  return state.questions[qid];
}

export function ensureMcq(state, mid) {
  if (!state.mcqs[mid]) {
    state.mcqs[mid] = { attempts: 0, correct: 0, last: null };
  }
  return state.mcqs[mid];
}

export function bumpDaily(state, patch = {}) {
  const key = new Date().toISOString().slice(0, 10);
  if (!state.daily) state.daily = {};
  if (!state.daily[key]) state.daily[key] = { topicsCovered: 0, questions: 0, mcqs: 0, minutes: 0, mistakesFixed: 0 };
  const d = state.daily[key];
  for (const [k, v] of Object.entries(patch)) d[k] = (d[k] || 0) + v;
  return d;
}

export { exportProgressBundle, getUser, createEmptyProgress };
