/**
 * ProgressConfirmationDialog — official progress only mutates after explicit confirm.
 * Activity (opens, scrolls, starts) must never call this.
 */

let host = null;
let active = null; // { opts, snapshot, submitting }
let lastFocused = null;

const COPY = {
  'mark-studied': {
    title: 'Mark concept as studied?',
    confirmLabel: 'Yes, mark studied',
    body: (name) =>
      `You're marking <strong>${esc(name)}</strong> as studied. Make sure you can explain the concept and recall the key formulas.`,
  },
  'mark-complete': {
    title: 'Mark topic as complete?',
    confirmLabel: 'Yes, mark complete',
    body: (name) =>
      `You're about to mark <strong>${esc(name)}</strong> as completed. This updates study and syllabus progress.`,
  },
  'mark-mastered': {
    title: 'Mark as mastered?',
    confirmLabel: 'Yes, mark mastered',
    body: (name) =>
      `Mastery means you can recall <strong>${esc(name)}</strong> and solve related exam questions independently.`,
  },
  'complete-chapter': {
    title: 'Complete chapter?',
    confirmLabel: 'Yes, complete chapter',
    body: (name) =>
      `You're marking <strong>${esc(name)}</strong> as complete. This will mark the chapter as covered in syllabus progress.`,
  },
  'complete-revision': {
    title: 'Mark revision complete?',
    confirmLabel: 'Yes, mark revised',
    body: (name) =>
      `Have you finished revising <strong>${esc(name)}</strong> and reviewed important formulas and mistakes?`,
  },
  'toggle-checklist': {
    title: 'Update checklist?',
    confirmLabel: 'Yes, update',
    body: (name) =>
      `This will change checklist progress for <strong>${esc(name)}</strong> and may update mastery.`,
  },
  'resolve-mistake': {
    title: 'Mark mistake resolved?',
    confirmLabel: 'Yes, resolve',
    body: (name) =>
      `Confirm you've fixed this mistake${name ? ` on <strong>${esc(name)}</strong>` : ''} and won't repeat it.`,
  },
  'import-progress': {
    title: 'Replace current progress?',
    confirmLabel: 'Import Progress',
    body: () =>
      'Importing this file will <strong>replace</strong> your current study progress for this local user.',
  },
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.id = 'progress-confirm-host';
  host.className = 'progress-confirm-host';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  host.addEventListener('click', (e) => {
    if (e.target === host && active && !active.submitting) {
      // Backdrop closes without confirming
      cancelProgressConfirm();
    }
  });
  return host;
}

function barHtml(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return `<div class="pc-bar" role="img" aria-label="${p}%"><span style="width:${p}%"></span></div><span class="pc-bar-pct">${p}%</span>`;
}

function renderDialog(opts) {
  const copy = COPY[opts.action] || COPY['mark-complete'];
  const title = opts.title || copy.title;
  const confirmLabel = opts.confirmLabel || copy.confirmLabel;
  const body =
    opts.bodyHtml ||
    copy.body(opts.itemName || 'this item');
  const effects = opts.effects || [];
  const bars = opts.progressBars || [];

  return `
  <div class="progress-confirm-card" role="dialog" aria-modal="true" aria-labelledby="pc-title" tabindex="-1">
    <p class="pc-kicker">Confirm progress</p>
    <h2 id="pc-title" class="pc-title">${esc(title)}</h2>
    ${opts.itemName ? `<p class="pc-item">${esc(opts.itemName)}</p>` : ''}
    <div class="pc-body">${body}</div>
    ${
      bars.length
        ? `<div class="pc-preview">
      ${bars
        .map(
          (b) => `<div class="pc-preview-row">
          <div class="pc-preview-label">${esc(b.label)}</div>
          <div class="pc-preview-cols">
            <div><span class="meta">Now</span>${barHtml(b.before)}</div>
            <div class="pc-arrow" aria-hidden="true">→</div>
            <div><span class="meta">After</span>${barHtml(b.after)}</div>
          </div>
        </div>`
        )
        .join('')}
    </div>`
        : ''
    }
    ${
      effects.length
        ? `<ul class="pc-effects">
      ${effects.map((e) => `<li>${esc(e)}</li>`).join('')}
    </ul>`
        : ''
    }
    <p class="pc-ask">Are you sure? This updates official coverage — not just activity.</p>
    <div class="pc-actions">
      <button type="button" class="btn btn-secondary" data-pc="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-pc="confirm">${esc(confirmLabel)}</button>
    </div>
  </div>`;
}

/**
 * @param {object} opts
 * @param {string} opts.action
 * @param {string} [opts.itemName]
 * @param {string} [opts.title]
 * @param {string} [opts.bodyHtml]
 * @param {string} [opts.confirmLabel]
 * @param {string[]} [opts.effects]
 * @param {{label:string,before:number,after:number}[]} [opts.progressBars]
 * @param {() => void} opts.apply - mutate state (called only on confirm)
 * @param {() => any} [opts.snapshot] - returns undo snapshot (default: none)
 * @param {(msg:string, undo?:()=>void) => void} [opts.onSuccess]
 * @param {() => void} [opts.onCancel]
 * @param {() => void} [opts.onDone] - after confirm+apply (e.g. render)
 */
export function requestProgressConfirm(opts) {
  if (!opts || typeof opts.apply !== 'function') {
    throw new Error('requestProgressConfirm requires apply()');
  }
  // Replace any open dialog without applying
  if (active) cancelProgressConfirm({ silent: true });

  lastFocused = document.activeElement;
  const h = ensureHost();
  active = { opts, submitting: false, snapshot: null };
  h.innerHTML = renderDialog(opts);
  h.classList.add('open');
  h.setAttribute('aria-hidden', 'false');

  const card = h.querySelector('.progress-confirm-card');
  const cancelBtn = h.querySelector('[data-pc="cancel"]');
  const confirmBtn = h.querySelector('[data-pc="confirm"]');

  cancelBtn?.addEventListener('click', () => cancelProgressConfirm());
  confirmBtn?.addEventListener('click', () => confirmProgressConfirm());

  // Focus trap: focus confirm button (primary) but keep cancel first in DOM for Tab order
  requestAnimationFrame(() => {
    cancelBtn?.focus();
  });

  card?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelProgressConfirm();
    }
    if (e.key === 'Tab') {
      const focusables = [cancelBtn, confirmBtn].filter(Boolean);
      if (!focusables.length) return;
      const i = focusables.indexOf(document.activeElement);
      if (e.shiftKey) {
        if (i <= 0) {
          e.preventDefault();
          focusables[focusables.length - 1].focus();
        }
      } else if (i === focusables.length - 1) {
        e.preventDefault();
        focusables[0].focus();
      }
    }
  });

  return true;
}

export function isProgressConfirmOpen() {
  return !!active;
}

export function cancelProgressConfirm({ silent } = {}) {
  if (!active) return;
  const onCancel = active.opts.onCancel;
  teardown();
  if (!silent) onCancel?.();
}

async function confirmProgressConfirm() {
  if (!active || active.submitting) return;
  if (active.opts._typed) {
    const input = host?.querySelector('#pc-type-input');
    const phrase = active.opts.phrase || 'RESET';
    if ((input?.value || '').trim() !== phrase) return;
  }
  active.submitting = true;
  const h = ensureHost();
  const confirmBtn = h.querySelector('[data-pc="confirm"]');
  const cancelBtn = h.querySelector('[data-pc="cancel"]');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = active.opts._typed ? 'Resetting…' : '✓ Marking…';
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const { opts } = active;
  let snapshot = null;
  try {
    snapshot = typeof opts.snapshot === 'function' ? opts.snapshot() : null;
    await Promise.resolve(opts.apply?.());
    const successMsg = opts.successMessage || 'Progress updated';
    const undo =
      snapshot != null
        ? () => {
            opts.onUndo?.(snapshot);
          }
        : undefined;
    teardown();
    opts.onSuccess?.(successMsg, undo);
    await Promise.resolve(opts.onDone?.());
  } catch (err) {
    console.error(err);
    // Roll back in-memory mutation if DB write failed
    if (snapshot != null) {
      try {
        await Promise.resolve(opts.onUndo?.(snapshot));
      } catch (e2) {
        console.error('Rollback failed', e2);
      }
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = opts.confirmLabel || 'Confirm';
    }
    if (cancelBtn) cancelBtn.disabled = false;
    if (active) active.submitting = false;
    opts.onError?.(err);
  }
}

function teardown() {
  if (!host) {
    active = null;
    return;
  }
  host.classList.remove('open');
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = '';
  active = null;
  if (lastFocused && typeof lastFocused.focus === 'function') {
    try {
      lastFocused.focus();
    } catch (_) {
      /* ignore */
    }
  }
  lastFocused = null;
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Destructive confirm requiring exact typed phrase (e.g. RESET).
 */
export function requestTypedConfirm(opts) {
  const phrase = opts.phrase || 'RESET';
  if (active) cancelProgressConfirm({ silent: true });

  lastFocused = document.activeElement;
  const h = ensureHost();
  active = { opts: { ...opts, _typed: true }, submitting: false };

  h.innerHTML = `
  <div class="progress-confirm-card progress-confirm-danger" role="dialog" aria-modal="true" aria-labelledby="pc-title" tabindex="-1">
    <p class="pc-kicker">Destructive action</p>
    <h2 id="pc-title" class="pc-title">${esc(opts.title || 'Reset progress?')}</h2>
    ${opts.itemName ? `<p class="pc-item">${esc(opts.itemName)}</p>` : ''}
    <div class="pc-body">${opts.bodyHtml || ''}</div>
    ${
      opts.statsHtml
        ? `<div class="pc-preview pc-stats">${opts.statsHtml}</div>`
        : ''
    }
    ${
      opts.effects?.length
        ? `<ul class="pc-effects">${opts.effects.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
        : ''
    }
    <label class="pc-type-label" for="pc-type-input">Type <code>${esc(phrase)}</code> to confirm</label>
    <input id="pc-type-input" class="input pc-type-input" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(phrase)}" aria-required="true"/>
    <div class="pc-actions">
      <button type="button" class="btn btn-secondary" data-pc="cancel">Cancel</button>
      <button type="button" class="btn btn-danger" data-pc="confirm" disabled>${esc(opts.confirmLabel || 'Reset Progress')}</button>
    </div>
  </div>`;
  h.classList.add('open');
  h.setAttribute('aria-hidden', 'false');

  const input = h.querySelector('#pc-type-input');
  const cancelBtn = h.querySelector('[data-pc="cancel"]');
  const confirmBtn = h.querySelector('[data-pc="confirm"]');
  const card = h.querySelector('.progress-confirm-card');

  const syncEnabled = () => {
    confirmBtn.disabled = input.value.trim() !== phrase || active?.submitting;
  };
  input.addEventListener('input', syncEnabled);
  cancelBtn.addEventListener('click', () => cancelProgressConfirm());
  confirmBtn.addEventListener('click', () => confirmProgressConfirm());

  requestAnimationFrame(() => input.focus());

  card?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelProgressConfirm();
    }
  });

  return true;
}
