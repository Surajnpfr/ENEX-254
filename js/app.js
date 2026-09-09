import {
  initStore,
  saveState,
  exportState,
  parseImportProgress,
  resetCurrentUserProgress,
  getCurrentUser,
  ensureTopic,
  ensureQuestion,
  ensureMcq,
  bumpDaily,
} from './store.js';
import {
  livePriority,
  getExamTiming,
  computeReadiness,
  buildFourDayPlan,
  summarizePlanDay,
  planTaskRoute,
  getNextBestStudyAction,
  scheduleRevision,
  getChapterStats,
  getAllChapterStats,
  filterChapterQuestions,
  getRecommendedChapter,
  questionsForChapter,
} from './engines.js';
import {
  ensureSyllabusTopic,
  evaluateSyllabusTopic,
  computeSyllabusCoverage,
  remainingWorkEstimate,
  getNextSyllabusGapAction,
} from './coverage.js';
import { renderMarkdown, typeset } from './markdown.js';
import {
  requestProgressConfirm,
  requestTypedConfirm,
  isProgressConfirmOpen,
  cancelProgressConfirm,
  cloneState,
} from './progressConfirm.js';

const app = {
  content: null,
  user: null,
  state: null,
  route: { name: 'dashboard', params: {} },
  searchHits: [],
  searchIndex: -1,
  mock: null,
  mcqSession: null,
  revision: null,
  chapterSession: null,
  planSession: null,
  planTimerId: null,
  focusTimer: null,
  persistQueue: Promise.resolve(),
};

async function persist() {
  if (!app.state || !app.user) return;
  app.state.userId = app.user.id;
  const job = app.persistQueue.then(async () => {
    await saveState(app.state);
    updateChrome();
  });
  app.persistQueue = job.catch((err) => {
    console.error('Persist failed', err);
    toast('Could not save progress — try again');
  });
  await app.persistQueue;
}

function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

function chapterOf(topicId) {
  const t = app.content.topics.find((x) => x.id === topicId);
  return app.content.chapters.find((c) => c.id === t?.chapterId);
}

function topicById(id) {
  return app.content.topics.find((t) => t.id === id);
}

function questionById(id) {
  return app.content.questions.find((q) => q.id === id);
}

function badge(level, withLabel = true) {
  const lv = String(level || 'P3').toUpperCase();
  const labels = { P1: 'CRITICAL', P2: 'HIGH', P3: 'MEDIUM', P4: 'LOW' };
  const text = withLabel ? `${lv} · ${labels[lv] || lv}` : lv;
  return `<span class="badge badge-${lv.toLowerCase()}">${text}</span>`;
}

function toast(message, { undo } = {}) {
  const host = $('#toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.appendChild(msg);
  if (typeof undo === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => {
      Promise.resolve(undo())
        .then(() => {
          el.remove();
          toast('Undone');
        })
        .catch((err) => {
          console.error(err);
          toast('Undo failed');
        });
    });
    el.appendChild(btn);
  }
  host.appendChild(el);
  setTimeout(() => el.remove(), undo ? 6000 : 2600);
}

/** Snapshot + confirm wrapper for official progress mutations */
function confirmProgressChange({
  action,
  itemName,
  title,
  bodyHtml,
  confirmLabel,
  effects = [],
  progressBars = [],
  successMessage = 'Progress updated',
  apply,
  onCancel,
}) {
  requestProgressConfirm({
    action,
    itemName,
    title,
    bodyHtml,
    confirmLabel,
    effects,
    progressBars,
    successMessage,
    snapshot: () => cloneState(app.state),
    apply: async () => {
      apply();
      await persist();
    },
    onUndo: async (snapshot) => {
      app.state = snapshot;
      await persist();
      render();
    },
    onSuccess: (msg, undo) => {
      toast(msg, {
        undo: undo
          ? async () => {
              await undo();
            }
          : undefined,
      });
    },
    onDone: () => {
      render();
    },
    onCancel,
    onError: () => {
      toast('Could not save progress — no changes kept');
      // If apply mutated then persist failed, reload from last good path is hard;
      // best-effort: re-bootstrap is overkill; undo snapshot unavailable after fail mid-apply.
    },
  });
}

function coveragePctNow() {
  if (!app.content?.syllabus) return 0;
  return Math.round(computeSyllabusCoverage(app.content, app.state).coveragePct || 0);
}

/** Run a mutation against a cloned state to preview coverage/mastery */
function withProjectedState(mutate) {
  const saved = app.state;
  app.state = cloneState(saved);
  try {
    mutate();
    return { coverage: coveragePctNow(), state: app.state };
  } finally {
    app.state = saved;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function emptyState(title, body, ctaLabel, ctaRoute) {
  return `<div class="card empty">
    <p class="empty-title">${escapeHtml(title)}</p>
    <p>${escapeHtml(body)}</p>
    ${ctaRoute ? `<button class="btn btn-primary" style="margin-top:16px" data-nav="${ctaRoute}">${escapeHtml(ctaLabel)}</button>` : ''}
  </div>`;
}

function metricCard(label, value, sub = '') {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(
    value
  )}</div>${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}

/* ---------------- Router ---------------- */
function parseHash() {
  const h = (location.hash || '#/dashboard').replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  const name = parts[0] || 'dashboard';
  if (name === 'topic' && parts[1]) return { name: 'topic', params: { id: parts[1], ...params } };
  if (name === 'focus' && parts[1]) return { name: 'focus', params: { id: parts[1] } };
  if (name === 'chapter' && parts[1]) {
    if (parts[2] === 'practice') return { name: 'chapterPractice', params: { id: parts[1], ...params } };
    return { name: 'chapter', params: { id: parts[1], ...params } };
  }
  if (name === 'plan') {
    if (parts[1] === 'session' && parts[2]) return { name: 'planSession', params: { id: parts[2], ...params } };
    return { name: 'plan', params };
  }
  if (name === 'coverage') {
    if (parts[1] === 'topic' && parts[2]) return { name: 'coverageTopic', params: { id: parts[2], ...params } };
    if (parts[1] === 'remaining') return { name: 'coverage', params: { view: 'remaining', ...params } };
    return { name: 'coverage', params };
  }
  if (name === 'formulas') return { name: 'formulas', params };
  if (name === 'questions' && (params.mode === 'chapters' || parts[1] === 'chapters')) {
    return { name: 'chapterList', params };
  }
  return { name, params };
}

function navigate(hash) {
  if (!hash.startsWith('#')) hash = '#/' + hash.replace(/^\//, '');
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  app.route = parseHash();
  render();
});

/* ---------------- Boot ---------------- */
async function boot() {
  try {
    const { user, state } = await initStore();
    app.user = user;
    app.state = state;
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="card"><h2>Could not open local database</h2><p class="muted">${escapeHtml(
      e.message
    )}</p><p>This app needs IndexedDB (try another browser, or disable private-mode restrictions).</p></div>`;
    return;
  }

  try {
    const res = await fetch('./data/content.json?v=14');
    if (!res.ok) throw new Error(`Failed to load content.json (${res.status})`);
    app.content = await res.json();
  } catch (e) {
    $('#view').innerHTML = `<div class="card"><h2>Content load failed</h2><p class="muted">${escapeHtml(
      e.message
    )}</p><p>Serve the <code>em-prep</code> folder over HTTP (not file://) so <code>data/content.json</code> can load. From repo root: <code>python -m http.server 8080</code> then open <code>/em-prep/</code>.</p></div>`;
    return;
  }
  // default exam date: +4 days if unset
  if (!app.state.prefs.examDate) {
    const d = new Date();
    d.setDate(d.getDate() + 4);
    d.setHours(10, 0, 0, 0);
    app.state.prefs.examDate = d.toISOString();
    await persist();
  }
  bindGlobal();
  app.route = parseHash();
  render();
}

function bindGlobal() {
  $('#btn-menu')?.addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
    $('#overlay').classList.toggle('open');
  });
  $('#overlay')?.addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    $('#overlay').classList.remove('open');
  });
  const navHandler = (btn) => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.route);
      $('#sidebar').classList.remove('open');
      $('#overlay').classList.remove('open');
    });
  };
  $all('.nav-btn').forEach(navHandler);
  $all('.bottom-nav button').forEach(navHandler);
  $('#btn-search')?.addEventListener('click', openSearch);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isProgressConfirmOpen()) {
        e.preventDefault();
        cancelProgressConfirm();
        return;
      }
      closeSearch();
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      openSearch();
    }
  });
  $('#search-input')?.addEventListener('input', onSearchInput);
  $('#search-input')?.addEventListener('keydown', onSearchKey);
}

function updateChrome() {
  if (!app.content) return;
  const timing = getExamTiming(app.state.prefs);
  const ready = computeReadiness(app.content, app.state);
  const el = $('#chrome-countdown');
  if (el) {
    el.innerHTML =
      timing.daysLeft === 0
        ? `<strong>EXAM</strong> DAY`
        : `<strong>${timing.daysLeft}</strong> DAY${timing.daysLeft === 1 ? '' : 'S'} LEFT`;
  }
  const dayEl = $('#chrome-day');
  if (dayEl) dayEl.textContent = `Day ${timing.prepDay}/4`;
  const readyEl = $('#sidebar-ready');
  if (readyEl) {
    try {
      const cov = computeSyllabusCoverage(app.content, app.state);
      readyEl.textContent = `Coverage ${cov.coveragePct}% · Mastery ${cov.masteryPct}%`;
    } catch {
      readyEl.textContent = `Readiness ${ready.readiness}%`;
    }
  }

  const immersive = app.route.name === 'focus' || (app.route.name === 'revision' && app.revision) || (app.route.name === 'mock' && app.mock && !app.mock.result);
  document.body.classList.toggle('focus-mode', immersive && (app.route.name === 'focus' || app.route.name === 'revision'));
  document.body.classList.toggle('mock-shell', app.route.name === 'mock' && !!app.mock);

  const routeRoot = app.route.name;
  const questionsActive = ['questions', 'chapterList', 'chapter', 'chapterPractice'].includes(routeRoot);
  const coverageActive = ['coverage', 'coverageTopic'].includes(routeRoot);
  $all('.nav-btn, .bottom-nav button').forEach((b) => {
    const route = (b.dataset.route || '').replace(/^#\/?/, '').split(/[/?]/)[0];
    const active =
      route === routeRoot ||
      (route === 'dashboard' && routeRoot === 'dashboard') ||
      (route === 'questions' && questionsActive) ||
      (route === 'coverage' && coverageActive);
    b.classList.toggle('active', active);
  });
  document.body.classList.toggle(
    'mock-shell',
    (app.route.name === 'mock' && !!app.mock) || (app.route.name === 'chapterPractice' && app.chapterSession && !app.chapterSession.result)
  );
}

/* ---------------- Render ---------------- */
async function render() {
  updateChrome();
  const view = $('#view');
  if (!view || !app.content) return;
  const map = {
    dashboard: viewDashboard,
    coverage: viewCoverage,
    coverageTopic: viewCoverageTopic,
    topics: viewTopics,
    topic: viewTopic,
    questions: viewQuestions,
    chapterList: viewChapterList,
    chapter: viewChapter,
    chapterPractice: viewChapterPractice,
    mcq: viewMcq,
    mistakes: viewMistakes,
    plan: viewPlan,
    planSession: viewPlanSession,
    revision: viewRevision,
    formulas: viewFormulas,
    mock: viewMock,
    progress: viewProgress,
    settings: viewSettings,
    focus: viewFocus,
  };
  const fn = map[app.route.name] || viewDashboard;
  try {
    view.innerHTML = fn();
    bindView();
    await typeset(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card"><h2>View error</h2><pre>${escapeHtml(e.stack || e.message)}</pre></div>`;
  }
}

function bindView() {
  $all('[data-nav]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.nav)));
  $all('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    if (action === 'toggle-check') {
      el.addEventListener('change', () => {
        const topicId = el.dataset.id;
        const idx = el.dataset.idx;
        const nextChecked = !!el.checked;
        // Revert until confirmed — no silent progress
        el.checked = !nextChecked;
        requestChecklistConfirm(topicId, idx, nextChecked, el);
      });
      return;
    }
    if (action === 'mistake-type') {
      el.addEventListener('change', () => {
        const m = app.state.mistakes.find((x) => x.id === el.dataset.id);
        if (m) {
          m.mistakeType = el.value;
          persist();
        }
      });
      return;
    }
    el.addEventListener('click', () => handleAction(action, el));
  });
  const importFile = $('#import-file');
  if (importFile && !importFile._bound) {
    importFile._bound = true;
    importFile.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseImportProgress(text, app.user.id);
        requestImportConfirm(parsed);
      } catch (err) {
        toast('Import failed: ' + err.message);
      }
    });
  }
}

function requestChecklistConfirm(topicId, idx, nextChecked, checkboxEl) {
  const t = topicById(topicId);
  const name = t?.title || 'Topic';
  const st = ensureTopic(app.state, topicId);
  const beforeMastery = st.mastery || 0;
  const beforeCov = coveragePctNow();
  const label = app.content.checklistTemplate[Number(idx)] || `Item ${idx}`;

  const projected = withProjectedState(() => {
    const s = ensureTopic(app.state, topicId);
    s.checklist[idx] = nextChecked;
    const done = Object.values(s.checklist).filter(Boolean).length;
    s.mastery = Math.max(s.mastery || 0, Math.round((done / app.content.checklistTemplate.length) * 100));
    s.status = done === app.content.checklistTemplate.length ? 'mastered' : 'in_progress';
  });

  confirmProgressChange({
    action: 'toggle-checklist',
    itemName: name,
    title: nextChecked ? 'Mark checklist item complete?' : 'Unmark checklist item?',
    bodyHtml: `You're about to ${nextChecked ? 'check' : 'uncheck'}: <strong>${escapeHtml(label)}</strong>`,
    confirmLabel: nextChecked ? 'Yes, mark complete' : 'Yes, unmark',
    effects: [
      `Topic mastery: ${beforeMastery}% → ${projected.state.topics[topicId]?.mastery ?? beforeMastery}%`,
      `Syllabus coverage: ${beforeCov}% → ${projected.coverage}%`,
    ],
    progressBars: [
      { label: 'Topic mastery', before: beforeMastery, after: projected.state.topics[topicId]?.mastery ?? beforeMastery },
      { label: 'Syllabus coverage', before: beforeCov, after: projected.coverage },
    ],
    successMessage: nextChecked ? 'Checklist updated' : 'Checklist unmarked',
    apply: () => {
      const s = ensureTopic(app.state, topicId);
      s.checklist[idx] = nextChecked;
      const done = Object.values(s.checklist).filter(Boolean).length;
      s.mastery = Math.max(s.mastery || 0, Math.round((done / app.content.checklistTemplate.length) * 100));
      s.status = done === app.content.checklistTemplate.length ? 'mastered' : done > 0 ? 'in_progress' : 'not_started';
      s.lastStudied = new Date().toISOString();
    },
    onCancel: () => {
      if (checkboxEl) checkboxEl.checked = !nextChecked;
    },
  });
}

function handleAction(action, el) {
  const id = el?.dataset?.id;
  switch (action) {
    case 'mark-mastered': {
      const t = topicById(id);
      const name = t?.title || 'Topic';
      const st = ensureTopic(app.state, id);
      const beforeMastery = st.mastery || 0;
      const beforeCov = coveragePctNow();
      const projected = withProjectedState(() => {
        const s = ensureTopic(app.state, id);
        s.mastery = 100;
        s.status = 'mastered';
        app.content.checklistTemplate.forEach((_, i) => {
          s.checklist[i] = true;
        });
      });
      confirmProgressChange({
        action: 'mark-mastered',
        itemName: name,
        successMessage: 'Topic marked mastered',
        effects: [
          `Topic progress: ${beforeMastery}% → 100%`,
          `All checklist items will be marked complete`,
          `Syllabus coverage: ${beforeCov}% → ${projected.coverage}%`,
        ],
        progressBars: [
          { label: name, before: beforeMastery, after: 100 },
          { label: 'Syllabus coverage', before: beforeCov, after: projected.coverage },
        ],
        apply: () => {
          const s = ensureTopic(app.state, id);
          s.mastery = 100;
          s.status = 'mastered';
          app.content.checklistTemplate.forEach((_, i) => {
            s.checklist[i] = true;
          });
          s.lastStudied = new Date().toISOString();
        },
      });
      break;
    }
    case 'toggle-check': {
      // Handled via change + confirmation in bindView
      break;
    }
    case 'reveal-solution': {
      const box = document.querySelector(`#sol-${CSS.escape(id)}`);
      if (box) box.classList.remove('hidden');
      typeset(box);
      break;
    }
    case 'q-correct':
    case 'q-wrong': {
      markQuestion(id, action === 'q-correct', el?.dataset?.mistake);
      break;
    }
    case 'start-chapter-practice': {
      startChapterPractice(el.dataset.chapter, el.dataset.mode || 'all', {
        count: el.dataset.count ? Number(el.dataset.count) : null,
        timed: el.dataset.timed === '1',
        status: el.dataset.status || 'all',
        difficulty: el.dataset.difficulty || 'all',
        topicId: el.dataset.topic || '',
      });
      break;
    }
    case 'chapter-reveal': {
      if (app.chapterSession) {
        app.chapterSession.revealed = true;
        render();
      }
      break;
    }
    case 'chapter-mark': {
      if (!app.chapterSession) return;
      const qid = app.chapterSession.order[app.chapterSession.index];
      const ok = el.dataset.correct === '1';
      markQuestion(qid, ok, 'concept gap', { fromChapterSession: true });
      break;
    }
    case 'chapter-next': {
      chapterSessionNext();
      break;
    }
    case 'chapter-exit': {
      app.chapterSession = null;
      const cid = el.dataset.chapter;
      navigate(cid ? `#/chapter/${cid}` : '#/questions?mode=chapters');
      break;
    }
    case 'dash-chapter-go': {
      const sel = $('#dash-chapter-select');
      if (sel?.value) navigate(`#/chapter/${sel.value}`);
      break;
    }
    case 'syl-mark-concept': {
      const syl = (app.content.syllabus?.topics || []).find((t) => t.id === id);
      const name = syl?.title || 'Syllabus topic';
      const st = ensureSyllabusTopic(app.state, id);
      if (st.conceptStudied) {
        toast('Concept already marked studied');
        break;
      }
      const beforeCov = coveragePctNow();
      const beforeEv = evaluateSyllabusTopic(syl, app.content, app.state);
      const projected = withProjectedState(() => {
        const s = ensureSyllabusTopic(app.state, id);
        s.conceptStudied = true;
        for (const sid of syl?.studyTopicIds || []) {
          const ts = ensureTopic(app.state, sid);
          ts.mastery = Math.max(ts.mastery || 0, 35);
          ts.status = ts.status === 'not_started' ? 'in_progress' : ts.status;
        }
      });
      const afterEv = evaluateSyllabusTopic(syl, app.content, projected.state);
      confirmProgressChange({
        action: 'mark-studied',
        itemName: name,
        successMessage: 'Concept marked studied',
        effects: [
          `Concept coverage: ${beforeEv.conceptProgress}% → ${afterEv.conceptProgress}%`,
          `Topic status may move to Studied`,
          `Syllabus coverage: ${beforeCov}% → ${projected.coverage}%`,
          `This topic may leave Remaining`,
        ],
        progressBars: [
          { label: 'Concept', before: beforeEv.conceptProgress, after: afterEv.conceptProgress },
          { label: 'Syllabus coverage', before: beforeCov, after: projected.coverage },
        ],
        apply: () => {
          const s = ensureSyllabusTopic(app.state, id);
          s.conceptStudied = true;
          s.conceptMarkedAt = new Date().toISOString();
          bumpDaily(app.state, { topicsCovered: 1 });
          for (const sid of syl?.studyTopicIds || []) {
            const ts = ensureTopic(app.state, sid);
            ts.mastery = Math.max(ts.mastery || 0, 35);
            ts.status = ts.status === 'not_started' ? 'in_progress' : ts.status;
            ts.lastStudied = s.conceptMarkedAt;
          }
        },
      });
      break;
    }
    case 'syl-mark-revised': {
      const syl = (app.content.syllabus?.topics || []).find((t) => t.id === id);
      const name = syl?.title || 'Syllabus topic';
      const st = ensureSyllabusTopic(app.state, id);
      if (st.revised) {
        toast('Revision already recorded');
        break;
      }
      const beforeCov = coveragePctNow();
      const beforeEv = evaluateSyllabusTopic(syl, app.content, app.state);
      const projected = withProjectedState(() => {
        ensureSyllabusTopic(app.state, id).revised = true;
      });
      const afterEv = evaluateSyllabusTopic(syl, app.content, projected.state);
      confirmProgressChange({
        action: 'complete-revision',
        itemName: name,
        successMessage: 'Revision recorded',
        effects: [
          `Revision: ${beforeEv.revisionProgress}% → ${afterEv.revisionProgress}%`,
          `Syllabus coverage: ${beforeCov}% → ${projected.coverage}%`,
        ],
        progressBars: [
          { label: 'Revision', before: beforeEv.revisionProgress, after: afterEv.revisionProgress },
          { label: 'Syllabus coverage', before: beforeCov, after: projected.coverage },
        ],
        apply: () => {
          const s = ensureSyllabusTopic(app.state, id);
          s.revised = true;
          s.revisedAt = new Date().toISOString();
        },
      });
      break;
    }
    case 'q-revise': {
      const qs = ensureQuestion(app.state, id);
      qs.markedForRevision = !qs.markedForRevision;
      persist();
      render();
      break;
    }
    case 'mcq-pick': {
      if (!app.mcqSession || app.mcqSession.locked) return;
      app.mcqSession.selected = Number(el.dataset.opt);
      render();
      break;
    }
    case 'mcq-submit':
      submitMcq();
      break;
    case 'mcq-next':
      nextMcq();
      break;
    case 'start-mcq':
      startMcq(el.dataset.mode || 'quick10');
      break;
    case 'mistake-resolve': {
      const m = app.state.mistakes.find((x) => x.id === id);
      if (!m || m.resolved) break;
      const q = questionById(m.questionId);
      const topic = q ? topicById(q.topicId) : null;
      confirmProgressChange({
        action: 'resolve-mistake',
        itemName: topic?.title || q?.text?.slice(0, 60) || 'Mistake',
        successMessage: 'Mistake marked resolved',
        effects: ['Removes this item from open mistakes', 'May improve mastery / needs-review status'],
        apply: () => {
          const mm = app.state.mistakes.find((x) => x.id === id);
          if (mm) mm.resolved = true;
          bumpDaily(app.state, { mistakesFixed: 1 });
        },
      });
      break;
    }
    case 'mistake-type': {
      const m = app.state.mistakes.find((x) => x.id === id);
      if (m) m.mistakeType = el.value || el.dataset.type;
      persist();
      break;
    }
    case 'rev-reveal':
      if (app.revision) app.revision.revealed = true;
      render();
      break;
    case 'rev-know':
    case 'rev-again':
      revisionAnswer(action === 'rev-know');
      break;
    case 'rev-prev':
      if (app.revision && app.revision.index > 0) {
        app.revision.index--;
        app.revision.revealed = false;
        render();
      }
      break;
    case 'rev-next':
      if (app.revision && app.revision.index < app.revision.cards.length - 1) {
        app.revision.index++;
        app.revision.revealed = false;
        render();
      }
      break;
    case 'start-revision':
      startRevision();
      break;
    case 'mock-start':
      startMock(Number(el.dataset.count) || 20);
      break;
    case 'mock-nav':
      if (app.mock) {
        app.mock.index = Number(el.dataset.idx);
        render();
      }
      break;
    case 'mock-answer':
      if (app.mock) {
        app.mock.answers[app.mock.order[app.mock.index]] = el.dataset.val;
        render();
      }
      break;
    case 'mock-flag':
      if (app.mock) {
        const qid = app.mock.order[app.mock.index];
        app.mock.flags[qid] = !app.mock.flags[qid];
        render();
      }
      break;
    case 'mock-submit':
      submitMock();
      break;
    case 'save-settings':
      saveSettings();
      break;
    case 'export':
      downloadExport();
      break;
    case 'import':
      $('#import-file')?.click();
      break;
    case 'download-formulas-pdf':
      downloadFormulasPdf(el?.dataset?.chapter || app.route.params.ch || 'all');
      break;
    case 'scroll-to': {
      const target = document.getElementById(el?.dataset?.target || '');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'reset-progress':
      openResetProgressDialog();
      break;
    case 'plan-start': {
      const task = findPlanTask(id);
      if (!task) {
        toast('Task not found');
        break;
      }
      startPlanSession(task);
      navigate(`#/plan/session/${encodeURIComponent(id)}`);
      break;
    }
    case 'plan-finish':
      requestFinishPlanTask(id);
      break;
    case 'plan-skip':
      requestSkipPlanTask(id);
      break;
    case 'plan-review': {
      const t = findPlanTask(id);
      navigate(planTaskRoute(t));
      break;
    }
    case 'plan-open-material': {
      const t = findPlanTask(id);
      navigate(planTaskRoute(t));
      break;
    }
    case 'plan-exit-session': {
      if (app.planSession) {
        const pt = ensurePlanTasks()[app.planSession.taskId];
        if (pt && pt.status !== 'completed') {
          pt.elapsedSeconds = app.planSession.elapsedSeconds;
          pt.status = 'in_progress';
        }
        stopPlanTimer();
        persist();
      }
      navigate(`#/plan?day=${el.dataset.day || 1}`);
      break;
    }
    case 'plan-timer-toggle': {
      if (app.planSession) {
        app.planSession.paused = !app.planSession.paused;
        render();
      }
      break;
    }
    case 'plan-timer-continue': {
      if (app.planSession) app.planSession.paused = false;
      toast('Keep studying — mark complete when you are done');
      break;
    }
    case 'toggle-focus-pref':
      app.state.prefs.focusMode = !app.state.prefs.focusMode;
      persist();
      render();
      break;
    case 'focus-tick':
      break;
    default:
      console.warn('Unknown action', action);
  }
}

function markQuestion(qid, correct, mistakeType, opts = {}) {
  const q = questionById(qid);
  if (!q) return;
  const qs = ensureQuestion(app.state, qid);
  qs.attempted = true;
  qs.correct = !!correct;
  qs.lastAttempt = new Date().toISOString();
  app.state.attempts.push({
    id: `a-${Date.now()}`,
    questionId: qid,
    correct: !!correct,
    timestamp: qs.lastAttempt,
    mistakeType: correct ? null : mistakeType || 'concept gap',
  });
  const st = ensureTopic(app.state, q.topicId);
  st.lastStudied = qs.lastAttempt;
  if (correct) {
    st.mastery = Math.min(100, (st.mastery || 0) + 4);
    scheduleRevision(app.state, qid, true);
    if (!opts.fromChapterSession) toast('✓ Correct');
  } else {
    st.mastery = Math.max(0, (st.mastery || 0) - 3);
    scheduleRevision(app.state, qid, false);
    app.state.mistakes.unshift({
      id: `m-${Date.now()}`,
      questionId: qid,
      topicId: q.topicId,
      userAnswer: '(self-marked incorrect)',
      correctAnswer: q.answer || '',
      explanation: q.solution?.slice(0, 500) || '',
      date: qs.lastAttempt,
      mistakeType: mistakeType || 'concept gap',
      resolved: false,
    });
    if (!opts.fromChapterSession) toast('Added to Mistake Book');
  }

  if (opts.fromChapterSession && app.chapterSession) {
    const sess = app.chapterSession;
    sess.answers[qid] = !!correct;
    sess.revealed = true;
    sess.graded = true;
    if (correct) sess.correctCount += 1;
    else sess.incorrectCount += 1;
    toast(correct ? '✓ Correct' : '✕ Incorrect · Mistake Book');
  }

  bumpDaily(app.state, { questions: 1 });
  persist();
  render();
}

function startChapterPractice(chapterId, mode = 'all', opts = {}) {
  const filters = {
    status: opts.status || (mode === 'unattempted' ? 'unattempted' : mode === 'incorrect' ? 'incorrect' : mode === 'revision' ? 'revision' : 'all'),
    difficulty: opts.difficulty || 'all',
    type: 'all',
    topicId: opts.topicId || '',
  };
  let list = filterChapterQuestions(app.content, app.state, chapterId, filters);
  if (mode === 'quick' || opts.count) {
    const n = opts.count || 10;
    list = [...list].sort(() => Math.random() - 0.5).slice(0, n);
  } else if (mode === 'exam') {
    list = [...list].sort(() => Math.random() - 0.5).slice(0, Math.min(15, list.length));
  }
  if (!list.length) {
    toast('No questions match this filter');
    return;
  }
  const minutes = opts.timed || mode === 'exam' ? Math.max(15, list.length * 3) : null;
  app.chapterSession = {
    chapterId,
    mode,
    order: list.map((q) => q.id),
    index: 0,
    revealed: false,
    graded: false,
    answers: {},
    correctCount: 0,
    incorrectCount: 0,
    endsAt: minutes ? Date.now() + minutes * 60000 : null,
    result: null,
  };
  navigate(`#/chapter/${chapterId}/practice`);
}

function chapterSessionNext() {
  const sess = app.chapterSession;
  if (!sess) return;
  if (!sess.graded) {
    toast('Mark correct or incorrect first');
    return;
  }
  if (sess.index >= sess.order.length - 1) {
    finishChapterSession();
    return;
  }
  sess.index += 1;
  sess.revealed = false;
  sess.graded = false;
  render();
}

function finishChapterSession() {
  const sess = app.chapterSession;
  if (!sess) return;
  const stats = getChapterStats(app.content, app.state, sess.chapterId);
  const byTopic = {};
  for (const qid of sess.order) {
    const q = questionById(qid);
    if (!q) continue;
    const t = topicById(q.topicId);
    const title = t?.title || q.topicId;
    if (!byTopic[title]) byTopic[title] = { correct: 0, total: 0 };
    byTopic[title].total += 1;
    if (sess.answers[qid]) byTopic[title].correct += 1;
  }
  const strong = [];
  const weak = [];
  for (const [title, v] of Object.entries(byTopic)) {
    const acc = v.total ? v.correct / v.total : 0;
    if (acc >= 0.75) strong.push(title);
    else weak.push(title);
  }
  const totalGraded = sess.correctCount + sess.incorrectCount;
  const percent = totalGraded ? Math.round((sess.correctCount / totalGraded) * 100) : 0;
  const chapters = app.content.chapters;
  const idx = chapters.findIndex((c) => c.id === sess.chapterId);
  const nextChapter = chapters[idx + 1] || chapters[0];
  sess.result = {
    percent,
    total: sess.order.length,
    correct: sess.correctCount,
    incorrect: sess.incorrectCount,
    strong,
    weak,
    nextChapterId: nextChapter?.id,
    nextChapterTitle: nextChapter?.title,
    mastery: stats.mastery,
  };
  toast(`Chapter practice complete · ${percent}%`);
  render();
}

/* ---------------- Views ---------------- */
function viewDashboard() {
  const timing = getExamTiming(app.state.prefs);
  const ready = computeReadiness(app.content, app.state);
  const sylGap = getNextSyllabusGapAction(app.content, app.state, app.state.prefs);
  const nextStudy = getNextBestStudyAction(app.content, app.state, app.state.prefs);
  // Prefer uncovered P1 syllabus before polishing mastered material
  const useSyl =
    sylGap &&
    (sylGap.eval.status === 'not_started' || sylGap.eval.status === 'in_progress' || sylGap.eval.priorityLevel === 'P1') &&
    !(nextStudy.action === 'mistakes' || nextStudy.action === 'mock');
  const next = useSyl
    ? {
        label: sylGap.label,
        priority: sylGap.eval.priorityLevel,
        estimatedMinutes: sylGap.estimatedMinutes,
        reasons: sylGap.reasons,
        route: sylGap.route,
        action: 'study',
      }
    : nextStudy;
  const work = remainingWorkEstimate(app.content, app.state, app.state.prefs);
  const examStr = timing.exam.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const qTotal = app.content.questions.length;
  const recChapter = getRecommendedChapter(app.content, app.state);

  return `
  <div class="stack">
    <div>
      <p class="kicker">EM exam preparation</p>
      <h1 class="h1" style="margin-bottom:4px">Command center</h1>
      <p class="muted" style="margin:0">Maximize marks per hour · ${escapeHtml(examStr)}</p>
    </div>

    <div class="dash-hero">
      <div class="nba-card">
        <p class="kicker">What should I study now?</p>
        <h2 class="h2">${escapeHtml(String(next.label).replace(/^Study:\s*|^Practice:\s*|^Revise:\s*|^Cover:\s*/, '') || next.label)}</h2>
        <div class="row" style="margin-bottom:12px">
          ${badge(next.priority)}
          <span style="color:rgba(255,255,255,.7);font-size:13px">${next.estimatedMinutes} min</span>
        </div>
        <ul class="reasons">${(next.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        <button class="btn btn-primary btn-lg" data-nav="${next.route}">Study now →</button>
      </div>

      <div class="countdown-panel">
        <div>
          <p class="kicker">Exam pressure</p>
          <div class="countdown-big"><span>${timing.daysLeft === 0 ? '0' : timing.daysLeft}</span> ${
            timing.daysLeft === 1 ? 'day' : 'days'
          }</div>
          <p class="muted" style="margin:8px 0 0;font-size:13px">Day ${timing.prepDay}/4 · ~${Math.round(timing.hoursLeft)}h left</p>
        </div>
        <div>
          <div class="ready-line"><span class="meta">Syllabus coverage</span><strong>${work.coveragePct}%</strong></div>
          <div class="progress progress-lg"><span style="width:${work.coveragePct}%"></span></div>
          <p class="meta" style="margin-top:8px">Mastery ${work.masteryPct}% · distinct from coverage</p>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 class="h3" style="margin:0">Syllabus coverage</h3>
          <button class="btn btn-ghost btn-sm" data-nav="#/coverage">Details →</button>
        </div>
        <p style="margin:8px 0 4px;font-size:1.5rem;font-weight:750">${work.coveragePct}% covered</p>
        <div class="progress progress-lg"><span style="width:${work.coveragePct}%"></span></div>
        <p class="meta" style="margin-top:10px">${work.chaptersCovered} / ${work.chaptersTotal} chapters · ${work.coveredTopics} / ${work.totalTopics} topics</p>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 class="h3" style="margin:0">What's left</h3>
          <button class="btn btn-ghost btn-sm" data-nav="#/coverage?view=remaining">View →</button>
        </div>
        <p class="meta" style="margin:8px 0">${work.p1Left} P1 · ${work.p2Left} P2 · ${work.remainingTopics} topics</p>
        <p class="meta">${work.remainingQuestions} questions · ${work.remainingMcqs} MCQs · ${work.remainingRevisions} revisions</p>
        <p style="margin:10px 0 0;font-weight:650">${escapeHtml(work.prioritizeNote)}</p>
      </div>
    </div>

    <div class="grid grid-4">
      ${metricCard('Coverage', work.coveragePct + '%', 'Official syllabus')}
      ${metricCard('Mastery', work.masteryPct + '%', 'How well you know it')}
      ${metricCard('Questions', `${ready.questionsAttempted} / ${qTotal}`, ready.questionAccuracy + '% accuracy')}
      ${metricCard('Mistakes', String(ready.mistakesRemaining), 'Open repairs')}
    </div>

    <div class="card">
      <h3 class="h3">Practice by chapter</h3>
      <div class="row">
        <select class="select" id="dash-chapter-select" style="max-width:360px;flex:1">
          ${(app.content.chapters || [])
            .map((c) => `<option value="${c.id}">Ch.${c.number} — ${escapeHtml(c.title)}</option>`)
            .join('')}
        </select>
        <button class="btn btn-primary" data-action="dash-chapter-go">Start practice →</button>
        <button class="btn btn-secondary" data-nav="#/questions?mode=chapters">All chapters</button>
      </div>
      ${
        recChapter
          ? `<p class="meta" style="margin-top:10px">Recommended: Ch.${recChapter.chapter.number} · ${recChapter.mastery}% mastery · ${recChapter.remaining} left</p>`
          : ''
      }
    </div>
  </div>`;
}

function statusIcon(status) {
  const map = {
    not_started: '○',
    in_progress: '◐',
    studied: '✓',
    practiced: '✓',
    mastered: '✓',
    needs_review: '⚠',
  };
  return map[status] || '○';
}

function statusLabel(status) {
  return String(status || 'not_started').replace(/_/g, ' ');
}

function viewCoverage() {
  const work = remainingWorkEstimate(app.content, app.state, app.state.prefs);
  const view = app.route.params.view || 'all';
  const statusFilter = app.route.params.status || 'all';
  const priFilter = app.route.params.p || 'all';
  let list = work.evaluated;
  if (view === 'remaining') list = work.remainingList;
  if (view === 'covered') list = work.evaluated.filter((e) => e.eval.status !== 'not_started');
  if (statusFilter !== 'all') list = list.filter((e) => e.eval.status === statusFilter);
  if (priFilter !== 'all') list = list.filter((e) => e.eval.priorityLevel === priFilter);

  return `
  <div class="stack">
    <div>
      <p class="kicker">Official syllabus · Syllabus/EM.md</p>
      <h1 class="h1">Syllabus coverage</h1>
      <p class="muted" style="margin:0">Coverage ≠ mastery. Questions come from EMSolutions.md.</p>
    </div>

    <div class="grid grid-2">
      <div class="panel">
        <p class="kicker">Syllabus coverage</p>
        <div class="countdown-big"><span>${work.coveragePct}</span>%</div>
        <div class="progress progress-lg" style="margin:12px 0"><span style="width:${work.coveragePct}%"></span></div>
        <p class="meta">${work.coveredTopics} / ${work.totalTopics} topics · ${work.chaptersCovered} / ${work.chaptersTotal} chapters complete</p>
      </div>
      <div class="panel">
        <p class="kicker">Mastery (performance)</p>
        <div class="countdown-big" style="font-size:2.4rem">${work.masteryPct}%</div>
        <p class="meta" style="margin-top:12px">How well you perform — separate from how much you've opened.</p>
        <p class="meta" style="margin-top:8px">${escapeHtml(work.prioritizeNote)}</p>
      </div>
    </div>

    <div class="grid grid-4">
      ${metricCard('Not started', String(work.counts.not_started || 0))}
      ${metricCard('In progress', String(work.counts.in_progress || 0))}
      ${metricCard('Practiced+', String((work.counts.practiced || 0) + (work.counts.mastered || 0)))}
      ${metricCard('Needs review', String(work.counts.needs_review || 0))}
    </div>

    <div class="card">
      <h3 class="h3">Remaining work</h3>
      <p style="margin:0">${work.remainingTopics} topics · ${work.remainingQuestions} questions · ${work.remainingMcqs} MCQs · ${work.remainingRevisions} revisions</p>
      <p class="meta" style="margin-top:6px">Est. ${Math.floor(work.remainingMinutes / 60)}h ${work.remainingMinutes % 60}m · ${work.p1Left} P1 · ${work.p2Left} P2</p>
      <button class="btn btn-primary" style="margin-top:12px" data-nav="#/coverage?view=remaining">What's left →</button>
    </div>

    <div class="row">
      ${['all', 'covered', 'remaining']
        .map(
          (v) =>
            `<button class="btn btn-sm ${view === v ? 'btn-primary' : 'btn-secondary'}" data-nav="#/coverage?view=${v}&status=${statusFilter}&p=${priFilter}">${v}</button>`
        )
        .join('')}
      <span class="spacer"></span>
      ${['all', 'P1', 'P2', 'P3', 'P4']
        .map(
          (p) =>
            `<button class="btn btn-sm ${priFilter === p ? 'btn-primary' : 'btn-ghost'}" data-nav="#/coverage?view=${view}&p=${p}">${p}</button>`
        )
        .join('')}
    </div>

    <div class="stack">
      ${work.chapters
        .map((ch) => {
          const open = view === 'all';
          const topics = list.filter((e) => e.topic.chapterId === ch.chapter.id);
          if (view !== 'all' && !topics.length) return '';
          return `<details class="section-block" ${open ? 'open' : ''}>
            <summary>
              <span>Ch.${ch.chapter.number} — ${escapeHtml(ch.chapter.title)}
                <span class="meta" style="font-weight:500"> · ${ch.coverage}% · ${ch.covered}/${ch.total} · ${ch.chapter.marks} marks</span>
              </span>
            </summary>
            <div class="section-body">
              <div class="progress" style="margin-bottom:12px"><span style="width:${ch.coverage}%"></span></div>
              ${(view === 'all' ? ch.topics : topics)
                .map(({ topic, eval: ev }) => {
                  if (statusFilter !== 'all' && ev.status !== statusFilter) return '';
                  if (priFilter !== 'all' && ev.priorityLevel !== priFilter) return '';
                  return `<div class="topic-row" data-nav="#/coverage/topic/${topic.id}">
                    <div style="font-size:18px;width:28px;text-align:center">${statusIcon(ev.status)}</div>
                    <div style="min-width:0">
                      <div class="title">${escapeHtml(topic.code)} ${escapeHtml(topic.title)}</div>
                      <div class="progress" style="margin:6px 0;max-width:240px"><span style="width:${ev.overall}%"></span></div>
                      <div class="meta-line">${badge(ev.priorityLevel, false)} · ${statusLabel(ev.status)} · Q ${ev.qAttempt}/${ev.qTotal} · mastery ${ev.mastery}%</div>
                    </div>
                    <button class="btn btn-sm btn-primary" data-nav="#/coverage/topic/${topic.id}">Open →</button>
                  </div>`;
                })
                .join('')}
              <div class="row" style="margin-top:12px">
                <button class="btn btn-secondary btn-sm" data-nav="#/chapter/${ch.chapter.studyChapterId}">Practice chapter questions →</button>
              </div>
            </div>
          </details>`;
        })
        .join('')}
    </div>
  </div>`;
}

function viewCoverageTopic() {
  const id = app.route.params.id;
  const topic = (app.content.syllabus?.topics || []).find((t) => t.id === id);
  if (!topic) return emptyState('Syllabus topic not found', 'Return to coverage.', 'Coverage', '#/coverage');
  const ev = evaluateSyllabusTopic(topic, app.content, app.state);
  const ch = (app.content.syllabus?.chapters || []).find((c) => c.id === topic.chapterId);
  const studyTopics = (topic.studyTopicIds || []).map((sid) => app.content.topics.find((t) => t.id === sid)).filter(Boolean);

  return `
  <div class="stack">
    <div class="row">
      <button class="btn btn-ghost btn-sm" data-nav="#/coverage">← Coverage</button>
    </div>
    <div class="panel">
      <p class="kicker">Syllabus ${escapeHtml(topic.code)} · Ch.${ch?.number} ${escapeHtml(ch?.title || '')}</p>
      <h1 class="h1">${escapeHtml(topic.title)}</h1>
      <div class="row" style="margin:8px 0">${badge(ev.priorityLevel)} <span class="badge badge-muted">${statusIcon(ev.status)} ${statusLabel(ev.status)}</span></div>
      <p class="muted" style="margin:0">Syllabus requirement: ${escapeHtml(topic.description)}</p>
      <div class="progress progress-lg" style="margin:14px 0 6px"><span style="width:${ev.overall}%"></span></div>
      <p class="meta">Overall progress ${ev.overall}% · Mastery ${ev.mastery}%</p>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3 class="h3">Coverage dimensions</h3>
        ${[
          ['Concept', ev.conceptProgress],
          ['Questions', ev.questionProgress],
          ['MCQs', ev.mcqProgress],
          ['Revision', ev.revisionProgress],
        ]
          .map(
            ([lab, val]) =>
              `<div style="margin:10px 0"><div class="row" style="justify-content:space-between"><span>${lab}</span><strong>${val}%</strong></div><div class="progress"><span style="width:${val}%"></span></div></div>`
          )
          .join('')}
      </div>
      <div class="card">
        <h3 class="h3">Content availability</h3>
        <p>${ev.hasStudyMaterial ? '✓' : '⚠'} Study material ${ev.hasStudyMaterial ? 'available' : 'not found'}</p>
        <p>${ev.hasQuestions ? '✓' : '⚠'} Questions ${ev.qTotal}</p>
        <p>${ev.hasMcqs ? '✓' : '⚠'} MCQs ${ev.mcqTotal}</p>
        <p class="meta">Mistakes open: ${ev.openMistakes}</p>
        <p class="meta">Source: Syllabus/EM.md + EMSolutions.md</p>
      </div>
    </div>

    <div class="card">
      <h3 class="h3">Linked study material</h3>
      ${
        studyTopics.length
          ? studyTopics
              .map(
                (t) =>
                  `<div class="list-item" data-nav="#/topic/${t.id}"><div style="flex:1"><strong>${escapeHtml(
                    t.title
                  )}</strong><div class="meta">${t.questionIds.length} questions</div></div><button class="btn btn-sm btn-primary" data-nav="#/topic/${t.id}">Study →</button></div>`
              )
              .join('')
          : '<p class="muted">No mapped study section — use chapter practice / insights.</p>'
      }
    </div>

    <div class="sticky-actions">
      <button class="btn btn-secondary btn-sm" data-action="syl-mark-concept" data-id="${topic.id}">Mark concept studied</button>
      <button class="btn btn-secondary btn-sm" data-action="syl-mark-revised" data-id="${topic.id}">Mark revised</button>
      ${
        studyTopics[0]
          ? `<button class="btn btn-primary btn-sm" data-nav="#/topic/${studyTopics[0].id}">Continue studying →</button>`
          : ''
      }
      ${
        topic.questionIds.length
          ? `<button class="btn btn-primary btn-sm" data-nav="#/chapter/${ch?.studyChapterId}">Practice chapter →</button>`
          : ''
      }
      <button class="btn btn-ghost btn-sm" data-nav="#/mistakes">Mistakes</button>
    </div>
  </div>`;
}

function viewTopics() {
  const filter = app.route.params.p || 'all';
  const rows = app.content.topics
    .map((t) => ({ t, live: livePriority(t, app.state), st: app.state.topics[t.id] || { mastery: 0 } }))
    .filter(({ live }) => filter === 'all' || live.level === filter)
    .sort((a, b) => b.live.score - a.live.score);

  return `
  <div class="stack">
    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <div>
        <p class="kicker">Study</p>
        <h1 class="h1">Topics</h1>
        <p class="muted" style="margin:0">Scan priority → mastery → action</p>
      </div>
      <div class="row">
        ${['all', 'P1', 'P2', 'P3', 'P4']
          .map(
            (p) =>
              `<button class="btn btn-sm ${filter === p ? 'btn-primary' : 'btn-secondary'}" data-nav="#/topics${
                p === 'all' ? '' : '?p=' + p
              }">${p}</button>`
          )
          .join('')}
      </div>
    </div>
    <div>
      ${rows
        .map(({ t, live, st }) => {
          const ch = chapterOf(t.id);
          const mastery = st.mastery || 0;
          const action = mastery >= 85 ? 'Review →' : 'Study →';
          return `<div class="topic-row" data-nav="#/topic/${t.id}" role="button" tabindex="0">
            <div>${badge(live.level)}</div>
            <div style="min-width:0">
              <div class="title">${escapeHtml(t.title)}</div>
              <div class="progress" style="margin:8px 0 6px;max-width:280px"><span style="width:${mastery}%"></span></div>
              <div class="meta-line">Ch.${ch?.number} · ${t.questionIds.length} questions · ~${t.estimatedMinutes} min · ${mastery}% mastered</div>
            </div>
            <button class="btn btn-sm btn-primary" data-nav="#/topic/${t.id}">${action}</button>
          </div>`;
        })
        .join('')}
    </div>
  </div>`;
}

function findPlanTasksForTopic(topicId) {
  if (!topicId) return [];
  const days = buildFourDayPlan(app.content, app.state, app.state.prefs);
  const hits = [];
  for (const d of [1, 2, 3, 4]) {
    for (const it of days[d].items || []) {
      if (it.topicId === topicId) hits.push(it);
    }
  }
  // Persisted tasks that may have dropped from regenerated plan
  for (const pt of Object.values(app.state.planTasks || {})) {
    if (pt.topicId === topicId && !hits.some((h) => h.id === pt.id)) hits.push(pt);
  }
  return hits;
}

/** Prefer incomplete plan task for this topic; otherwise synthesize today's study block. */
function planTaskForTopicPage(topicId) {
  const hits = findPlanTasksForTopic(topicId);
  const open = hits.find((h) => h.status !== 'completed' && h.status !== 'skipped');
  if (open) return open;
  if (hits.some((h) => h.status === 'completed')) return hits.find((h) => h.status === 'completed');

  const t = topicById(topicId);
  if (!t) return null;
  const timing = getExamTiming(app.state.prefs);
  const day = timing.prepDay || 1;
  const live = livePriority(t, app.state);
  const id = `d${day}-study-${topicId}`;
  const saved = app.state.planTasks?.[id];
  return {
    id,
    day,
    topicId,
    chapterId: t.chapterId || null,
    title: t.title,
    description: 'Learn the core ideas, key formulas, and exam-level applications.',
    action: 'study',
    type: 'study',
    priority: live.level,
    durationMinutes: t.estimatedMinutes || 30,
    estimatedMinutes: t.estimatedMinutes || 30,
    scheduledTime: saved?.scheduledTime || '—',
    status: saved?.status || 'upcoming',
    startedAt: saved?.startedAt || null,
    completedAt: saved?.completedAt || null,
    elapsedSeconds: saved?.elapsedSeconds || 0,
    synthesized: true,
  };
}

function viewTopic() {
  const t = topicById(app.route.params.id);
  if (!t) return emptyState('Topic not found', 'Return to the topic list and pick another.', 'Browse topics', '#/topics');
  const live = livePriority(t, app.state);
  const st = ensureTopic(app.state, t.id);
  const ch = chapterOf(t.id);
  const qs = t.questionIds.map(questionById).filter(Boolean);
  const mode = app.route.params.mode;
  const showFull = mode !== 'revise';
  const planTask = planTaskForTopicPage(t.id);
  const planDone = planTask?.status === 'completed';
  const planCompletedAt = planTask?.completedAt
    ? new Date(planTask.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return `
  <div class="stack narrow-host">
    <div class="row">
      <button class="btn btn-ghost btn-sm" data-nav="#/topics">← Topics</button>
      <button class="btn btn-secondary btn-sm" data-nav="#/focus/${t.id}">Focus mode</button>
      ${
        planTask
          ? `<button class="btn btn-ghost btn-sm" data-nav="#/plan?day=${planTask.day || 1}">Day ${planTask.day || 1} plan</button>`
          : ''
      }
    </div>

    <div class="panel">
      <div class="row">${badge(live.level)} <span class="meta">Ch.${ch?.number} · score ${live.score}</span></div>
      <h1 class="h1" style="margin-top:8px">${escapeHtml(t.title)}</h1>
      <p class="muted" style="margin:0">~${t.estimatedMinutes} min · ${qs.length} solved questions from EMSolutions.md</p>
      <div class="progress progress-lg" style="margin:14px 0 6px"><span style="width:${st.mastery || 0}%"></span></div>
      <p class="meta">${st.mastery || 0}% mastery · day-plan ${planDone ? '✓ completed' : 'not marked complete'}</p>
    </div>

    <div class="card">
      <h3 class="h3">Why it matters</h3>
      <p style="margin:0">${escapeHtml(t.whyMatters || 'High exam leverage for this chapter.')}</p>
    </div>

    ${
      t.examDefinition
        ? `<details class="section-block" open><summary>Exam definition</summary><div class="section-body md-body">${renderMarkdown(
            t.examDefinition
          )}</div></details>`
        : ''
    }

    ${
      showFull && t.preamble
        ? `<details class="section-block" ${t.isReference ? 'open' : ''}><summary>Concept / reference</summary><div class="section-body md-body">${renderMarkdown(
            t.preamble
          )}</div></details>`
        : ''
    }

    ${
      t.formulas?.length
        ? `<div class="card"><h3 class="h3">Key formulas</h3>${t.formulas
            .slice(0, 10)
            .map(
              (f, i) =>
                `<div class="formula-card"><div class="md-body">$$${f}$$</div><div class="formula-label">Formula ${
                  i + 1
                }</div></div>`
            )
            .join('')}</div>`
        : ''
    }

    <details class="section-block"><summary>Common mistakes</summary><div class="section-body"><ul>${(
      t.commonMistakes || []
    )
      .map((m) => `<li>${escapeHtml(m)}</li>`)
      .join('')}</ul></div></details>

    <details class="section-block" open><summary>Quick recall</summary><div class="section-body">
      ${(t.recallPrompts || [])
        .map(
          (r) => `
        <div style="margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:10px">
          <div class="meta">${escapeHtml(r.kind)}</div>
          <div style="font-weight:650;margin:6px 0">${escapeHtml(r.prompt)}</div>
          <details><summary class="btn btn-sm btn-secondary" style="display:inline-flex;margin-top:6px">Reveal answer</summary>
            <div class="md-body" style="margin-top:10px">${renderMarkdown(r.answer || '')}</div>
          </details>
        </div>`
        )
        .join('')}
    </div></details>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3 class="h3" style="margin:0">Original solved questions</h3>
        <button class="btn btn-sm btn-primary" data-nav="#/questions?topic=${encodeURIComponent(t.id)}">Practice →</button>
      </div>
      ${
        qs.length
          ? qs
              .slice(0, showFull ? qs.length : Math.min(3, qs.length))
              .map((q) => questionCard(q))
              .join('')
          : '<p class="muted">Formula reference — no numericals in this section.</p>'
      }
    </div>

    <div class="card">
      <h3 class="h3">Topic checklist</h3>
      <div class="checklist">
        ${app.content.checklistTemplate
          .map((label, idx) => {
            const checked = !!st.checklist[idx];
            return `<label><input type="checkbox" ${checked ? 'checked' : ''} data-action="toggle-check" data-id="${
              t.id
            }" data-idx="${idx}"/> <span>${escapeHtml(label)}</span></label>`;
          })
          .join('')}
      </div>
    </div>

    ${
      planTask
        ? planDone
          ? `<div class="panel plan-finish-cta" style="opacity:.95">
          <p class="kicker">✓ Day-plan task completed</p>
          <p style="margin:0 0 8px"><strong>${escapeHtml(planTask.title)}</strong> marked complete${
              planCompletedAt ? ` at ${escapeHtml(planCompletedAt)}` : ''
            }.</p>
          <p class="muted" style="margin:0 0 12px">This is day-plan progress — not the same as mastery.</p>
          <button class="btn btn-secondary" data-nav="#/plan?day=${planTask.day || 1}">Back to Day ${planTask.day || 1} plan</button>
        </div>`
          : `<div class="panel plan-finish-cta">
          <p class="kicker">Finished this topic?</p>
          <p style="margin:0 0 8px">Mark <strong>${escapeHtml(
            t.title
          )}</strong> as completed once you've finished the planned study.</p>
          <p class="muted" style="margin:0 0 12px">Day ${planTask.day || '—'} · ${
              planTask.durationMinutes || planTask.estimatedMinutes || t.estimatedMinutes
            } min · ${escapeHtml(planTask.type || planTask.action || 'study')} · does not auto-master</p>
          <button class="btn btn-ok btn-lg" data-action="plan-finish" data-id="${escapeHtml(
            planTask.id
          )}">✓ Finish &amp; Mark Complete</button>
        </div>`
        : ''
    }

    <div class="sticky-actions">
      <div style="min-width:0;flex:1">
        <div style="font-weight:650;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(
          t.title
        )}</div>
        <div class="meta">${badge(live.level, false)} · ${st.mastery || 0}%</div>
      </div>
      ${
        planTask && !planDone
          ? `<button class="btn btn-ok btn-sm" data-action="plan-finish" data-id="${escapeHtml(
              planTask.id
            )}">✓ Finish</button>`
          : ''
      }
      <button class="btn btn-secondary btn-sm" data-nav="#/mcq?topic=${encodeURIComponent(t.id)}">MCQs</button>
      <button class="btn btn-ghost btn-sm" data-action="mark-mastered" data-id="${t.id}">Mastered</button>
      <button class="btn btn-primary btn-sm" data-nav="#/questions?topic=${encodeURIComponent(t.id)}">Practice →</button>
    </div>
  </div>`;
}

function questionCard(q) {
  const qs = app.state.questions[q.id] || {};
  const topic = topicById(q.topicId);
  const live = topic ? livePriority(topic, app.state) : { level: 'P3' };
  const status = qs.attempted
    ? qs.correct
      ? '<span class="badge badge-ok">Correct</span>'
      : '<span class="badge badge-bad">Incorrect</span>'
    : '<span class="badge badge-muted">Not attempted</span>';
  return `
  <div class="q-card" id="q-${q.id}">
    <div class="row" style="margin-bottom:10px">
      ${status}
      ${badge(live.level, false)}
      <span class="meta">Q${q.number} · ${escapeHtml(q.difficulty || 'medium')}${
        q.marksRaw ? ' · ' + escapeHtml(q.marksRaw) : ''
      }</span>
      ${qs.markedForRevision ? '<span class="badge badge-warn">Revision</span>' : ''}
    </div>
    <div class="meta" style="margin-bottom:6px">${escapeHtml(topic?.title || '')}</div>
    <div class="md-body">${renderMarkdown(q.text)}</div>
    <p class="meta" style="margin:12px 0 8px">Think it through before revealing.</p>
    <div class="row">
      <button class="btn btn-primary btn-sm" data-action="reveal-solution" data-id="${q.id}">Reveal solution</button>
      <button class="btn btn-ok btn-sm" data-action="q-correct" data-id="${q.id}">Mark correct</button>
      <button class="btn btn-bad btn-sm" data-action="q-wrong" data-id="${q.id}" data-mistake="concept gap">Mark incorrect</button>
      <button class="btn btn-ghost btn-sm" data-action="q-revise" data-id="${q.id}">${
        qs.markedForRevision ? 'Unmark' : 'Mark for revision'
      }</button>
    </div>
    <div id="sol-${q.id}" class="hidden" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <p class="kicker">Original solution</p>
      <div class="md-body">${renderMarkdown(q.solution || '_No solution text parsed._')}</div>
      <div class="formula-card" style="text-align:left;margin-top:12px">
        <strong>Answer</strong>
        <div class="md-body" style="margin-top:8px">${renderMarkdown(q.answer || '')}</div>
      </div>
      <p class="meta" style="margin-top:12px"><strong>Key takeaway:</strong> Start from the governing law, then substitute. Check units and magnitude.</p>
    </div>
  </div>`;
}

function viewQuestions() {
  const topicFilter = app.route.params.topic || '';
  const status = app.route.params.status || '';
  const chFilter = app.route.params.ch || '';
  const mode = app.route.params.mode || '';

  // Hub when no deep filter (except topic from topic page)
  if (!topicFilter && !status && !chFilter && mode !== 'bank') {
    const rec = getRecommendedChapter(app.content, app.state);
    return `
    <div class="stack">
      <div>
        <p class="kicker">Study</p>
        <h1 class="h1">Questions</h1>
        <p class="muted" style="margin:0">${app.content.questions.length} solved questions from EMSolutions.md</p>
      </div>

      <div class="mode-grid">
        <button class="mode-card featured" data-nav="#/questions?mode=chapters">
          <div class="row" style="justify-content:space-between">
            <p class="mode-title">Chapter Wise</p>
            <span class="badge badge-p1">PRIMARY</span>
          </div>
          <p class="mode-desc">Practice by chapter — the fastest way to cover exam units with progress tracking.</p>
        </button>
        <button class="mode-card" data-nav="#/questions?mode=bank">
          <p class="mode-title">All Questions</p>
          <p class="mode-desc">Browse the full bank with filters.</p>
        </button>
        <button class="mode-card" data-nav="#/questions?mode=bank&status=unattempted">
          <p class="mode-title">Unattempted</p>
          <p class="mode-desc">Questions you have not tried yet.</p>
        </button>
        <button class="mode-card" data-nav="#/questions?mode=bank&status=incorrect">
          <p class="mode-title">Incorrect</p>
          <p class="mode-desc">Repair wrong answers.</p>
        </button>
        <button class="mode-card" data-nav="#/questions?mode=bank&status=revision">
          <p class="mode-title">Marked for Revision</p>
          <p class="mode-desc">Your flagged set.</p>
        </button>
        <button class="mode-card" data-nav="#/topics?p=P1">
          <p class="mode-title">Weak / P1 Topics</p>
          <p class="mode-desc">Jump to critical topics first.</p>
        </button>
      </div>

      ${
        rec
          ? `<div class="nba-card" style="padding:20px 24px">
              <p class="kicker">Recommended chapter</p>
              <h2 class="h2" style="font-size:1.25rem;margin:6px 0 10px">Ch.${rec.chapter.number} — ${escapeHtml(
                rec.chapter.title
              )}</h2>
              <div class="row" style="margin-bottom:12px">
                ${badge(rec.priorityLevel)}
                <span style="color:rgba(255,255,255,.7);font-size:13px">${rec.mastery}% mastery · ${rec.remaining} remaining · ${
                  rec.incorrect
                } incorrect</span>
              </div>
              <button class="btn btn-primary" data-nav="#/chapter/${rec.chapter.id}">Practice chapter →</button>
            </div>`
          : ''
      }
    </div>`;
  }

  // Filtered bank view
  let list = [...app.content.questions];
  if (topicFilter) list = list.filter((q) => q.topicId === topicFilter);
  if (chFilter) list = list.filter((q) => q.chapterId === chFilter);
  const st = status || 'all';
  if (st === 'attempted') list = list.filter((q) => app.state.questions[q.id]?.attempted);
  if (st === 'unattempted') list = list.filter((q) => !app.state.questions[q.id]?.attempted);
  if (st === 'incorrect') list = list.filter((q) => app.state.questions[q.id]?.attempted && !app.state.questions[q.id]?.correct);
  if (st === 'correct') list = list.filter((q) => app.state.questions[q.id]?.correct);
  if (st === 'revision') list = list.filter((q) => app.state.questions[q.id]?.markedForRevision);

  const topicsInChapter = chFilter
    ? app.content.topics.filter((t) => t.chapterId === chFilter)
    : app.content.topics;

  return `
  <div class="stack">
    <div class="row">
      <button class="btn btn-ghost btn-sm" data-nav="#/questions">← Questions hub</button>
      <button class="btn btn-secondary btn-sm" data-nav="#/questions?mode=chapters">Chapter Wise</button>
    </div>
    <div>
      <p class="kicker">Question bank</p>
      <h1 class="h1">${list.length} questions</h1>
    </div>
    <div class="card">
      <div class="grid grid-3">
        <div>
          <label class="label">Chapter</label>
          <select class="select" onchange="location.hash='#/questions?mode=bank&ch='+this.value+'&status=${st}&topic='">
            <option value="">All chapters</option>
            ${app.content.chapters
              .map(
                (c) =>
                  `<option value="${c.id}" ${chFilter === c.id ? 'selected' : ''}>Ch.${c.number} — ${escapeHtml(
                    c.title
                  )}</option>`
              )
              .join('')}
          </select>
        </div>
        <div>
          <label class="label">Topic</label>
          <select class="select" onchange="location.hash='#/questions?mode=bank&ch=${chFilter}&status=${st}&topic='+encodeURIComponent(this.value)">
            <option value="">All topics</option>
            ${topicsInChapter
              .map(
                (t) =>
                  `<option value="${t.id}" ${topicFilter === t.id ? 'selected' : ''}>${escapeHtml(t.title)}</option>`
              )
              .join('')}
          </select>
        </div>
        <div>
          <label class="label">Status</label>
          <select class="select" onchange="location.hash='#/questions?mode=bank&ch=${chFilter}&topic=${encodeURIComponent(
            topicFilter
          )}&status='+this.value">
            ${['all', 'unattempted', 'attempted', 'correct', 'incorrect', 'revision']
              .map((s) => `<option value="${s}" ${st === s ? 'selected' : ''}>${s}</option>`)
              .join('')}
          </select>
        </div>
      </div>
    </div>
    ${
      list.length
        ? list.slice(0, 40).map((q) => questionCard(q)).join('') +
          (list.length > 40 ? `<p class="meta">Showing 40 of ${list.length}.</p>` : '')
        : emptyState('No matching questions', 'Try another filter or open Chapter Wise.', 'Chapter Wise', '#/questions?mode=chapters')
    }
  </div>`;
}

function viewChapterList() {
  const stats = getAllChapterStats(app.content, app.state);
  const rec = getRecommendedChapter(app.content, app.state);
  return `
  <div class="stack">
    <div class="row">
      <button class="btn btn-ghost btn-sm" data-nav="#/questions">← Questions</button>
    </div>
    <div>
      <p class="kicker">Chapter-wise practice</p>
      <h1 class="h1">Choose a chapter</h1>
      <p class="muted" style="margin:0">Questions are mapped from EMSolutions.md chapters automatically.</p>
    </div>
    ${
      rec
        ? `<div class="card" style="border-color:#93c5fd;background:#f8fbff">
            <p class="kicker">Recommended</p>
            <h3 class="h3" style="margin:0">Ch.${rec.chapter.number} — ${escapeHtml(rec.chapter.title)}</h3>
            <p class="meta" style="margin:6px 0 12px">${badge(rec.priorityLevel)} · ${rec.mastery}% mastery · ${
              rec.remaining
            } unanswered · ${rec.incorrect} mistakes</p>
            <button class="btn btn-primary" data-nav="#/chapter/${rec.chapter.id}">Practice now →</button>
          </div>`
        : ''
    }
    <div class="stack">
      ${stats
        .map((s) => {
          const c = s.chapter;
          return `<div class="chapter-card">
            <div class="ch-num">Chapter ${String(c.number).padStart(2, '0')}</div>
            <h2 class="ch-title">${escapeHtml(c.title)}</h2>
            <div class="chip-row">
              ${badge(s.priorityLevel)}
              <span class="chip">${s.total} questions</span>
              <span class="chip">${s.attempted} attempted</span>
              <span class="chip">${s.accuracy}% accuracy</span>
              <span class="chip">${s.remaining} left</span>
            </div>
            <div>
              <div class="row" style="justify-content:space-between"><span class="meta">Mastery</span><span class="meta">${s.mastery}%</span></div>
              <div class="progress progress-lg" style="margin-top:6px"><span style="width:${s.mastery}%"></span></div>
            </div>
            <div class="row">
              <button class="btn btn-primary" data-nav="#/chapter/${c.id}">Practice chapter →</button>
              <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${
                c.id
              }" data-mode="unattempted">Unattempted</button>
              <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${
                c.id
              }" data-mode="quick" data-count="10">Quick 10</button>
            </div>
          </div>`;
        })
        .join('')}
    </div>
  </div>`;
}

function viewChapter() {
  const id = app.route.params.id;
  const chapter = app.content.chapters.find((c) => c.id === id);
  if (!chapter) return emptyState('Chapter not found', 'Pick a chapter from the list.', 'Chapter list', '#/questions?mode=chapters');
  const stats = getChapterStats(app.content, app.state, id);
  const status = app.route.params.status || 'all';
  const difficulty = app.route.params.difficulty || 'all';
  const topicId = app.route.params.topic || '';
  const filtered = filterChapterQuestions(app.content, app.state, id, { status, difficulty, topicId });
  const topics = app.content.topics.filter((t) => t.chapterId === id);

  return `
  <div class="stack">
    <div class="row">
      <button class="btn btn-ghost btn-sm" data-nav="#/questions?mode=chapters">← Chapters</button>
    </div>
    <div class="panel">
      <p class="kicker">Chapter ${String(chapter.number).padStart(2, '0')}</p>
      <h1 class="h1">${escapeHtml(chapter.title)}</h1>
      <div class="chip-row" style="margin:8px 0 12px">
        ${badge(stats.priorityLevel)}
        <span class="chip">${stats.total} questions</span>
        <span class="chip">${stats.attempted} attempted</span>
        <span class="chip">${stats.correct} correct</span>
        <span class="chip">${stats.accuracy}% accuracy</span>
        <span class="chip">${stats.mastery}% mastery</span>
        <span class="chip">${stats.incorrect} incorrect</span>
        <span class="chip">${stats.revision} revision</span>
      </div>
      <div class="progress progress-lg"><span style="width:${stats.mastery}%"></span></div>
      <div class="row" style="margin-top:16px">
        <button class="btn btn-primary btn-lg" data-action="start-chapter-practice" data-chapter="${id}" data-mode="all">Start chapter practice →</button>
        <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="unattempted">Unattempted</button>
        <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="incorrect">Incorrect</button>
        <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="revision">Revision</button>
      </div>
    </div>

    <div class="card">
      <h3 class="h3">Quick practice</h3>
      <div class="row">
        <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="quick" data-count="5">5 Q</button>
        <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="quick" data-count="10">10 Q</button>
        <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="quick" data-count="20">20 Q</button>
        <button class="btn btn-warn" data-action="start-chapter-practice" data-chapter="${id}" data-mode="exam" data-timed="1">Exam practice (timed)</button>
      </div>
    </div>

    <div class="card">
      <h3 class="h3">Filters</h3>
      <div class="grid grid-3">
        <div>
          <label class="label">Status</label>
          <select class="select" onchange="location.hash='#/chapter/${id}?status='+this.value+'&difficulty=${difficulty}&topic=${encodeURIComponent(
            topicId
          )}'">
            ${['all', 'unattempted', 'incorrect', 'correct', 'revision']
              .map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label class="label">Difficulty</label>
          <select class="select" onchange="location.hash='#/chapter/${id}?status=${status}&difficulty='+this.value+'&topic=${encodeURIComponent(
            topicId
          )}'">
            ${['all', 'easy', 'medium', 'hard']
              .map((d) => `<option value="${d}" ${difficulty === d ? 'selected' : ''}>${d}</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label class="label">Topic</label>
          <select class="select" onchange="location.hash='#/chapter/${id}?status=${status}&difficulty=${difficulty}&topic='+encodeURIComponent(this.value)">
            <option value="">All topics</option>
            ${topics
              .map((t) => `<option value="${t.id}" ${topicId === t.id ? 'selected' : ''}>${escapeHtml(t.title)}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-primary" data-action="start-chapter-practice" data-chapter="${id}" data-mode="all" data-status="${status}" data-difficulty="${difficulty}" data-topic="${topicId}">Practice filtered (${filtered.length}) →</button>
      </div>
    </div>

    <div>
      <h3 class="h3">${filtered.length} questions in view</h3>
      ${
        filtered.length
          ? filtered.slice(0, 25).map((q) => questionCard(q)).join('') +
            (filtered.length > 25 ? `<p class="meta">Showing 25 of ${filtered.length}. Start practice for the full set.</p>` : '')
          : emptyState('No questions in this filter', 'Clear filters or try another mode.', 'Reset', `#/chapter/${id}`)
      }
    </div>
  </div>`;
}

function viewChapterPractice() {
  const sess = app.chapterSession;
  const chapterId = app.route.params.id;
  if (!sess || sess.chapterId !== chapterId) {
    return `
    <div class="stack">
      ${emptyState('No active session', 'Start practice from the chapter page.', 'Open chapter', `#/chapter/${chapterId}`)}
    </div>`;
  }
  const chapter = app.content.chapters.find((c) => c.id === chapterId);

  if (sess.result) {
    const r = sess.result;
    return `
    <div class="stack immersive">
      <div class="panel" style="text-align:center">
        <p class="kicker">Chapter practice complete</p>
        <h1 class="h1">${escapeHtml(chapter?.title || '')}</h1>
        <div class="countdown-big" style="margin:12px 0"><span>${r.percent}</span>%</div>
        <p class="muted">${r.correct} / ${r.correct + r.incorrect} graded · ${r.total} in session · mastery now ${r.mastery}%</p>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <h3 class="h3">Strong</h3>
          <ul>${r.strong.map((t) => `<li>${escapeHtml(t)}</li>`).join('') || '<li class="muted">Keep practicing</li>'}</ul>
        </div>
        <div class="card">
          <h3 class="h3">Needs review</h3>
          <ul>${r.weak.map((t) => `<li>${escapeHtml(t)}</li>`).join('') || '<li class="muted">None flagged</li>'}</ul>
        </div>
      </div>
      <div class="card">
        <p style="margin:0 0 12px;font-weight:650">Next best revision: ${escapeHtml(r.weak[0] || 'Mistake book')}</p>
        <div class="row">
          <button class="btn btn-primary" data-nav="#/mistakes">Review mistakes</button>
          <button class="btn btn-secondary" data-action="start-chapter-practice" data-chapter="${chapterId}" data-mode="incorrect">Practice again</button>
          <button class="btn btn-secondary" data-nav="#/chapter/${r.nextChapterId}">Next chapter →</button>
          <button class="btn btn-ghost" data-action="chapter-exit" data-chapter="${chapterId}">Back to chapter</button>
        </div>
      </div>
    </div>`;
  }

  const qid = sess.order[sess.index];
  const q = questionById(qid);
  const topic = topicById(q?.topicId);
  let timerHtml = '';
  if (sess.endsAt) {
    const rem = Math.max(0, sess.endsAt - Date.now());
    const mm = String(Math.floor(rem / 60000)).padStart(2, '0');
    const ss = String(Math.floor((rem % 60000) / 1000)).padStart(2, '0');
    timerHtml = `<span class="mock-timer">${mm}:${ss}</span>`;
    if (!app._chapterTimer) {
      app._chapterTimer = setInterval(() => {
        if (!app.chapterSession?.endsAt || app.chapterSession.result) return;
        if (Date.now() >= app.chapterSession.endsAt) finishChapterSession();
        else if (app.route.name === 'chapterPractice') {
          const el = document.querySelector('.mock-timer');
          if (el) {
            const r = Math.max(0, app.chapterSession.endsAt - Date.now());
            el.textContent = `${String(Math.floor(r / 60000)).padStart(2, '0')}:${String(
              Math.floor((r % 60000) / 1000)
            ).padStart(2, '0')}`;
          }
        }
      }, 1000);
    }
  }

  return `
  <div class="stack immersive">
    <div class="row" style="justify-content:space-between">
      <div>
        <div class="kicker" style="margin:0">${escapeHtml(chapter?.title || '')}</div>
        <div class="practice-progress">Question ${sess.index + 1} / ${sess.order.length} · ${
          sess.correctCount
        } correct</div>
      </div>
      <div class="row">
        ${timerHtml}
        <button class="btn btn-ghost btn-sm" data-action="chapter-exit" data-chapter="${chapterId}">Exit</button>
      </div>
    </div>

    <div class="immersive-card">
      <div class="row" style="margin-bottom:10px">
        ${badge(livePriority(topic || { examImportance: 0.5, frequencyScore: 0.5, foundationScore: 0.5, markEfficiency: 0.5, priorityBase: 50, id: q?.topicId }, app.state).level, false)}
        <span class="meta">${escapeHtml(topic?.title || '')} · Q${q?.number} · ${escapeHtml(q?.difficulty || 'medium')}${
          q?.marksRaw ? ' · ' + escapeHtml(q.marksRaw) : ''
        }</span>
      </div>
      <div class="md-body">${renderMarkdown(q?.text || '')}</div>

      ${
        !sess.revealed
          ? `<p class="meta" style="margin:20px 0 12px">Think first — then reveal.</p>
             <button class="btn btn-primary btn-lg" data-action="chapter-reveal">Show solution</button>`
          : `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
              <p class="kicker">Original solution</p>
              <div class="md-body">${renderMarkdown(q?.solution || '')}</div>
              <div class="formula-card" style="text-align:left;margin-top:12px">
                <strong>Answer</strong>
                <div class="md-body" style="margin-top:8px">${renderMarkdown(q?.answer || '')}</div>
              </div>
            </div>`
      }

      ${
        sess.revealed && !sess.graded
          ? `<div class="row" style="margin-top:20px">
              <button class="btn btn-ok btn-lg" data-action="chapter-mark" data-correct="1">○ Correct</button>
              <button class="btn btn-bad btn-lg" data-action="chapter-mark" data-correct="0">○ Incorrect</button>
            </div>`
          : ''
      }

      ${
        sess.graded
          ? `<div style="margin-top:16px">
              <p>${
                sess.answers[qid]
                  ? '<span class="badge badge-ok">✓ Correct</span>'
                  : '<span class="badge badge-bad">✕ Incorrect · added to Mistake Book</span>'
              }</p>
              <button class="btn btn-primary btn-lg" style="margin-top:12px" data-action="chapter-next">${
                sess.index >= sess.order.length - 1 ? 'Finish chapter →' : 'Next question →'
              }</button>
            </div>`
          : ''
      }
    </div>
  </div>`;
}

function viewMcq() {
  const topic = app.route.params.topic;
  if (!app.mcqSession) {
    return `
    <div class="stack">
      <div>
        <p class="kicker">Study</p>
        <h1 class="h1">MCQ practice</h1>
        <p class="muted" style="margin:0">${app.content.mcqs.length} items · exam-style options</p>
      </div>
      <div class="grid grid-2">
        <div class="card"><h3 class="h3">Quick 10</h3><p class="muted">Random mix · ~8 min</p><button class="btn btn-primary" data-action="start-mcq" data-mode="quick10">Start →</button></div>
        <div class="card"><h3 class="h3">Weak topics</h3><p class="muted">Low mastery first</p><button class="btn btn-primary" data-action="start-mcq" data-mode="weak">Start →</button></div>
        <div class="card"><h3 class="h3">Mixed practice</h3><p class="muted">20 questions</p><button class="btn btn-secondary" data-action="start-mcq" data-mode="mixed">Start →</button></div>
        <div class="card"><h3 class="h3">Exam mode</h3><p class="muted">15 timed questions</p><button class="btn btn-warn" data-action="start-mcq" data-mode="exam">Start →</button></div>
      </div>
      ${
        topic
          ? `<div class="card"><button class="btn btn-primary btn-block" data-action="start-mcq" data-mode="topic:${topic}">Practice this topic only →</button></div>`
          : ''
      }
    </div>`;
  }
  const s = app.mcqSession;
  const m = s.list[s.index];
  if (!m) {
    return emptyState('Session complete', 'Nice work. Review mistakes or keep drilling.', 'Back to MCQs', '#/mcq');
  }
  const topicObj = topicById(m.topicId);
  return `
  <div class="stack immersive">
    <div class="row" style="justify-content:space-between">
      <div class="meta">MCQ ${s.index + 1} / ${s.list.length} · Score ${s.correct}/${s.answered} · ${escapeHtml(
        topicObj?.title || ''
      )}</div>
      <button class="btn btn-ghost btn-sm" data-nav="#/mcq" onclick="window.__emClearMcq()">End</button>
    </div>
    <div class="immersive-card">
      <div class="md-body">${renderMarkdown(m.question)}</div>
      <div class="stack" style="margin-top:16px">
        ${m.options
          .map((opt, i) => {
            let cls = 'mcq-opt';
            if (s.selected === i) cls += ' selected';
            if (s.locked) {
              cls += ' locked';
              if (i === m.correctAnswer) cls += ' correct';
              else if (s.selected === i && i !== m.correctAnswer) cls += ' wrong';
            }
            return `<div class="${cls}" data-action="mcq-pick" data-opt="${i}" role="button" tabindex="0">
              <span class="bullet">${String.fromCharCode(65 + i)}</span>
              <span class="md-body">${renderMarkdown(opt)}</span>
            </div>`;
          })
          .join('')}
      </div>
      ${
        !s.locked
          ? `<button class="btn btn-primary btn-lg btn-block" style="margin-top:16px" data-action="mcq-submit">Submit answer</button>`
          : `<div style="margin-top:16px">
              <p>${
                s.selected === m.correctAnswer
                  ? '<span class="badge badge-ok">✓ Correct</span>'
                  : '<span class="badge badge-bad">✕ Incorrect · added to Mistake Book</span>'
              }</p>
              <div class="md-body muted" style="margin:10px 0">${renderMarkdown(m.explanation || '')}</div>
              <button class="btn btn-primary btn-lg" data-action="mcq-next">Next question →</button>
            </div>`
      }
    </div>
  </div>`;
}

window.__emClearMcq = () => {
  app.mcqSession = null;
};

function startMcq(mode) {
  let pool = [...app.content.mcqs];
  if (mode.startsWith('topic:')) {
    const tid = mode.slice(6);
    pool = pool.filter((m) => m.topicId === tid);
  } else if (mode === 'weak') {
    pool.sort((a, b) => (app.state.topics[a.topicId]?.mastery || 0) - (app.state.topics[b.topicId]?.mastery || 0));
  } else {
    pool.sort(() => Math.random() - 0.5);
  }
  const n = mode === 'mixed' ? 20 : mode === 'exam' ? 15 : mode.startsWith('topic:') ? Math.min(12, pool.length) : 10;
  app.mcqSession = {
    list: pool.slice(0, n),
    index: 0,
    selected: null,
    locked: false,
    correct: 0,
    answered: 0,
    mode,
  };
  render();
}

function submitMcq() {
  const s = app.mcqSession;
  if (!s || s.selected == null) return;
  const m = s.list[s.index];
  const ok = s.selected === m.correctAnswer;
  s.locked = true;
  s.answered++;
  if (ok) s.correct++;
  const st = ensureMcq(app.state, m.id);
  st.attempts++;
  if (ok) st.correct++;
  st.last = new Date().toISOString();
  const topicSt = ensureTopic(app.state, m.topicId);
  topicSt.mastery = Math.min(100, (topicSt.mastery || 0) + (ok ? 2 : 0));
  if (!ok) {
    app.state.mistakes.unshift({
      id: `m-${Date.now()}`,
      questionId: m.id,
      topicId: m.topicId,
      userAnswer: m.options[s.selected],
      correctAnswer: m.options[m.correctAnswer],
      explanation: m.explanation || '',
      date: st.last,
      mistakeType: 'memory gap',
      resolved: false,
      kind: 'mcq',
    });
  }
  persist();
  render();
}

function nextMcq() {
  const s = app.mcqSession;
  if (!s) return;
  if (s.index >= s.list.length - 1) {
    app.mcqSession = null;
    navigate('#/progress');
    return;
  }
  s.index++;
  s.selected = null;
  s.locked = false;
  render();
}

function viewMistakes() {
  const open = (app.state.mistakes || []).filter((m) => !m.resolved);
  const types = [
    'concept gap',
    'memory gap',
    'formula error',
    'calculation error',
    'misread question',
    'application error',
    'careless mistake',
  ];
  const counts = Object.fromEntries(types.map((t) => [t, open.filter((m) => m.mistakeType === t).length]));
  const ranked = [...open].sort((a, b) => {
    const pa = livePriority(topicById(a.topicId) || { examImportance: 0.5, frequencyScore: 0.5, foundationScore: 0.5, markEfficiency: 0.5, priorityBase: 50, id: a.topicId }, app.state).score;
    const pb = livePriority(topicById(b.topicId) || { examImportance: 0.5, frequencyScore: 0.5, foundationScore: 0.5, markEfficiency: 0.5, priorityBase: 50, id: b.topicId }, app.state).score;
    return pb - pa;
  });

  if (!open.length) {
    return `
    <div class="stack">
      <div><p class="kicker">Review</p><h1 class="h1">Mistake book</h1></div>
      ${emptyState(
        'No mistakes to fix yet',
        'Attempt questions or MCQs — wrong answers land here so you can convert them into marks.',
        'Practice questions →',
        '#/questions'
      )}
    </div>`;
  }

  return `
  <div class="stack">
    <div>
      <p class="kicker">Review</p>
      <h1 class="h1">${open.length} mistakes to fix</h1>
      <p class="muted" style="margin:0">These are the errors costing you marks.</p>
    </div>
    <div class="grid grid-4">
      ${metricCard('Concept', String(counts['concept gap'] || 0))}
      ${metricCard('Formula', String(counts['formula error'] || 0))}
      ${metricCard('Calculation', String(counts['calculation error'] || 0))}
      ${metricCard('Other', String(open.length - (counts['concept gap'] || 0) - (counts['formula error'] || 0) - (counts['calculation error'] || 0)))}
    </div>
    ${ranked
      .map((m) => {
        const t = topicById(m.topicId);
        const live = livePriority(
          t || { examImportance: 0.5, frequencyScore: 0.5, foundationScore: 0.5, markEfficiency: 0.5, priorityBase: 50, id: m.topicId },
          app.state
        );
        return `<div class="card">
          <div class="row">${badge(live.level)} <span class="badge badge-muted">${escapeHtml(
            m.mistakeType || 'concept gap'
          )}</span></div>
          <h3 class="h3" style="margin-top:8px">${escapeHtml(t?.title || m.topicId)}</h3>
          <p class="meta">Last: ${new Date(m.date).toLocaleString()}</p>
          <p><strong>Your answer:</strong> <span class="md-body">${renderMarkdown(m.userAnswer || '')}</span></p>
          <p><strong>Correct:</strong> <span class="md-body">${renderMarkdown(m.correctAnswer || '')}</span></p>
          <label class="label">Mistake type</label>
          <select class="select" data-action="mistake-type" data-id="${m.id}">
            ${types.map((tp) => `<option value="${tp}" ${m.mistakeType === tp ? 'selected' : ''}>${tp}</option>`).join('')}
          </select>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-primary btn-sm" data-action="mistake-resolve" data-id="${m.id}">Mark resolved →</button>
          </div>
        </div>`;
      })
      .join('')}
  </div>`;
}

function ensurePlanTasks() {
  if (!app.state.planTasks) app.state.planTasks = {};
  return app.state.planTasks;
}

function findPlanTask(taskId) {
  if (!taskId) return null;
  const days = buildFourDayPlan(app.content, app.state, app.state.prefs);
  for (const d of [1, 2, 3, 4]) {
    const hit = days[d].items.find((i) => i.id === taskId);
    if (hit) return hit;
  }
  const saved = app.state.planTasks?.[taskId];
  if (saved) {
    return {
      ...saved,
      estimatedMinutes: saved.durationMinutes || saved.estimatedMinutes || 30,
    };
  }
  // Synthesized study task from topic page (may not be in regenerated plan)
  const m = /^d(\d+)-(study|practice|revise)-(.+)$/.exec(taskId);
  if (m && m[3] && !String(m[3]).startsWith('special-')) {
    const topicId = m[3];
    const t = topicById(topicId);
    if (!t) return null;
    const live = livePriority(t, app.state);
    return {
      id: taskId,
      day: Number(m[1]),
      topicId,
      chapterId: t.chapterId || null,
      title: t.title,
      description: 'Learn the core ideas, key formulas, and exam-level applications.',
      action: m[2],
      type: m[2] === 'revise' ? 'revision' : m[2],
      priority: live.level,
      durationMinutes: t.estimatedMinutes || 30,
      estimatedMinutes: t.estimatedMinutes || 30,
      status: 'upcoming',
      synthesized: true,
    };
  }
  return null;
}

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function planTaskCard(it, { role = 'remaining', dayNum } = {}) {
  const mins = it.durationMinutes || it.estimatedMinutes || 30;
  const typeLabel = (it.type || it.action || 'study').replace(/^\w/, (c) => c.toUpperCase());
  const completedAt = it.completedAt
    ? new Date(it.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  if (role === 'completed' || it.status === 'completed') {
    return `<article class="plan-card plan-card-done">
      <div class="plan-card-status">✓ Completed</div>
      <div class="plan-card-meta">
        <span class="plan-card-time">${escapeHtml(it.scheduledTime || '—')}</span>
        ${badge(it.priority, false)}
        <span class="meta">${mins} min · ${escapeHtml(typeLabel)}</span>
      </div>
      <h3 class="plan-card-title">${escapeHtml(it.title)}</h3>
      <p class="meta">Completed at ${escapeHtml(completedAt || '—')}</p>
      <div class="plan-card-actions">
        <button class="btn btn-secondary btn-sm" data-action="plan-review" data-id="${escapeHtml(it.id)}">Review</button>
      </div>
    </article>`;
  }

  if (role === 'current') {
    return `<article class="plan-card plan-card-current">
      <div class="plan-card-status">Current</div>
      <div class="plan-card-meta">
        <span class="plan-card-time">${escapeHtml(it.scheduledTime || '—')}</span>
        ${badge(it.priority, false)}
        <span class="meta">${mins} min · ${escapeHtml(typeLabel)}</span>
        ${it.status === 'overdue' ? '<span class="badge badge-warn">Overdue</span>' : ''}
      </div>
      <h3 class="plan-card-title">${escapeHtml(it.title)}</h3>
      <p class="plan-card-desc">${escapeHtml(it.description || 'Your next highest-priority task.')}</p>
      <div class="plan-card-actions">
        <button class="btn btn-primary" data-action="plan-start" data-id="${escapeHtml(it.id)}">${
          it.status === 'in_progress' ? 'Continue Studying →' : it.status === 'overdue' ? 'Start Now →' : 'Start Studying →'
        }</button>
        <button class="btn btn-ok" data-action="plan-finish" data-id="${escapeHtml(it.id)}">✓ Finish &amp; Mark Complete</button>
      </div>
    </article>`;
  }

  return `<article class="plan-card ${it.status === 'overdue' ? 'plan-card-overdue' : ''}">
    <div class="plan-card-meta">
      <span class="plan-card-time">${escapeHtml(it.scheduledTime || '—')}</span>
      ${badge(it.priority, false)}
      <span class="meta">${mins} min · ${escapeHtml(typeLabel)}</span>
      ${it.status === 'overdue' ? '<span class="badge badge-warn">Overdue</span>' : ''}
    </div>
    <h3 class="plan-card-title">${escapeHtml(it.title)}</h3>
    ${it.description ? `<p class="plan-card-desc">${escapeHtml(it.description)}</p>` : ''}
    <div class="plan-card-actions">
      <button class="btn btn-primary btn-sm" data-action="plan-start" data-id="${escapeHtml(it.id)}">${
        it.status === 'overdue' ? 'Start Now →' : 'Start →'
      }</button>
      <button class="btn btn-ghost btn-sm" data-action="plan-skip" data-id="${escapeHtml(it.id)}">Skip</button>
    </div>
  </article>`;
}

function viewPlan() {
  if (!app.state.planTasks) app.state.planTasks = {};
  const days = buildFourDayPlan(app.content, app.state, app.state.prefs);
  const timing = getExamTiming(app.state.prefs);
  const dayNum = Math.min(4, Math.max(1, Number(app.route.params.day) || timing.prepDay || 1));
  const day = days[dayNum];
  const sum = summarizePlanDay(day);
  const remainingOnly = sum.remaining.filter((i) => !sum.current || i.id !== sum.current.id);

  let sylPct = 0;
  let masteryPct = 0;
  try {
    const cov = computeSyllabusCoverage(app.content, app.state);
    sylPct = cov.coveragePct;
    masteryPct = cov.masteryPct;
  } catch (_) {
    /* ignore */
  }
  const qAttempted = Object.values(app.state.questions || {}).filter((q) => q.attempted).length;
  const qTotal = app.content.questions?.length || 1;
  const practicePct = Math.round((100 * qAttempted) / qTotal);

  const dayTabs = [1, 2, 3, 4]
    .map((d) => {
      const s = summarizePlanDay(days[d]);
      const active = d === dayNum;
      const label = s.allDone ? `✓ Day ${d}` : `Day ${d}`;
      const sub = s.allDone ? 'Complete' : d < timing.prepDay && !s.allDone ? `${s.pct}%` : d === timing.prepDay ? `${s.pct}%` : d > timing.prepDay ? 'Upcoming' : `${s.pct}%`;
      return `<button type="button" class="day-tab ${active ? 'active' : ''} ${s.allDone ? 'done' : ''}" data-nav="#/plan?day=${d}">
        <span class="day-tab-label">${label}</span>
        <span class="day-tab-sub">${escapeHtml(sub)}</span>
      </button>`;
    })
    .join('');

  return `
  <div class="stack plan-view">
    <div>
      <p class="kicker">Exam execution</p>
      <h1 class="h1">4-Day plan</h1>
      <p class="muted" style="margin:0">What you've finished · what to do next · not a decorative calendar</p>
    </div>

    <div class="day-tabs">${dayTabs}</div>

    <div class="grid grid-4 plan-metrics">
      ${metricCard('Day plan', `${sum.doneCount} / ${sum.total}`, 'tasks completed')}
      ${metricCard('Syllabus', `${sylPct}%`, 'coverage — separate')}
      ${metricCard('Practice', `${practicePct}%`, 'questions attempted')}
      ${metricCard('Mastery', `${masteryPct}%`, 'performance')}
    </div>

    ${
      sum.allDone
        ? `<div class="panel plan-day-complete">
        <p class="kicker">✓ Day ${dayNum} complete</p>
        <h2 class="h2" style="margin:0">${escapeHtml(day.title)}</h2>
        <p class="muted">${sum.doneCount} / ${sum.total} tasks · ${Math.floor(sum.minsDone / 60)}h ${sum.minsDone % 60}m planned blocks finished</p>
        <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary" data-nav="#/plan?day=${dayNum}">Review Day ${dayNum}</button>
          ${dayNum < 4 ? `<button class="btn btn-primary" data-nav="#/plan?day=${dayNum + 1}">Go to Day ${dayNum + 1} →</button>` : `<button class="btn btn-primary" data-nav="#/mock">Final mock →</button>`}
        </div>
      </div>`
        : ''
    }

    <div class="panel">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div>
          <p class="kicker">Day ${dayNum} · Day plan progress</p>
          <h2 class="h2" style="margin:0">${escapeHtml(day.title)}</h2>
          <p class="muted" style="margin:6px 0 0">${escapeHtml(day.focus)}</p>
        </div>
        <div class="meta" style="text-align:right">
          <strong style="font-size:1.25rem;color:var(--navy)">${sum.pct}%</strong><br/>
          ${sum.doneCount} of ${sum.total} tasks
        </div>
      </div>
      <div class="progress progress-lg" style="margin-top:12px"><span style="width:${sum.pct}%"></span></div>
      <div class="row" style="margin-top:8px;justify-content:space-between">
        <span class="meta">${Math.floor(sum.minsDone / 60)}h ${sum.minsDone % 60}m completed (planned)</span>
        <span class="meta">${Math.floor(sum.minsLeft / 60)}h ${sum.minsLeft % 60}m remaining</span>
      </div>
    </div>

    ${
      sum.current
        ? `<section class="plan-section">
        <h3 class="plan-section-title">→ Current / Up next</h3>
        ${planTaskCard(sum.current, { role: 'current', dayNum })}
      </section>`
        : ''
    }

    ${
      sum.completed.length
        ? `<section class="plan-section">
        <h3 class="plan-section-title">✓ Completed</h3>
        <div class="plan-card-list">
          ${sum.completed.map((it) => planTaskCard(it, { role: 'completed', dayNum })).join('')}
        </div>
      </section>`
        : ''
    }

    ${
      remainingOnly.length
        ? `<section class="plan-section">
        <h3 class="plan-section-title">○ Remaining</h3>
        <div class="plan-card-list">
          ${remainingOnly.map((it) => planTaskCard(it, { role: 'remaining', dayNum })).join('')}
        </div>
      </section>`
        : !sum.allDone
          ? `<p class="muted">No remaining tasks for this day.</p>`
          : ''
    }
  </div>`;
}

function viewPlanSession() {
  const taskId = app.route.params.id;
  const it = findPlanTask(taskId);
  if (!it) {
    return emptyState('Task not found', 'This plan task may have changed. Return to the 4-Day plan.', '4-Day Plan', '#/plan');
  }
  if (it.status === 'completed') {
    return emptyState('Already completed', `${it.title} is marked complete.`, 'Back to plan', `#/plan?day=${it.day || 1}`);
  }

  // Ensure session
  if (!app.planSession || app.planSession.taskId !== taskId) {
    startPlanSession(it);
  }
  const sess = app.planSession;
  const plannedSec = (it.durationMinutes || 30) * 60;
  const elapsed = sess.elapsedSeconds || 0;
  const pct = Math.min(100, Math.round((100 * elapsed) / plannedSec));
  const timeUp = elapsed >= plannedSec;
  const topic = it.topicId ? topicById(it.topicId) : null;

  return `
  <div class="stack plan-session">
    <div class="row" style="justify-content:space-between">
      <button class="btn btn-ghost btn-sm" data-action="plan-exit-session" data-day="${it.day || 1}">← Plan</button>
      <span class="meta">Day ${it.day || '—'} · ${badge(it.priority, false)}</span>
    </div>

    <div class="panel">
      <p class="kicker">${escapeHtml((it.type || it.action || 'study').toUpperCase())} · ${it.scheduledTime || ''}</p>
      <h1 class="h1" style="margin:0">${escapeHtml(it.title)}</h1>
      <p class="muted">${escapeHtml(it.description || '')}</p>

      <div class="plan-timer">
        <div class="row" style="justify-content:space-between">
          <div>
            <div class="meta">Planned</div>
            <strong>${formatElapsed(plannedSec)}</strong>
          </div>
          <div style="text-align:right">
            <div class="meta">Elapsed</div>
            <strong id="plan-elapsed">${formatElapsed(elapsed)}</strong>
          </div>
        </div>
        <div class="progress progress-lg" style="margin-top:10px"><span id="plan-timer-bar" style="width:${pct}%"></span></div>
        <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary" data-action="plan-timer-toggle">${sess.paused ? 'Resume' : 'Pause'}</button>
          <button class="btn btn-primary" data-action="plan-open-material" data-id="${escapeHtml(it.id)}">Open study material →</button>
        </div>
      </div>

      ${
        timeUp
          ? `<div class="plan-timeup">
          <strong>Planned study time reached.</strong>
          <p class="muted" style="margin:6px 0 0">Have you finished this topic? Timer end does <em>not</em> mark the task complete.</p>
          <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
            <button class="btn btn-secondary" data-action="plan-timer-continue">Continue Studying</button>
            <button class="btn btn-ok" data-action="plan-finish" data-id="${escapeHtml(it.id)}">✓ Finish &amp; Mark Complete</button>
          </div>
        </div>`
          : ''
      }
    </div>

    ${
      topic
        ? `<div class="card">
        <h3 class="h3">Quick formulas</h3>
        <div class="md-body">${renderMarkdown((topic.formulas || []).slice(0, 4).map((f) => `$$${f}$$`).join('\n\n'))}</div>
      </div>`
        : `<div class="card"><p class="muted">Use Open study material to jump into the linked activity.</p></div>`
    }

    <div class="panel plan-finish-cta">
      <p class="kicker">Finished this topic?</p>
      <p style="margin:0 0 12px">Mark <strong>${escapeHtml(it.title)}</strong> as completed once you've finished the planned study. This does not auto-master the topic.</p>
      <button class="btn btn-ok btn-lg" data-action="plan-finish" data-id="${escapeHtml(it.id)}">✓ Finish &amp; Mark Complete</button>
    </div>
  </div>`;
}

function startPlanSession(it) {
  stopPlanTimer();
  const saved = ensurePlanTasks()[it.id] || {};
  app.planSession = {
    taskId: it.id,
    day: it.day,
    startedAt: saved.startedAt || new Date().toISOString(),
    elapsedSeconds: saved.elapsedSeconds || 0,
    paused: false,
    title: it.title,
  };
  // Mark in progress (activity only — not completion)
  ensurePlanTasks()[it.id] = {
    ...it,
    ...saved,
    id: it.id,
    day: it.day,
    title: it.title,
    durationMinutes: it.durationMinutes || it.estimatedMinutes,
    status: 'in_progress',
    startedAt: app.planSession.startedAt,
    elapsedSeconds: app.planSession.elapsedSeconds,
  };
  persist();
  app.planTimerId = setInterval(() => {
    if (!app.planSession || app.planSession.paused) return;
    app.planSession.elapsedSeconds += 1;
    const el = $('#plan-elapsed');
    const bar = $('#plan-timer-bar');
    const planned = (it.durationMinutes || 30) * 60;
    if (el) el.textContent = formatElapsed(app.planSession.elapsedSeconds);
    if (bar) bar.style.width = `${Math.min(100, Math.round((100 * app.planSession.elapsedSeconds) / planned))}%`;
    // Persist lightly every 30s
    if (app.planSession.elapsedSeconds % 30 === 0) {
      const pt = ensurePlanTasks()[it.id];
      if (pt) {
        pt.elapsedSeconds = app.planSession.elapsedSeconds;
        persist();
      }
    }
    // Re-render once when crossing planned time for the banner
    if (app.planSession.elapsedSeconds === planned) render();
  }, 1000);
}

function stopPlanTimer() {
  if (app.planTimerId) {
    clearInterval(app.planTimerId);
    app.planTimerId = null;
  }
}

function requestFinishPlanTask(taskId) {
  const it = findPlanTask(taskId);
  if (!it) {
    toast('Task not found');
    return;
  }
  if (it.status === 'completed') {
    toast('Already completed');
    return;
  }
  const dayNum = it.day || 1;
  const daysBefore = buildFourDayPlan(app.content, app.state, app.state.prefs);
  const sum = summarizePlanDay(daysBefore[dayNum]);
  const afterDone = sum.doneCount + 1;
  const afterTotal = sum.total;

  requestProgressConfirm({
    action: 'mark-complete',
    title: 'Finish this study session?',
    itemName: it.title,
    confirmLabel: '✓ Yes, Mark Complete',
    successMessage: `✓ ${it.title} completed`,
    bodyHtml: `Marking this task complete will update <strong>Day ${dayNum} plan progress</strong> and study activity. It does <strong>not</strong> auto-master the topic.`,
    effects: [
      `${it.durationMinutes || it.estimatedMinutes || 30} min · ${it.priority} · ${it.type || it.action}`,
      `Today: ${sum.doneCount} / ${sum.total} tasks complete`,
      `After confirmation: ${afterDone} / ${afterTotal} tasks complete`,
    ],
    progressBars: [
      {
        label: `Day ${dayNum} plan`,
        before: sum.pct,
        after: afterTotal ? Math.round((100 * afterDone) / afterTotal) : 100,
      },
    ],
    snapshot: () => cloneState(app.state),
    apply: async () => {
      stopPlanTimer();
      const elapsed = app.planSession?.taskId === taskId ? app.planSession.elapsedSeconds : it.elapsedSeconds || 0;
      const now = new Date().toISOString();
      ensurePlanTasks()[taskId] = {
        id: taskId,
        day: dayNum,
        title: it.title,
        description: it.description,
        action: it.action,
        type: it.type,
        priority: it.priority,
        topicId: it.topicId,
        chapterId: it.chapterId,
        durationMinutes: it.durationMinutes || it.estimatedMinutes,
        scheduledTime: it.scheduledTime,
        status: 'completed',
        startedAt: it.startedAt || now,
        completedAt: now,
        elapsedSeconds: elapsed,
      };
      if (it.topicId) {
        const ts = ensureTopic(app.state, it.topicId);
        ts.lastStudied = now;
        if (ts.status === 'not_started') ts.status = 'in_progress';
      }
      bumpDaily(app.state, {
        minutes: Math.round(elapsed / 60) || Math.round((it.durationMinutes || 20) * 0.5),
        topicsCovered: it.topicId ? 1 : 0,
      });
      app.planSession = null;
      await persist();
    },
    onUndo: async (snapshot) => {
      app.state = snapshot;
      await persist();
      render();
    },
    onSuccess: (msg, undo) => {
      const daysAfter = buildFourDayPlan(app.content, app.state, app.state.prefs);
      const next = summarizePlanDay(daysAfter[dayNum]).current;
      const nextLine = next
        ? `Next up: ${next.title} · ${next.durationMinutes || next.estimatedMinutes} min`
        : `Day ${dayNum} plan complete`;
      toast(`${msg} · ${nextLine}`, { undo });
    },
    onDone: () => {
      navigate(`#/plan?day=${dayNum}`);
    },
  });
}

function requestSkipPlanTask(taskId) {
  const it = findPlanTask(taskId);
  if (!it) return;
  confirmProgressChange({
    action: 'mark-complete',
    title: 'Skip this task?',
    itemName: it.title,
    confirmLabel: 'Yes, Skip Task',
    successMessage: 'Task skipped',
    bodyHtml:
      "Skipping leaves this block out of today's completion count. You can still study the material later from Topics / Coverage.",
    effects: ['Will not count as day-plan completed', 'Syllabus coverage unchanged'],
    apply: () => {
      ensurePlanTasks()[taskId] = {
        ...(ensurePlanTasks()[taskId] || {}),
        ...it,
        id: taskId,
        status: 'skipped',
        completedAt: null,
      };
    },
  });
}

function viewRevision() {
  if (!app.revision) {
    return `<div class="stack">
      <div><p class="kicker">Review</p><h1 class="h1">Rapid revision</h1>
      <p class="muted">Formulas · definitions · traps. No rabbit holes.</p></div>
      <div class="card"><button class="btn btn-primary btn-lg" data-action="start-revision">Start revision deck →</button></div>
    </div>`;
  }
  const c = app.revision.cards[app.revision.index];
  if (!c) {
    return emptyState('Revision complete', 'You cleared this deck. Keep momentum with a mock or mistake repair.', 'Dashboard', '#/dashboard');
  }
  return `
  <div class="stack immersive">
    <div class="row" style="justify-content:space-between">
      <span class="meta">REVISION · ${app.revision.index + 1} / ${app.revision.cards.length} · ${escapeHtml(c.kind)}</span>
      <button class="btn btn-ghost btn-sm" data-nav="#/dashboard" onclick="window.__emClearRev()">Exit</button>
    </div>
    <div class="immersive-card">
      <h2 class="h2" style="font-size:1.5rem;line-height:1.35">${escapeHtml(c.front)}</h2>
      ${
        app.revision.revealed
          ? `<div class="md-body" style="margin-top:24px;font-size:16px">${renderMarkdown(c.back)}</div>`
          : `<button class="btn btn-primary btn-lg" style="margin-top:32px" data-action="rev-reveal">Reveal</button>`
      }
    </div>
    <div class="row" style="justify-content:center">
      <button class="btn btn-secondary" data-action="rev-prev">Previous</button>
      <button class="btn btn-ok" data-action="rev-know">I know this</button>
      <button class="btn btn-warn" data-action="rev-again">Review again</button>
      <button class="btn btn-primary" data-action="rev-next">Next →</button>
    </div>
  </div>`;
}

window.__emClearRev = () => {
  app.revision = null;
};

function startRevision() {
  const timing = getExamTiming(app.state.prefs);
  let cards = [...app.content.revisionCards];
  // Prefer P1 / weak
  cards.sort((a, b) => {
    const ta = topicById(a.topicId);
    const tb = topicById(b.topicId);
    return livePriority(tb, app.state).score - livePriority(ta, app.state).score;
  });
  if (timing.prepDay === 4) cards = cards.filter((c) => livePriority(topicById(c.topicId), app.state).level === 'P1' || c.kind === 'formula');
  app.revision = { cards: cards.slice(0, 60), index: 0, revealed: false };
  render();
}

function revisionAnswer(know) {
  const c = app.revision?.cards[app.revision.index];
  if (!c) return;
  scheduleRevision(app.state, c.id, know);
  const st = ensureTopic(app.state, c.topicId);
  st.mastery = Math.min(100, (st.mastery || 0) + (know ? 1 : 0));
  persist();
  app.revision.revealed = false;
  if (app.revision.index < app.revision.cards.length - 1) app.revision.index++;
  render();
}

function viewMock() {
  if (!app.mock) {
    return `<div class="stack">
      <div><h1 class="h1">Final Mock</h1><p class="muted">Timed practice from the solved bank. Mark for review, submit, analyze.</p></div>
      <div class="grid grid-3">
        <div class="card"><h3 class="h3">Quick mock</h3><p class="muted">10 Q · ~30 min</p><button class="btn btn-primary" data-action="mock-start" data-count="10">Start</button></div>
        <div class="card"><h3 class="h3">Standard</h3><p class="muted">20 Q · ~60 min</p><button class="btn btn-primary" data-action="mock-start" data-count="20">Start</button></div>
        <div class="card"><h3 class="h3">Heavy</h3><p class="muted">30 Q · ~90 min</p><button class="btn btn-warn" data-action="mock-start" data-count="30">Start</button></div>
      </div>
      ${
        app.state.mockHistory.length
          ? `<div class="card"><h3 class="h3">History</h3>${app.state.mockHistory
              .map(
                (m) =>
                  `<div class="row" style="justify-content:space-between"><span>${new Date(
                    m.at
                  ).toLocaleString()}</span><strong>${m.percent}%</strong></div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`;
  }
  if (app.mock.result) {
    const r = app.mock.result;
    return `<div class="stack">
      <div class="card">
        <h1 class="h1">Exam Analysis</h1>
        <div class="grid grid-4">
          ${metricCard('Score', r.correct + '/' + r.total)}
          ${metricCard('Accuracy', r.percent + '%')}
          ${metricCard('Skipped', String(r.skipped))}
          ${metricCard('Flagged', String(r.flagged))}
        </div>
        <h3 class="h3" style="margin-top:1rem">Weak topics</h3>
        <ul>${r.weakTopics.map((t) => `<li>${escapeHtml(t)}</li>`).join('') || '<li>None flagged</li>'}</ul>
        <h3 class="h3">Recommended final revision</h3>
        <p class="muted">${escapeHtml(r.recommend)}</p>
        <button class="btn btn-primary" data-nav="#/revision">Rapid Revision</button>
        <button class="btn btn-ghost" data-nav="#/mistakes">Mistake Book</button>
        <button class="btn btn-ghost" onclick="window.__emClearMock(); location.hash='#/mock'">New mock</button>
      </div>
    </div>`;
  }
  const qid = app.mock.order[app.mock.index];
  const q = questionById(qid);
  const remaining = Math.max(0, app.mock.endsAt - Date.now());
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  return `
  <div class="stack">
    <div class="row" style="justify-content:space-between">
      <strong>Mock Q ${app.mock.index + 1}/${app.mock.order.length}</strong>
      <span class="badge badge-p2">${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}</span>
    </div>
    <div class="row" style="flex-wrap:wrap">
      ${app.mock.order
        .map((_, i) => {
          const id = app.mock.order[i];
          const answered = !!app.mock.answers[id];
          const flagged = !!app.mock.flags[id];
          return `<button class="btn btn-sm ${i === app.mock.index ? 'btn-primary' : answered ? 'btn-ok' : 'btn-ghost'}" data-action="mock-nav" data-idx="${i}">${
            i + 1
          }${flagged ? '*' : ''}</button>`;
        })
        .join('')}
    </div>
    <div class="card">
      <div class="md-body">${renderMarkdown(q?.text || '')}</div>
      <p class="muted" style="margin-top:.75rem">Self-score after you finish (reveal solutions post-submit). For now mark:</p>
      <div class="row">
        <button class="btn btn-ok btn-sm" data-action="mock-answer" data-val="correct">I solved it</button>
        <button class="btn btn-bad btn-sm" data-action="mock-answer" data-val="wrong">Could not solve</button>
        <button class="btn btn-ghost btn-sm" data-action="mock-flag">Mark for review</button>
      </div>
      <div class="row" style="margin-top:1rem">
        <button class="btn btn-ghost" data-action="mock-nav" data-idx="${Math.max(0, app.mock.index - 1)}">Prev</button>
        <button class="btn btn-ghost" data-action="mock-nav" data-idx="${Math.min(
          app.mock.order.length - 1,
          app.mock.index + 1
        )}">Next</button>
        <span class="spacer"></span>
        <button class="btn btn-warn" data-action="mock-submit">Submit mock</button>
      </div>
    </div>
  </div>`;
}

window.__emClearMock = () => {
  app.mock = null;
};

function startMock(count) {
  const pool = [...app.content.questions].sort(() => Math.random() - 0.5).slice(0, count);
  const minutes = count === 10 ? 30 : count === 30 ? 90 : 60;
  app.mock = {
    order: pool.map((q) => q.id),
    index: 0,
    answers: {},
    flags: {},
    endsAt: Date.now() + minutes * 60000,
    result: null,
  };
  if (app._mockTimer) clearInterval(app._mockTimer);
  app._mockTimer = setInterval(() => {
    if (!app.mock || app.mock.result) return;
    if (Date.now() >= app.mock.endsAt) submitMock();
    else if (app.route.name === 'mock') {
      // refresh timer label lightly
      const el = document.querySelector('.badge.badge-p2');
      if (el) {
        const remaining = Math.max(0, app.mock.endsAt - Date.now());
        const mm = Math.floor(remaining / 60000);
        const ss = Math.floor((remaining % 60000) / 1000);
        el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      }
    }
  }, 1000);
  render();
}

function submitMock() {
  if (!app.mock || app.mock.result) return;
  const total = app.mock.order.length;
  let correct = 0;
  let skipped = 0;
  const weak = {};
  for (const qid of app.mock.order) {
    const ans = app.mock.answers[qid];
    const q = questionById(qid);
    if (!ans) skipped++;
    else if (ans === 'correct') {
      correct++;
      ensureQuestion(app.state, qid).attempted = true;
      ensureQuestion(app.state, qid).correct = true;
    } else {
      ensureQuestion(app.state, qid).attempted = true;
      ensureQuestion(app.state, qid).correct = false;
      weak[q.topicId] = (weak[q.topicId] || 0) + 1;
      app.state.mistakes.unshift({
        id: `m-${Date.now()}-${qid}`,
        questionId: qid,
        topicId: q.topicId,
        userAnswer: '(mock: could not solve)',
        correctAnswer: q.answer || '',
        explanation: '',
        date: new Date().toISOString(),
        mistakeType: 'application error',
        resolved: false,
      });
    }
  }
  const percent = Math.round((correct / total) * 100);
  const weakTopics = Object.entries(weak)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => topicById(id)?.title || id);
  const result = {
    total,
    correct,
    skipped,
    flagged: Object.values(app.mock.flags).filter(Boolean).length,
    percent,
    weakTopics,
    recommend:
      weakTopics[0]
        ? `Revise ${weakTopics.slice(0, 3).join(', ')} then re-drill mistake book.`
        : 'Solid mock — skim P1 formulas and rest.',
  };
  app.mock.result = result;
  app.state.mockHistory.unshift({ at: new Date().toISOString(), percent, total, correct });
  persist();
  render();
}

function getFormulaChapters(filterChapterId = 'all') {
  const chapters = [...(app.content.chapters || [])].sort((a, b) => (a.number || 0) - (b.number || 0));
  return chapters
    .filter((ch) => filterChapterId === 'all' || ch.id === filterChapterId)
    .map((ch) => {
      const topics = app.content.topics
        .filter((t) => {
          if (t.chapterId !== ch.id) return false;
          const hasEq = Array.isArray(t.formulas) && t.formulas.length;
          const hasTables = Array.isArray(t.formulaTables) && t.formulaTables.length;
          return hasEq || hasTables;
        })
        .sort((a, b) => {
          // Reference sheets first within a chapter
          if (!!b.isReference !== !!a.isReference) return a.isReference ? -1 : 1;
          return String(a.title).localeCompare(String(b.title));
        });
      const formulaCount = topics.reduce(
        (s, t) => s + (t.formulas?.length || 0) + (t.formulaTables?.length || 0),
        0
      );
      return { chapter: ch, topics, formulaCount };
    })
    .filter((block) => block.formulaCount > 0);
}

function renderFormulaSheetHtml(blocks, { forPrint = false, showScreenChrome = true } = {}) {
  const totalFormulas = blocks.reduce((s, b) => s + b.formulaCount, 0);
  const totalTopics = blocks.reduce((s, b) => s + b.topics.length, 0);
  const dateStr = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const body = blocks
    .map(({ chapter, topics, formulaCount }) => {
      const topicBlocks = topics
        .map((t, ti) => {
          const topicAnchor = `formula-topic-${escapeHtml(t.id)}`;
          const formulas = (t.formulas || [])
            .map((f, fi) =>
              forPrint
                ? `<tr class="eq-row">
                    <td class="eq-num">${chapter.number}.${ti + 1}.${fi + 1}</td>
                    <td class="eq-body md-body">$$${f}$$</td>
                  </tr>`
                : `<div class="formula-sheet-item">
                    <div class="formula-sheet-eq md-body">$$${f}$$</div>
                    <div class="formula-sheet-num">${ti + 1}.${fi + 1}</div>
                  </div>`
            )
            .join('');
          const tables = (t.formulaTables || [])
            .map(
              (tb) => `<div class="formula-table-block" id="formula-table-${escapeHtml(t.id)}-${escapeHtml(tb.id || tb.code || 't')}">
              <h4 class="formula-table-title">${escapeHtml(tb.title)}</h4>
              <div class="md-body formula-table-md">${renderMarkdown(tb.markdown || '')}</div>
            </div>`
            )
            .join('');
          const tablesBlock = tables
            ? `<div class="formula-tables-wrap"><p class="formula-tables-label">Reference tables</p>${tables}</div>`
            : '';
          const eqBlock = forPrint
            ? formulas
              ? `<table class="eq-table"><tbody>${formulas}</tbody></table>`
              : ''
            : formulas
              ? `<div class="formula-topic-list">${formulas}</div>`
              : '';
          return `<section class="formula-topic" id="${topicAnchor}">
            <h3 class="formula-topic-title">${escapeHtml(t.title)}${
              !forPrint && t.isReference ? ' <span class="badge badge-muted">Reference</span>' : ''
            }</h3>
            ${tablesBlock}
            ${eqBlock}
          </section>`;
        })
        .join('');
      return `<section class="formula-chapter" id="formula-ch-${escapeHtml(chapter.id)}">
        <header class="formula-chapter-head">
          <div>
            <p class="kicker">Chapter ${chapter.number}</p>
            <h2>${escapeHtml(chapter.title)}</h2>
          </div>
          ${showScreenChrome ? `<div class="meta">${topics.length} topics · ${formulaCount} items</div>` : ''}
        </header>
        ${topicBlocks}
      </section>`;
    })
    .join('');

  const tocHtml = `<nav class="formula-toc-full">
    <h2 class="formula-toc-heading">Table of Contents</h2>
    <p class="formula-toc-note muted">${blocks.length} chapter${blocks.length === 1 ? '' : 's'} · ${totalTopics} topics · ${totalFormulas} items</p>
    <ol class="formula-toc-chapters">
      ${blocks
        .map(
          ({ chapter, topics, formulaCount }) => `<li>
          <button type="button" class="formula-toc-ch" data-action="scroll-to" data-target="formula-ch-${escapeHtml(
            chapter.id
          )}"><strong>Ch.${chapter.number}</strong> ${escapeHtml(chapter.title)}
          <span class="meta">${topics.length} · ${formulaCount}</span></button>
          <ol class="formula-toc-topics">
            ${topics
              .map(
                (t) => `<li><button type="button" class="formula-toc-topic" data-action="scroll-to" data-target="formula-topic-${escapeHtml(
                  t.id
                )}">${escapeHtml(t.title)}${
                  (t.formulaTables || []).some((x) => /differential/i.test(x.title || ''))
                    ? ' · differential elements'
                    : ''
                }</button></li>`
              )
              .join('')}
          </ol>
        </li>`
        )
        .join('')}
    </ol>
  </nav>`;

  const tocPrint = `<nav class="formula-toc-print">
    <h2>Contents</h2>
    <ol class="toc-ch">
      ${blocks
        .map(
          ({ chapter, topics }) => `<li>
            <span class="toc-ch-title">${chapter.number}. ${escapeHtml(chapter.title)}</span>
            <ol class="toc-topic">${topics
              .map((t, i) => `<li>${chapter.number}.${i + 1} ${escapeHtml(t.title)}</li>`)
              .join('')}</ol>
          </li>`
        )
        .join('')}
    </ol>
  </nav>`;

  if (forPrint) {
    const printCss = formulaPdfStyles();
    const printInner = `
  <header class="sheet-cover">
    <div class="code">ENEX 254 · Electromagnetics</div>
    <h1>Formula Sheet</h1>
    <div class="meta">${escapeHtml(dateStr)} · ${blocks.length} chapters · ${totalTopics} topics · ${totalFormulas} items</div>
  </header>
  ${tocPrint}
  ${body}
  <footer class="sheet-foot">
    <span>EM Exam Prep — formulas only</span>
    <span>${escapeHtml(dateStr)}</span>
  </footer>`;
    return { css: printCss, html: printInner, meta: { dateStr, totalTopics, totalFormulas } };
  }

  return `${tocHtml}${body}`;
}

function formulaPdfStyles() {
  return `
    * { box-sizing: border-box; }
    .formula-pdf-sheet {
      font-family: "Times New Roman", Times, "Liberation Serif", serif;
      color: #222;
      line-height: 1.35;
      margin: 0;
      padding: 8px 12px;
      font-size: 10.5pt;
      font-weight: 400;
      font-synthesis: none;
      background: #fff;
      width: 794px;
    }
    h1, h2, h3, h4, strong, b, th { font-weight: 600; }
    .sheet-cover {
      border-bottom: 1.5px solid #333;
      padding-bottom: 8px;
      margin-bottom: 14px;
    }
    .sheet-cover .code { font-size: 9pt; letter-spacing: .04em; text-transform: uppercase; font-weight: 400; color: #444; }
    .sheet-cover h1 { margin: 2px 0 4px; font-size: 17pt; font-weight: 600; }
    .sheet-cover .meta { font-size: 9.5pt; font-weight: 400; color: #444; }
    .formula-toc-print { margin: 0 0 16px; padding-bottom: 10px; border-bottom: 1px solid #ccc; }
    .formula-toc-print h2 {
      margin: 0 0 8px;
      font-size: 12pt;
      font-weight: 600;
      border-bottom: 1px solid #333;
      padding-bottom: 3px;
    }
    .toc-ch { margin: 0; padding-left: 18px; }
    .toc-ch > li { margin: 6px 0; font-weight: 400; }
    .toc-ch-title { font-weight: 600; font-size: 11pt; }
    .toc-topic { margin: 2px 0 0; padding-left: 16px; font-size: 9.5pt; font-weight: 400; }
    .toc-topic li { margin: 1px 0; }
    .formula-chapter { margin: 18px 0 10px; page-break-before: always; }
    .formula-chapter:first-of-type { page-break-before: auto; margin-top: 0; }
    .formula-chapter-head {
      border-bottom: 1px solid #333;
      padding-bottom: 4px;
      margin-bottom: 8px;
    }
    .formula-chapter-head .kicker {
      margin: 0;
      font-size: 8.5pt;
      font-weight: 600;
      letter-spacing: .05em;
      text-transform: uppercase;
      color: #444;
    }
    .formula-chapter-head h2 { margin: 1px 0 0; font-size: 12.5pt; font-weight: 600; }
    .formula-topic { margin: 0 0 10px; }
    .formula-topic-title {
      margin: 8px 0 4px;
      font-size: 10.5pt;
      font-weight: 600;
      border-bottom: 0.5px solid #bbb;
      padding-bottom: 2px;
    }
    .formula-tables-label { display: none; }
    .formula-table-title {
      margin: 8px 0 3px;
      font-size: 10pt;
      font-weight: 600;
      font-style: italic;
    }
    .formula-table-md table {
      width: 100%;
      border-collapse: collapse;
      font-size: 8.5pt;
      font-weight: 400;
      margin: 4px 0 8px;
      page-break-inside: avoid;
    }
    .formula-table-md th,
    .formula-table-md td {
      border: 1px solid #666;
      padding: 4px 5px;
      vertical-align: top;
      text-align: left;
      font-weight: 400;
    }
    .formula-table-md th { background: #f3f3f3; font-weight: 600; }
    .eq-table { width: 100%; border-collapse: collapse; margin: 0 0 6px; }
    .eq-row { page-break-inside: avoid; }
    .eq-num {
      width: 3.2em;
      vertical-align: top;
      padding: 3px 6px 3px 0;
      font-size: 8.5pt;
      color: #555;
      font-weight: 400;
      white-space: nowrap;
    }
    .eq-body {
      vertical-align: middle;
      padding: 2px 0 4px;
      text-align: center;
      font-weight: 400;
    }
    mjx-container, .mjx-svg, .MathJax { font-weight: 400 !important; }
    mjx-container svg { opacity: 0.92; }
    footer.sheet-foot {
      margin-top: 16px;
      padding-top: 6px;
      border-top: 1px solid #333;
      font-size: 8.5pt;
      font-weight: 400;
      color: #555;
      display: flex;
      justify-content: space-between;
    }
    .badge, button, .meta { } /* keep meta visible in chapter heads if present */
    .badge, button { display: none !important; }
  `;
}

function viewFormulas() {
  const chFilter = app.route.params.ch || 'all';
  const blocks = getFormulaChapters(chFilter);
  const allBlocks = getFormulaChapters('all');
  const totalFormulas = allBlocks.reduce((s, b) => s + b.formulaCount, 0);
  const filteredOnly = chFilter !== 'all';

  const chips = [
    `<button class="btn btn-sm ${chFilter === 'all' ? 'btn-primary' : 'btn-secondary'}" data-nav="#/formulas">All</button>`,
    ...(app.content.chapters || [])
      .slice()
      .sort((a, b) => (a.number || 0) - (b.number || 0))
      .map(
        (ch) =>
          `<button class="btn btn-sm ${chFilter === ch.id ? 'btn-primary' : 'btn-secondary'}" data-nav="#/formulas?ch=${encodeURIComponent(
            ch.id
          )}">Ch.${ch.number}</button>`
      ),
  ].join('');

  return `
  <div class="stack formulas-page">
    <div class="row" style="justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
      <div>
        <p class="kicker">Rapid revision</p>
        <h1 class="h1">Formula sheet</h1>
        <p class="muted" style="margin:0">Chapter-wise · formulas + reference tables · ${totalFormulas} items · ${allBlocks.length} chapters</p>
      </div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <a class="btn btn-primary" href="./exports/ENEX254-EM-Formula-Sheet.pdf" download="ENEX254-EM-Formula-Sheet.pdf">Download PDF</a>
      </div>
    </div>

    <div class="row" style="flex-wrap:wrap;gap:8px">${chips}</div>

    ${
      filteredOnly
        ? `<div class="panel panel-warn"><p class="muted" style="margin:0">Screen filter shows <strong>Chapter ${escapeHtml(
            String(blocks[0]?.chapter?.number || '')
          )} only</strong>. The PDF always includes all chapters. Switch to <button class="btn btn-sm btn-secondary" data-nav="#/formulas">All</button> to browse everything on screen.</p></div>`
        : ''
    }

    <div class="panel">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <p class="kicker">Showing</p>
          <strong>${chFilter === 'all' ? 'All chapters (1–6)' : escapeHtml(blocks[0]?.chapter?.title || 'Chapter')}</strong>
        </div>
        <div class="meta">${blocks.reduce((s, b) => s + b.topics.length, 0)} topics · ${blocks.reduce(
          (s, b) => s + b.formulaCount,
          0
        )} items</div>
      </div>
    </div>

    ${
      blocks.length
        ? `<div class="formula-sheet-screen">${renderFormulaSheetHtml(blocks, { forPrint: false })}</div>`
        : emptyState('No formulas', 'This chapter has no formula entries in the content bank.', 'All chapters', '#/formulas')
    }
  </div>`;
}

async function downloadFormulasPdf(_chapterId = 'all') {
  const url = './exports/ENEX254-EM-Formula-Sheet.pdf';
  try {
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    const obj = URL.createObjectURL(blob);
    a.href = obj;
    a.download = 'ENEX254-EM-Formula-Sheet.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(obj);
    toast('PDF downloaded');
  } catch (err) {
    console.error(err);
    toast('PDF missing — rebuild with build_formula_pdf.py');
    // Fallback: open the static path (works if file exists)
    window.open(url, '_blank');
  }
}

function viewProgress() {
  const ready = computeReadiness(app.content, app.state);
  return `
  <div class="stack">
    <div><h1 class="h1">Progress</h1><p class="muted">Marks-focused metrics — not XP theater</p></div>
    <div class="grid grid-4">
      ${metricCard('Readiness', ready.readiness + '%')}
      ${metricCard('Q attempted', String(ready.questionsAttempted))}
      ${metricCard('Q accuracy', ready.questionAccuracy + '%')}
      ${metricCard('MCQ accuracy', ready.mcqAccuracy + '%')}
    </div>
    <div class="card">
      <h3 class="h3">Chapter mastery</h3>
      ${app.content.chapters
        .map((c) => {
          const ts = app.content.topics.filter((t) => t.chapterId === c.id);
          const avg = ts.reduce((s, t) => s + (app.state.topics[t.id]?.mastery || 0), 0) / (ts.length || 1);
          return `<div style="margin:.5rem 0"><div class="row" style="justify-content:space-between"><span>Ch.${c.number} ${escapeHtml(
            c.title
          )}</span><strong>${Math.round(avg)}%</strong></div><div class="progress"><span style="width:${avg}%"></span></div></div>`;
        })
        .join('')}
    </div>
  </div>`;
}

function viewSettings() {
  const p = app.state.prefs;
  const user = app.user || getCurrentUser();
  const examLocal = p.examDate ? new Date(p.examDate) : new Date();
  const localVal = new Date(examLocal.getTime() - examLocal.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  let covPct = 0;
  let topicsDone = 0;
  let topicsTotal = app.content.syllabus?.topics?.length || 0;
  try {
    const cov = computeSyllabusCoverage(app.content, app.state);
    covPct = cov.coveragePct;
    topicsDone = cov.coveredTopics;
  } catch (_) {
    /* ignore */
  }
  const qAttempted = Object.values(app.state.questions || {}).filter((q) => q.attempted).length;
  return `
  <div class="stack">
    <div><h1 class="h1">Settings</h1><p class="muted">Study preferences and your local progress data</p></div>

    <div class="card stack">
      <h3 class="h3" style="margin:0">Local user</h3>
      <p class="meta">${escapeHtml(user?.name || 'Local Student')} · <code style="font-size:11px">${escapeHtml(
        user?.id || ''
      )}</code></p>
      <p class="muted" style="font-size:13px;margin:0">Progress is stored in IndexedDB for this user only. Syllabus and questions stay in the app files.</p>
    </div>

    <div class="card stack">
      <h3 class="h3" style="margin:0">Study preferences</h3>
      <div><label class="label">Exam date & time</label><input class="input" id="set-exam" type="datetime-local" value="${localVal}"/></div>
      <div class="grid grid-3">
        <div><label class="label">Study hours / day</label><input class="input" id="set-hours" type="number" min="1" max="16" value="${p.studyHoursPerDay}"/></div>
        <div><label class="label">Sleep hours</label><input class="input" id="set-sleep" type="number" min="4" max="12" value="${p.sleepHours}"/></div>
        <div><label class="label">Break minutes</label><input class="input" id="set-break" type="number" min="0" max="30" value="${p.breakMinutes}"/></div>
      </div>
      <button class="btn btn-primary" data-action="save-settings">Save</button>
    </div>

    <div class="card stack">
      <h3 class="h3" style="margin:0">Data</h3>
      <p class="meta">Coverage ${covPct}% · Topics ${topicsDone}/${topicsTotal} · Questions attempted ${qAttempted}</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="btn btn-secondary" data-action="export">Export Progress</button>
        <button class="btn btn-secondary" data-action="import">Import Progress</button>
        <input id="import-file" type="file" accept="application/json" class="hidden"/>
      </div>
      <div class="danger-zone">
        <p class="danger-zone-title">Danger zone</p>
        <p class="muted" style="font-size:13px;margin:0 0 10px">Clears this user's learning progress only. Syllabus and question content are never deleted.</p>
        <button class="btn btn-danger" data-action="reset-progress">Reset Progress…</button>
      </div>
      <p class="muted" style="margin-top:.5rem;font-size:.85rem">Content source: ${app.content.meta.sourceFiles.join(
        ', '
      )}. Rebuild with <code>python em-prep/tools/build_content.py</code>.</p>
    </div>
  </div>`;
}

function progressSnapshotStats() {
  let covPct = 0;
  let topicsDone = 0;
  let topicsTotal = app.content.syllabus?.topics?.length || 0;
  let masteryPct = 0;
  try {
    const cov = computeSyllabusCoverage(app.content, app.state);
    covPct = cov.coveragePct;
    topicsDone = cov.coveredTopics;
    masteryPct = cov.masteryPct;
  } catch (_) {
    /* ignore */
  }
  const qAttempted = Object.values(app.state.questions || {}).filter((q) => q.attempted).length;
  const mcqTouched = Object.values(app.state.mcqs || {}).filter((m) => (m.attempts || 0) > 0).length;
  const mcqCorrect = Object.values(app.state.mcqs || {}).reduce((s, m) => s + (m.correct || 0), 0);
  const mcqAttempts = Object.values(app.state.mcqs || {}).reduce((s, m) => s + (m.attempts || 0), 0);
  const mcqAcc = mcqAttempts ? Math.round((100 * mcqCorrect) / mcqAttempts) : 0;
  const mistakes = (app.state.mistakes || []).filter((m) => !m.resolved).length;
  return { covPct, topicsDone, topicsTotal, masteryPct, qAttempted, mcqTouched, mcqAcc, mistakes };
}

function openResetProgressDialog() {
  const user = app.user || getCurrentUser();
  const s = progressSnapshotStats();
  requestTypedConfirm({
    phrase: 'RESET',
    title: 'Reset your progress?',
    itemName: user?.name || 'Current Local User',
    confirmLabel: 'Reset Progress',
    successMessage: 'Progress reset successfully',
    bodyHtml: `This will permanently clear study progress for <strong>${escapeHtml(
      user?.name || 'this local user'
    )}</strong>. Your syllabus, study material, and questions will <strong>not</strong> be deleted. You stay the same local user with a fresh empty progress state.`,
    effects: [
      'Syllabus coverage & topic completion',
      'Day-plan task completions',
      'Mastery, checklist, question & MCQ attempts',
      'Mistake book, revision progress, daily history',
      'Mock history and study sessions',
    ],
    statsHtml: `
      <div class="pc-stat-grid">
        <div><span class="meta">Syllabus coverage</span><strong>${s.covPct}%</strong></div>
        <div><span class="meta">Topics completed</span><strong>${s.topicsDone} / ${s.topicsTotal}</strong></div>
        <div><span class="meta">Questions attempted</span><strong>${s.qAttempted}</strong></div>
        <div><span class="meta">MCQ accuracy</span><strong>${s.mcqAcc}%</strong></div>
        <div><span class="meta">Mastery</span><strong>${s.masteryPct}%</strong></div>
        <div><span class="meta">Open mistakes</span><strong>${s.mistakes}</strong></div>
      </div>`,
    apply: async () => {
      // Keep exam prefs from current state before atomic reset
      const prefs = { ...app.state.prefs };
      const fresh = await resetCurrentUserProgress();
      fresh.prefs = { ...fresh.prefs, ...prefs };
      app.state = fresh;
      app.state.userId = app.user.id;
      await saveState(app.state);
      app.mock = null;
      app.mcqSession = null;
      app.revision = null;
      app.chapterSession = null;
    },
    onSuccess: (msg) => {
      toast(msg);
      toast("You're starting fresh.");
    },
    onDone: () => {
      updateChrome();
      navigate('#/dashboard');
    },
    onError: (err) => {
      toast('Reset failed — progress unchanged');
      console.error(err);
    },
  });
}

function requestImportConfirm(parsedProgress) {
  confirmProgressChange({
    action: 'import-progress',
    title: 'Replace current progress?',
    itemName: app.user?.name || 'Local Student',
    confirmLabel: 'Import Progress',
    successMessage: 'Progress imported',
    bodyHtml:
      'Importing this file will <strong>replace</strong> your current study progress for this local user. Syllabus and question content are unchanged.',
    effects: ['Current attempts, mistakes, and coverage will be overwritten', `Import bound to user ${app.user?.id || ''}`],
    apply: () => {
      app.state = parsedProgress;
      app.state.userId = app.user.id;
      app.mock = null;
      app.mcqSession = null;
      app.revision = null;
      app.chapterSession = null;
    },
  });
}

async function saveSettings() {
  const exam = $('#set-exam')?.value;
  if (exam) app.state.prefs.examDate = new Date(exam).toISOString();
  app.state.prefs.studyHoursPerDay = Number($('#set-hours')?.value || 6);
  app.state.prefs.sleepHours = Number($('#set-sleep')?.value || 7);
  app.state.prefs.breakMinutes = Number($('#set-break')?.value || 10);
  await persist();
  toast('Settings saved');
  navigate('#/dashboard');
}

function downloadExport() {
  const blob = new Blob([exportState(app.state, app.user)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `em-exam-progress-${app.user?.id || 'user'}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('Progress exported');
}

function viewFocus() {
  const t = topicById(app.route.params.id);
  if (!t) return `<div class="card">Missing topic</div>`;
  const live = livePriority(t, app.state);
  app.state.prefs.focusMode = true;
  return `
  <div class="stack">
    <div class="row" style="justify-content:space-between">
      <div class="muted">Focus Mode</div>
      <button class="btn btn-ghost btn-sm" data-nav="#/topic/${t.id}" onclick="window.__emExitFocus()">Exit</button>
    </div>
    <div class="card">
      <div class="row">${badge(live.level)} <span class="muted">${t.estimatedMinutes} min objective</span></div>
      <h1 class="h1">${escapeHtml(t.title)}</h1>
      <p>Objective: understand concept → memorize formulas → attempt 2–3 exam questions.</p>
      <div class="md-body">${renderMarkdown((t.formulas || []).slice(0, 5).map((f) => `$$${f}$$`).join('\n\n'))}</div>
      <div class="row" style="margin-top:1rem">
        <button class="btn btn-primary" data-nav="#/questions?topic=${encodeURIComponent(t.id)}">Practice Questions</button>
        <button class="btn btn-accent" data-nav="#/mcq?topic=${encodeURIComponent(t.id)}">MCQs</button>
      </div>
    </div>
  </div>`;
}

window.__emExitFocus = () => {
  app.state.prefs.focusMode = false;
  persist();
};

/* ---------------- Search ---------------- */
function openSearch() {
  $('#search-modal')?.classList.add('open');
  const input = $('#search-input');
  if (input) {
    input.value = '';
    input.focus();
  }
  $('#search-results').innerHTML = '';
}

function closeSearch() {
  $('#search-modal')?.classList.remove('open');
}

function onSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  if (q.length < 2) {
    $('#search-results').innerHTML = '';
    return;
  }
  const hits = [];
  for (const t of app.content.topics) {
    if (t.title.toLowerCase().includes(q) || (t.preamble || '').toLowerCase().includes(q)) {
      hits.push({ type: 'Topic', title: t.title, route: `#/topic/${t.id}` });
    }
    if ((t.formulas || []).some((f) => String(f).toLowerCase().includes(q))) {
      hits.push({ type: 'Formula', title: t.title, route: `#/formulas?ch=${encodeURIComponent(t.chapterId)}` });
    }
  }
  for (const t of app.content.syllabus?.topics || []) {
    if (t.title.toLowerCase().includes(q) || t.code.includes(q)) {
      hits.push({ type: 'Syllabus', title: `${t.code} ${t.title}`, route: `#/coverage/topic/${t.id}` });
    }
  }
  for (const qq of app.content.questions) {
    if ((qq.text || '').toLowerCase().includes(q) || (qq.answer || '').toLowerCase().includes(q)) {
      hits.push({
        type: 'Question',
        title: `Q${qq.number}: ${(qq.text || '').slice(0, 80)}…`,
        route: `#/questions?topic=${encodeURIComponent(qq.topicId)}`,
      });
    }
    if (hits.length > 40) break;
  }
  for (const m of app.content.mcqs) {
    if ((m.question || '').toLowerCase().includes(q)) {
      hits.push({ type: 'MCQ', title: m.question.slice(0, 80), route: '#/mcq' });
    }
    if (hits.length > 50) break;
  }
  app.searchHits = hits.slice(0, 30);
  app.searchIndex = 0;
  $('#search-results').innerHTML = app.searchHits
    .map(
      (h, i) =>
        `<button class="search-hit ${i === 0 ? 'active' : ''}" data-i="${i}"><span class="badge badge-muted">${
          h.type
        }</span> ${escapeHtml(h.title)}</button>`
    )
    .join('');
  $all('.search-hit').forEach((btn) =>
    btn.addEventListener('click', () => {
      closeSearch();
      navigate(app.searchHits[Number(btn.dataset.i)].route);
    })
  );
}

function onSearchKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    app.searchIndex = Math.min(app.searchHits.length - 1, app.searchIndex + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    app.searchIndex = Math.max(0, app.searchIndex - 1);
  } else if (e.key === 'Enter' && app.searchHits[app.searchIndex]) {
    e.preventDefault();
    closeSearch();
    navigate(app.searchHits[app.searchIndex].route);
    return;
  } else return;
  $all('.search-hit').forEach((el, i) => el.classList.toggle('active', i === app.searchIndex));
}

boot();
