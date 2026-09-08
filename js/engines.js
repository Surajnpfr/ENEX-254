/** Priority, plan, next-action, readiness engines */

export function livePriority(topic, state) {
  const st = state.topics[topic.id] || { mastery: 0 };
  const weakness = 1 - Math.min(1, Math.max(0, (st.mastery || 0) / 100));
  const score =
    (topic.examImportance || 0.5) * 0.3 +
    (topic.frequencyScore || 0.5) * 0.25 +
    weakness * 0.2 +
    (topic.foundationScore || 0.5) * 0.15 +
    (topic.markEfficiency || 0.5) * 0.1;
  let pct = score * 100;
  // Prefer unfinished high-base topics
  if ((st.mastery || 0) < 40) pct = Math.max(pct, topic.priorityBase || pct);
  if ((st.mastery || 0) >= 85) pct = Math.min(pct, 70);
  pct = Math.round(Math.min(100, Math.max(0, pct)));
  return { score: pct, level: levelFrom(pct) };
}

function levelFrom(score) {
  if (score >= 90) return 'P1';
  if (score >= 75) return 'P2';
  if (score >= 50) return 'P3';
  return 'P4';
}

export function getExamTiming(prefs) {
  const now = new Date();
  let exam = prefs.examDate ? new Date(prefs.examDate) : null;
  if (!exam || Number.isNaN(exam.getTime())) {
    exam = new Date(now.getTime() + 4 * 24 * 3600 * 1000);
  }
  const ms = exam - now;
  const daysLeft = Math.max(0, Math.ceil(ms / (24 * 3600 * 1000)));
  const hoursLeft = Math.max(0, ms / 3600000);
  const dayIndex = Math.min(4, Math.max(1, 5 - Math.min(4, daysLeft || 1)));
  // If more than 4 days, still show day 1 plan; if 0 days, day 4
  let prepDay = 1;
  if (daysLeft >= 4) prepDay = 1;
  else if (daysLeft === 3) prepDay = 2;
  else if (daysLeft === 2) prepDay = 3;
  else prepDay = 4;
  return { now, exam, daysLeft, hoursLeft, prepDay };
}

export function computeReadiness(content, state) {
  const topics = content.topics;
  let topicCov = 0;
  let p1Master = 0;
  let p1Count = 0;
  let qAttempt = 0;
  let qCorrect = 0;
  let mcqAttempt = 0;
  let mcqCorrect = 0;
  let mistakesOpen = 0;
  let revisionDone = 0;
  let revisionTotal = 0;

  for (const t of topics) {
    const st = state.topics[t.id] || { mastery: 0 };
    topicCov += Math.min(100, st.mastery || 0);
    const live = livePriority(t, state);
    if (live.level === 'P1') {
      p1Count++;
      p1Master += Math.min(100, st.mastery || 0);
    }
  }
  topicCov = topics.length ? topicCov / topics.length : 0;
  p1Master = p1Count ? p1Master / p1Count : topicCov;

  for (const q of content.questions) {
    const qs = state.questions[q.id];
    if (qs?.attempted) {
      qAttempt++;
      if (qs.correct) qCorrect++;
    }
  }
  for (const m of content.mcqs) {
    const ms = state.mcqs[m.id];
    if (ms?.attempts) {
      mcqAttempt += ms.attempts;
      mcqCorrect += ms.correct;
    }
  }
  mistakesOpen = (state.mistakes || []).filter((x) => !x.resolved).length;
  revisionTotal = content.revisionCards.length;
  for (const c of content.revisionCards) {
    const r = state.revisions[c.id];
    if (r?.streak >= 1) revisionDone++;
  }
  const qAcc = qAttempt ? (qCorrect / qAttempt) * 100 : 0;
  const mAcc = mcqAttempt ? (mcqCorrect / mcqAttempt) * 100 : 0;
  const mockAvg = state.mockHistory.length
    ? state.mockHistory.reduce((s, m) => s + m.percent, 0) / state.mockHistory.length
    : 0;
  const mistakePenalty = Math.min(25, mistakesOpen * 1.5);
  const revisionPct = revisionTotal ? (revisionDone / revisionTotal) * 100 : 0;

  const readiness = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        topicCov * 0.22 +
          p1Master * 0.22 +
          qAcc * 0.16 +
          mAcc * 0.12 +
          revisionPct * 0.1 +
          mockAvg * 0.1 +
          Math.min(100, qAttempt) * 0.03 -
          mistakePenalty * 0.05
      )
    )
  );

  return {
    readiness,
    topicCoverage: Math.round(topicCov),
    p1Mastery: Math.round(p1Master),
    questionAccuracy: Math.round(qAcc),
    mcqAccuracy: Math.round(mAcc),
    questionsAttempted: qAttempt,
    questionsCorrect: qCorrect,
    mcqAttempts: mcqAttempt,
    mistakesRemaining: mistakesOpen,
    revisionCompletion: Math.round(revisionPct),
    mockScore: Math.round(mockAvg),
    factors: [
      { name: 'Topic coverage', value: Math.round(topicCov), weight: '22%' },
      { name: 'P1 mastery', value: Math.round(p1Master), weight: '22%' },
      { name: 'Question accuracy', value: Math.round(qAcc), weight: '16%' },
      { name: 'MCQ accuracy', value: Math.round(mAcc), weight: '12%' },
      { name: 'Revision completion', value: Math.round(revisionPct), weight: '10%' },
      { name: 'Mock average', value: Math.round(mockAvg), weight: '10%' },
    ],
  };
}

export function buildFourDayPlan(content, state, prefs) {
  const hours = prefs.studyHoursPerDay || 6;
  const minutesPerDay = hours * 60;
  const ranked = [...content.topics]
    .map((t) => ({ t, live: livePriority(t, state) }))
    .sort((a, b) => b.live.score - a.live.score);

  const days = {
    1: { day: 1, title: 'Foundation', focus: 'P1 concepts, formulas, definitions, basic solved Qs', items: [] },
    2: { day: 2, title: 'Coverage', focus: 'Remaining P1 + P2, derivations, frequent numericals', items: [] },
    3: { day: 3, title: 'Practice', focus: 'Questions, MCQs, weak topics, mistake repair', items: [] },
    4: { day: 4, title: 'Final Revision', focus: 'Weak/P1 leftovers, formulas, mistake book, mock', items: [] },
  };

  // Day 1: P1 + reference formulas, unfinished
  for (const { t, live } of ranked) {
    const mastery = state.topics[t.id]?.mastery || 0;
    if (live.level === 'P1' || t.isReference) {
      if (mastery < 70 && dayMinutes(days[1]) < minutesPerDay * 0.95) {
        days[1].items.push(planItem(1, t, live, 'study', t.estimatedMinutes));
      }
    }
  }
  // Day 2: remaining P1/P2
  for (const { t, live } of ranked) {
    const mastery = state.topics[t.id]?.mastery || 0;
    if ((live.level === 'P1' || live.level === 'P2') && mastery < 75) {
      if (!days[1].items.some((i) => i.topicId === t.id) && dayMinutes(days[2]) < minutesPerDay) {
        days[2].items.push(planItem(2, t, live, 'study', t.estimatedMinutes));
      }
    }
  }
  // Day 3: practice-heavy
  for (const { t, live } of ranked) {
    if (dayMinutes(days[3]) >= minutesPerDay) break;
    if ((state.topics[t.id]?.mastery || 0) < 85 && t.questionIds.length) {
      days[3].items.push(planItem(3, t, live, 'practice', Math.min(40, 15 + t.questionIds.length * 2)));
    }
  }
  days[3].items.push(
    specialItem(3, 'mcq', 'MCQ drill (weak + mixed)', 'P1', 40, [
      'Build speed',
      'Expose gaps',
    ], 'Timed MCQ sets to find weak formulas fast.')
  );
  days[3].items.push(
    specialItem(3, 'mistakes', 'Mistake book repair', 'P1', 30, [
      'Convert wrong answers into marks',
    ], 'Revisit unresolved mistakes until you can solve them cold.')
  );

  // Day 4: revision + mock only
  for (const { t, live } of ranked) {
    const mastery = state.topics[t.id]?.mastery || 0;
    if (live.level === 'P1' && mastery < 80 && dayMinutes(days[4]) < minutesPerDay * 0.45) {
      days[4].items.push(planItem(4, t, live, 'revise', 20));
    }
  }
  days[4].items.push(
    specialItem(4, 'revision', 'Rapid revision cards', 'P1', 45, ['Formulas + traps only'], 'Flash through high-yield formulas and traps.')
  );
  days[4].items.push(
    specialItem(4, 'mock', 'Final mock exam', 'P1', 60, ['Simulate exam pressure', 'Find last weak spots'], 'Full mock under time pressure.')
  );
  days[4].items.push(
    specialItem(4, 'mistakes', 'Mistake book final pass', 'P1', 25, ['Do not repeat known errors'], 'Last pass on anything still wrong.')
  );

  // Assign schedule times from 09:00 and merge completion state
  const prepDay = getExamTiming(prefs).prepDay;
  for (const d of [1, 2, 3, 4]) {
    let cursor = 9 * 60;
    for (const it of days[d].items) {
      it.scheduledMinutes = cursor;
      it.scheduledTime = formatPlanTime(cursor);
      cursor += it.durationMinutes || it.estimatedMinutes || 30;
    }
    // Keep completed tasks that dropped out of regenerated plan
    const seen = new Set(days[d].items.map((i) => i.id));
    const orphaned = Object.values(state.planTasks || {}).filter(
      (pt) => pt.day === d && pt.status === 'completed' && !seen.has(pt.id)
    );
    for (const pt of orphaned) {
      days[d].items.push({
        ...pt,
        orphaned: true,
        estimatedMinutes: pt.durationMinutes || 30,
      });
    }
    days[d].items = enrichPlanItems(days[d].items, state, { isToday: d === prepDay });
  }

  return days;
}

function dayMinutes(day) {
  return day.items.reduce((s, i) => s + (i.estimatedMinutes || i.durationMinutes || 0), 0);
}

function formatPlanTime(totalMin) {
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const mm = String(totalMin % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function planTaskId(day, action, topicId) {
  return `d${day}-${action}-${topicId || 'general'}`;
}

function planItem(day, t, live, action, minutes) {
  const typeMap = { study: 'study', practice: 'practice', revise: 'revision' };
  const desc =
    action === 'study'
      ? 'Learn the core ideas, key formulas, and exam-level applications.'
      : action === 'practice'
        ? 'Attempt related questions; check solutions only after honest effort.'
        : 'Rapid recall of formulas and traps — no deep rabbit holes.';
  return {
    id: planTaskId(day, action, t.id),
    day,
    topicId: t.id,
    chapterId: t.chapterId || null,
    title: t.title,
    description: desc,
    action,
    type: typeMap[action] || 'study',
    priority: live.level,
    durationMinutes: minutes,
    estimatedMinutes: minutes,
    reasons: reasonsFor(t, live, action),
  };
}

function specialItem(day, action, title, priority, minutes, reasons, description) {
  return {
    id: planTaskId(day, action, `special-${action}`),
    day,
    topicId: null,
    chapterId: null,
    title,
    description: description || '',
    action,
    type: action === 'mock' ? 'mock' : action === 'mistakes' ? 'practice' : action === 'mcq' ? 'practice' : 'revision',
    priority,
    durationMinutes: minutes,
    estimatedMinutes: minutes,
    reasons,
  };
}

function enrichPlanItems(items, state, { isToday = false } = {}) {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return items.map((it) => {
    const saved = state.planTasks?.[it.id] || {};
    let status = saved.status || 'upcoming';
    if (status !== 'completed' && status !== 'skipped' && status !== 'in_progress') {
      if (
        isToday &&
        typeof it.scheduledMinutes === 'number' &&
        nowMin > it.scheduledMinutes + (it.durationMinutes || 30)
      ) {
        status = 'overdue';
      } else {
        status = 'upcoming';
      }
    }
    return {
      ...it,
      status,
      startedAt: saved.startedAt || null,
      completedAt: saved.completedAt || null,
      elapsedSeconds: saved.elapsedSeconds || 0,
    };
  });
}

/** Day-level aggregates for UI */
export function summarizePlanDay(dayObj) {
  const items = dayObj.items || [];
  const completed = items.filter((i) => i.status === 'completed');
  const remaining = items.filter((i) => i.status !== 'completed' && i.status !== 'skipped');
  const skipped = items.filter((i) => i.status === 'skipped');
  const total = items.filter((i) => i.status !== 'skipped').length || items.length;
  const doneCount = completed.length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const minsDone = completed.reduce((s, i) => s + (i.durationMinutes || i.estimatedMinutes || 0), 0);
  const minsLeft = remaining.reduce((s, i) => s + (i.durationMinutes || i.estimatedMinutes || 0), 0);
  const current =
    remaining.find((i) => i.status === 'in_progress') ||
    remaining.find((i) => i.status === 'overdue') ||
    remaining[0] ||
    null;
  return {
    total,
    doneCount,
    pct,
    minsDone,
    minsLeft,
    completed,
    remaining,
    skipped,
    current,
    allDone: remaining.length === 0 && items.length > 0,
  };
}

export function planTaskRoute(it) {
  if (!it) return '#/plan';
  if (it.action === 'mcq') return '#/mcq';
  if (it.action === 'mistakes') return '#/mistakes';
  if (it.action === 'revision') return '#/revision';
  if (it.action === 'mock') return '#/mock';
  if (it.action === 'practice' && it.topicId) return `#/questions?topic=${encodeURIComponent(it.topicId)}`;
  if (it.topicId) return `#/topic/${it.topicId}`;
  return '#/plan';
}

function reasonsFor(t, live, action) {
  const r = [];
  r.push(`${live.level} · score ${live.score}`);
  if (t.chapterNumber === 2) r.push('Highest exam weight (~20 marks)');
  if (t.chapterNumber === 3 || t.chapterNumber === 5) r.push('High exam weight (~12 marks)');
  if ((t.frequencyScore || 0) > 0.5) r.push('Frequently tested pattern');
  if (action === 'practice') r.push('Practice > passive reading today');
  if (action === 'revise') r.push('High value · skim for recall only');
  return r;
}

export function getNextBestStudyAction(content, state, prefs) {
  const timing = getExamTiming(prefs);
  const readiness = computeReadiness(content, state);
  const ranked = [...content.topics]
    .map((t) => {
      const live = livePriority(t, state);
      const st = state.topics[t.id] || { mastery: 0, lastStudied: null };
      let urgency = live.score;
      if (st.mastery < 30) urgency += 12;
      if (st.mastery >= 85) urgency -= 25;
      if (timing.prepDay >= 3 && t.questionIds.length) urgency += 8;
      if (timing.prepDay === 4 && live.level !== 'P1' && st.mastery < 50) urgency -= 40; // don't start new low-priority
      // recent mistakes on topic
      const mist = (state.mistakes || []).filter((m) => m.topicId === t.id && !m.resolved).length;
      urgency += Math.min(15, mist * 4);
      return { t, live, urgency, st };
    })
    .sort((a, b) => b.urgency - a.urgency);

  const openMistakes = (state.mistakes || []).filter((m) => !m.resolved);
  if (timing.prepDay >= 3 && openMistakes.length >= 5) {
    return {
      action: 'mistakes',
      topic: null,
      priority: 'P1',
      estimatedMinutes: 25,
      reasons: [
        `${openMistakes.length} unresolved mistakes`,
        'Mistake repair raises expected marks fast',
        `Prep day ${timing.prepDay}`,
      ],
      route: '#/mistakes',
      label: 'Review Mistake Book',
    };
  }

  if (timing.prepDay === 4 && readiness.mockScore < 50 && state.mockHistory.length === 0) {
    return {
      action: 'mock',
      topic: null,
      priority: 'P1',
      estimatedMinutes: 60,
      reasons: ['Day 4 · take a mock before final skim', 'Identifies last weak topics'],
      route: '#/mock',
      label: 'Start Final Mock',
    };
  }

  const top = ranked[0];
  if (!top) {
    return {
      action: 'revision',
      topic: null,
      priority: 'P2',
      estimatedMinutes: 30,
      reasons: ['All topics scored — revise formulas'],
      route: '#/revision',
      label: 'Rapid Revision',
    };
  }

  const { t, live, st } = top;
  let action = 'study';
  let label = `Study: ${t.title}`;
  let route = `#/topic/${t.id}`;
  let minutes = t.estimatedMinutes;
  const reasons = [
    `${live.level} Critical/High`.replace('Critical/High', live.level === 'P1' ? 'Critical' : live.level === 'P2' ? 'High' : 'Priority'),
    `Mastery ${st.mastery || 0}%`,
  ];
  if (t.chapterNumber === 2) reasons.push('High exam value (~20 marks chapter)');
  if ((t.frequencyScore || 0) > 0.45) reasons.push('Frequently asked patterns');
  if (timing.prepDay >= 3 && t.questionIds.length) {
    action = 'practice';
    label = `Practice: ${t.title}`;
    route = `#/questions?topic=${encodeURIComponent(t.id)}`;
    minutes = Math.min(40, 20 + t.questionIds.length);
    reasons.push('Practice-heavy day — questions over reading');
  }
  if (timing.prepDay === 4) {
    action = 'revise';
    label = `Revise: ${t.title}`;
    route = `#/topic/${t.id}?mode=revise`;
    minutes = 20;
    reasons.push('Day 4 — no new low-value rabbit holes');
  }

  return {
    action,
    topic: t,
    priority: live.level,
    estimatedMinutes: minutes,
    reasons,
    route,
    label,
  };
}

export function scheduleRevision(state, key, correct) {
  const now = Date.now();
  const cur = state.revisions[key] || { streak: 0, intervalMin: 45 };
  if (!correct) {
    state.revisions[key] = { due: now + 45 * 60000, intervalMin: 45, streak: 0 };
  } else if (cur.streak <= 0) {
    state.revisions[key] = { due: now + 4 * 3600000, intervalMin: 240, streak: 1 };
  } else {
    state.revisions[key] = { due: now + 24 * 3600000, intervalMin: 1440, streak: cur.streak + 1 };
  }
}

/** Chapter-wise question helpers (from Markdown chapterId mapping) */
export function questionsForChapter(content, chapterId) {
  return content.questions.filter((q) => q.chapterId === chapterId);
}

export function getChapterStats(content, state, chapterId) {
  const chapter = content.chapters.find((c) => c.id === chapterId);
  const qs = questionsForChapter(content, chapterId);
  let attempted = 0;
  let correct = 0;
  let incorrect = 0;
  let revision = 0;
  const topicMastery = [];
  for (const q of qs) {
    const st = state.questions[q.id];
    if (st?.attempted) {
      attempted++;
      if (st.correct) correct++;
      else incorrect++;
    }
    if (st?.markedForRevision) revision++;
  }
  for (const tid of chapter?.topicIds || []) {
    topicMastery.push(state.topics[tid]?.mastery || 0);
  }
  const mastery = topicMastery.length
    ? Math.round(topicMastery.reduce((a, b) => a + b, 0) / topicMastery.length)
    : attempted
      ? Math.round((correct / qs.length) * 100)
      : 0;
  const accuracy = attempted ? Math.round((correct / attempted) * 100) : 0;
  const remaining = qs.length - attempted;
  // chapter priority from average topic live score approximation using base
  const topics = (chapter?.topicIds || []).map((id) => content.topics.find((t) => t.id === id)).filter(Boolean);
  const avgBase = topics.length
    ? topics.reduce((s, t) => s + (t.priorityBase || 50), 0) / topics.length
    : 50;
  const weaknessBoost = remaining / Math.max(1, qs.length);
  const priorityScore = Math.round(Math.min(100, avgBase * 0.7 + weaknessBoost * 30 + (100 - mastery) * 0.15));
  return {
    chapter,
    total: qs.length,
    attempted,
    correct,
    incorrect,
    revision,
    remaining,
    accuracy,
    mastery,
    priorityScore,
    priorityLevel: levelFrom(priorityScore),
    questionIds: qs.map((q) => q.id),
  };
}

export function getAllChapterStats(content, state) {
  return content.chapters.map((c) => getChapterStats(content, state, c.id));
}

export function filterChapterQuestions(content, state, chapterId, filters = {}) {
  let list = questionsForChapter(content, chapterId);
  const { status = 'all', difficulty = 'all', type = 'all', topicId = '' } = filters;
  if (topicId) list = list.filter((q) => q.topicId === topicId);
  if (difficulty !== 'all') list = list.filter((q) => (q.difficulty || 'medium') === difficulty);
  if (type !== 'all') list = list.filter((q) => (q.type || '') === type);
  if (status === 'unattempted') list = list.filter((q) => !state.questions[q.id]?.attempted);
  if (status === 'attempted') list = list.filter((q) => state.questions[q.id]?.attempted);
  if (status === 'correct') list = list.filter((q) => state.questions[q.id]?.correct);
  if (status === 'incorrect') list = list.filter((q) => state.questions[q.id]?.attempted && !state.questions[q.id]?.correct);
  if (status === 'revision') list = list.filter((q) => state.questions[q.id]?.markedForRevision);
  return list;
}

export function getRecommendedChapter(content, state) {
  const stats = getAllChapterStats(content, state);
  return [...stats].sort((a, b) => {
    // prefer incomplete + high priority + low mastery
    const sa = a.priorityScore + (a.remaining > 0 ? 15 : 0) + (100 - a.mastery) * 0.2 + a.incorrect * 2;
    const sb = b.priorityScore + (b.remaining > 0 ? 15 : 0) + (100 - b.mastery) * 0.2 + b.incorrect * 2;
    return sb - sa;
  })[0];
}
