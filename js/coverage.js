/** Syllabus coverage calculations — Syllabus/EM.md is source of truth */

import { livePriority, getExamTiming } from './engines.js';

const W = { concept: 0.35, questions: 0.25, mcqs: 0.15, revision: 0.15, mastery: 0.1 };

export function ensureSyllabusTopic(state, id) {
  if (!state.syllabus) state.syllabus = {};
  if (!state.syllabus[id]) {
    state.syllabus[id] = {
      conceptStudied: false,
      conceptMarkedAt: null,
      revised: false,
      revisedAt: null,
      openedAt: null,
      meaningfulStudySeconds: 0,
    };
  }
  return state.syllabus[id];
}

export function evaluateSyllabusTopic(syl, content, state) {
  const st = state.syllabus?.[syl.id] || {};
  const studyIds = syl.studyTopicIds || [];
  const qids = syl.questionIds || [];
  const mids = syl.mcqIds || [];

  // Concept: explicit mark OR meaningful checklist progress on linked study topics
  let checklistDone = 0;
  let checklistTotal = 0;
  let studyMastery = 0;
  for (const sid of studyIds) {
    const ts = state.topics[sid];
    if (!ts) continue;
    studyMastery += ts.mastery || 0;
    const checks = Object.values(ts.checklist || {}).filter(Boolean).length;
    // first 5 checklist items are concept-ish
    checklistDone += Math.min(5, checks);
    checklistTotal += 5;
  }
  studyMastery = studyIds.length ? studyMastery / studyIds.length : 0;

  const conceptProgress = st.conceptStudied
    ? 100
    : checklistTotal
      ? Math.round((checklistDone / checklistTotal) * 100)
      : 0;

  let qAttempt = 0;
  let qCorrect = 0;
  for (const qid of qids) {
    const qs = state.questions[qid];
    if (qs?.attempted) {
      qAttempt++;
      if (qs.correct) qCorrect++;
    }
  }
  const questionProgress = qids.length ? Math.round((qAttempt / qids.length) * 100) : 0;

  let mcqAttempts = 0;
  let mcqCorrect = 0;
  let mcqTouched = 0;
  for (const mid of mids) {
    const ms = state.mcqs[mid];
    if (ms?.attempts) {
      mcqTouched++;
      mcqAttempts += ms.attempts;
      mcqCorrect += ms.correct;
    }
  }
  const mcqProgress = mids.length ? Math.round((mcqTouched / mids.length) * 100) : 0;

  // revision: explicit revise OR revision cards for linked study topics
  let revCards = 0;
  let revDone = 0;
  for (const sid of studyIds) {
    for (const c of content.revisionCards || []) {
      if (c.topicId !== sid) continue;
      revCards++;
      if ((state.revisions[c.id]?.streak || 0) >= 1) revDone++;
    }
  }
  const revisionProgress = st.revised
    ? 100
    : revCards
      ? Math.round((revDone / revCards) * 100)
      : 0;

  const masteryFromQ = qAttempt ? (qCorrect / qAttempt) * 100 : 0;
  const masteryFromM = mcqAttempts ? (mcqCorrect / mcqAttempts) * 100 : 0;
  const mastery = Math.round(
    studyMastery * 0.45 + masteryFromQ * 0.35 + masteryFromM * 0.2
  );

  const overall = Math.round(
    conceptProgress * W.concept +
      questionProgress * W.questions +
      mcqProgress * W.mcqs +
      revisionProgress * W.revision +
      mastery * W.mastery
  );

  // Status rules — no false progress from mere open
  let status = 'not_started';
  const meaningfulConcept = conceptProgress >= 40 || st.conceptStudied;
  const practiced = qAttempt >= Math.min(2, Math.max(1, qids.length)) || (qids.length === 0 && mcqTouched >= 2);
  if (overall >= 80 && mastery >= 70 && meaningfulConcept) status = 'mastered';
  else if (practiced && meaningfulConcept) status = 'practiced';
  else if (st.conceptStudied || conceptProgress >= 60) status = 'studied';
  else if (conceptProgress > 0 || qAttempt > 0 || mcqTouched > 0 || revisionProgress > 0) status = 'in_progress';
  else status = 'not_started';

  // needs review if practiced/mastered but mastery dropped or open mistakes
  const openMistakes = (state.mistakes || []).filter(
    (m) => !m.resolved && studyIds.includes(m.topicId)
  ).length;
  if ((status === 'practiced' || status === 'mastered') && (mastery < 55 || openMistakes >= 2 || revisionProgress < 30)) {
    status = 'needs_review';
  }

  const livePri = livePriority(
    {
      id: syl.id,
      examImportance: (syl.priorityBase || 50) / 100,
      frequencyScore: syl.hasQuestions ? 0.6 : 0.3,
      foundationScore: syl.chapterNumber === 1 ? 0.9 : 0.6,
      markEfficiency: 0.6,
      priorityBase: syl.priorityBase || 50,
    },
    { topics: { [syl.id]: { mastery } } }
  );

  return {
    id: syl.id,
    status,
    conceptProgress,
    questionProgress,
    mcqProgress,
    revisionProgress,
    mastery,
    overall,
    qAttempt,
    qTotal: qids.length,
    qCorrect,
    mcqTouched,
    mcqTotal: mids.length,
    openMistakes,
    priorityLevel: syl.priorityLevel || livePri.level,
    priorityScore: syl.priorityBase || livePri.score,
    hasStudyMaterial: syl.hasStudyMaterial,
    hasQuestions: syl.hasQuestions,
    hasMcqs: syl.hasMcqs,
    estimatedMinutes: syl.estimatedMinutes || 30,
  };
}

export function computeSyllabusCoverage(content, state) {
  const sylTopics = content.syllabus?.topics || [];
  const sylChapters = content.syllabus?.chapters || [];
  const evaluated = sylTopics.map((t) => ({
    topic: t,
    eval: evaluateSyllabusTopic(t, content, state),
  }));

  const counts = {
    not_started: 0,
    in_progress: 0,
    studied: 0,
    practiced: 0,
    mastered: 0,
    needs_review: 0,
  };
  let coverageSum = 0;
  let masterySum = 0;
  let remainingMinutes = 0;
  let remainingTopics = 0;
  const remQ = new Set();
  const remM = new Set();
  let remainingRevisions = 0;
  let p1Left = 0;
  let p2Left = 0;

  for (const { topic, eval: ev } of evaluated) {
    counts[ev.status] = (counts[ev.status] || 0) + 1;
    // syllabus coverage = meaningful study (not just questions)
    const coveredScore =
      ev.status === 'not_started'
        ? 0
        : ev.status === 'in_progress'
          ? Math.max(25, ev.conceptProgress * 0.5)
          : ev.status === 'studied'
            ? 55
            : ev.status === 'practiced'
              ? 75
              : ev.status === 'needs_review'
                ? 70
                : 100;
    coverageSum += coveredScore;
    masterySum += ev.mastery;

    const incomplete = ev.status === 'not_started' || ev.status === 'in_progress' || ev.status === 'needs_review' || ev.overall < 70;
    if (incomplete) {
      remainingTopics++;
      for (const qid of topic.questionIds || []) {
        if (!state.questions[qid]?.attempted) remQ.add(qid);
      }
      for (const mid of topic.mcqIds || []) {
        if (!state.mcqs[mid]?.attempts) remM.add(mid);
      }
      if (ev.revisionProgress < 50) remainingRevisions++;
      remainingMinutes += Math.max(
        10,
        Math.round(
          (topic.estimatedMinutes || 30) *
            (1 - ev.overall / 100) *
            (ev.priorityLevel === 'P1' ? 1.1 : 1)
        )
      );
      if (ev.priorityLevel === 'P1') p1Left++;
      if (ev.priorityLevel === 'P2') p2Left++;
    }
  }

  const remainingQuestions = remQ.size;
  const remainingMcqs = remM.size;

  const n = evaluated.length || 1;
  const coveragePct = Math.round(coverageSum / n);
  const masteryPct = Math.round(masterySum / n);

  const chapters = sylChapters.map((ch) => {
    const topics = evaluated.filter((e) => e.topic.chapterId === ch.id);
    const cov = topics.length ? Math.round(topics.reduce((s, t) => s + t.eval.overall, 0) / topics.length) : 0;
    const mastered = topics.filter((t) => t.eval.status === 'mastered' || t.eval.status === 'practiced').length;
    const covered = topics.filter((t) => t.eval.status !== 'not_started').length;
    return {
      chapter: ch,
      topics,
      coverage: cov,
      covered,
      total: topics.length,
      mastered,
    };
  });

  const coveredTopics = evaluated.filter((e) => e.eval.status !== 'not_started').length;
  const remainingList = evaluated
    .filter((e) => e.eval.status === 'not_started' || e.eval.status === 'in_progress' || e.eval.status === 'needs_review' || e.eval.overall < 70)
    .sort((a, b) => {
      const rank = { P1: 4, P2: 3, P3: 2, P4: 1 };
      return (rank[b.eval.priorityLevel] || 0) - (rank[a.eval.priorityLevel] || 0) || a.eval.overall - b.eval.overall;
    });

  return {
    coveragePct,
    masteryPct,
    totalTopics: evaluated.length,
    coveredTopics,
    remainingTopics,
    counts,
    chapters,
    evaluated,
    remainingList,
    remainingMinutes,
    remainingQuestions,
    remainingMcqs,
    remainingRevisions,
    p1Left,
    p2Left,
    chaptersCovered: chapters.filter((c) => c.covered === c.total && c.total > 0).length,
    chaptersTotal: chapters.length,
  };
}

export function remainingWorkEstimate(content, state, prefs) {
  const cov = computeSyllabusCoverage(content, state);
  const timing = getExamTiming(prefs || state.prefs || {});
  const availableHours = (prefs?.studyHoursPerDay || state.prefs?.studyHoursPerDay || 6) * Math.max(1, timing.daysLeft || 1);
  const remainingHours = cov.remainingMinutes / 60;
  return {
    ...cov,
    remainingHours,
    availableHours,
    overload: remainingHours > availableHours,
    prioritizeNote:
      remainingHours > availableHours
        ? `~${remainingHours.toFixed(1)}h identified work vs ~${availableHours.toFixed(1)}h available — prioritize P1/P2.`
        : `~${remainingHours.toFixed(1)}h remaining within ~${availableHours.toFixed(1)}h available.`,
  };
}

export function getNextSyllabusGapAction(content, state, prefs) {
  const cov = computeSyllabusCoverage(content, state);
  const timing = getExamTiming(prefs || state.prefs || {});
  let pool = cov.remainingList;
  if (timing.prepDay >= 4) {
    pool = pool.filter((e) => e.eval.priorityLevel === 'P1' || e.eval.status === 'needs_review');
  } else if (timing.prepDay === 3) {
    pool = pool.filter((e) => e.eval.priorityLevel === 'P1' || e.eval.priorityLevel === 'P2' || e.eval.status === 'needs_review');
  }
  const top = pool[0];
  if (!top) return null;
  const reasons = [];
  if (top.eval.status === 'not_started') reasons.push('Syllabus topic not started');
  if (top.eval.status === 'needs_review') reasons.push('Needs review');
  if (top.eval.priorityLevel === 'P1') reasons.push('P1 critical syllabus item');
  if (!top.eval.hasQuestions) reasons.push('Study concept carefully (few mapped questions)');
  else if (top.eval.qAttempt < top.eval.qTotal) reasons.push(`${top.eval.qTotal - top.eval.qAttempt} questions remaining`);
  return {
    syllabusTopic: top.topic,
    eval: top.eval,
    reasons,
    estimatedMinutes: top.eval.estimatedMinutes,
    route: `#/coverage/topic/${top.topic.id}`,
    label: `Cover: ${top.topic.code} ${top.topic.title}`,
  };
}
