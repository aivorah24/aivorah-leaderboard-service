// Ported from ai-mentor/server/routes/student.js — GET/PUT /student/:id,
// POST /student/:id/complete-lesson, POST /student/:id/study-time.
// Same Supabase project/tables as the monolith (student_stats,
// student_daily_log, topic_attempts, the increment_student_* RPCs), and the
// same student_stats-driven gamification data this service's own leaderboard
// already reads — so this is the natural home for it rather than splitting
// XP/level logic across services.
const supabase = require('./supabase');
const { client: qdrant, resolveCollection } = require('./qdrant');
const { normalizeCurriculum } = require('../utils/curriculum');

const CURRICULUM_NAME_SET = new Set([
  'ib pyp', 'ib_pyp', 'ibpyp', 'ncert', 'cbse', 'cambridge', 'oxford', 'pearson',
  'singapore moe', 'singapore_moe', 'general',
]);
function isRealSubject(subject) {
  const s = String(subject || '').trim().toLowerCase();
  return s.length > 0 && !CURRICULUM_NAME_SET.has(s);
}

const _topicCountCache = new Map();
const TOPIC_CACHE_TTL_MS = 30 * 60 * 1000;

async function fetchTotalTopicsFromQdrant(curriculum, grade, subject) {
  const cacheKey = `${curriculum}|${grade}|${subject || ''}`;
  const cached = _topicCountCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  try {
    const normCurr = normalizeCurriculum(curriculum, 'IB PYP');
    const { collection, qdrantCurriculum, qdrantGrade } = resolveCollection(normCurr, grade);
    const mustFilters = [
      { key: 'curriculum', match: { value: qdrantCurriculum } },
      { key: 'grade',      match: { value: qdrantGrade } },
    ];
    if (isRealSubject(subject)) mustFilters.push({ key: 'subject', match: { value: subject } });
    const seen = new Set();
    let offset = null;
    do {
      const result = await qdrant.scroll(collection, {
        filter:       { must: mustFilters },
        limit:        100,
        offset:       offset ?? undefined,
        with_payload: true,
        with_vector:  false,
      });
      for (const point of result.points) {
        const p = point.payload;
        seen.add(`${p.subject}|${p.topic}`);
      }
      offset = result.next_page_offset ?? null;
    } while (offset !== null);
    const count = seen.size;
    _topicCountCache.set(cacheKey, { count, expiresAt: Date.now() + TOPIC_CACHE_TTL_MS });
    return count;
  } catch {
    // Qdrant unreachable / not configured — same graceful fallback as the monolith.
    return 0;
  }
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// Decide the day-rollover patch for getStudentStats() (see aivorah-frontend's
// BUGS_AND_FIXES.md Bug #3.1 / #22). `current_streak` used to be bumped to 1
// purely by opening the app on a new calendar day, even for an account that
// never completed a single lesson/quiz — a login-streak masquerading as a
// learning-streak. It is credited/continued ONLY when `record` shows real
// activity happened on the streak's last active day (today_study_minutes,
// today_xp, or completed_topics growth) — merely viewing the page never
// awards a streak day on its own. Same fix as the monolith's
// ai-mentor/server/routes/student.js:computeStreakRollover — kept in sync
// since this service was ported verbatim from it.
function computeStreakRollover(record, today) {
  if (record.last_active_date === today) return null;
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yISO = yesterday.toISOString().split('T')[0];
  const hadRealActivityYesterday =
    record.last_active_date === yISO &&
    ((record.today_study_minutes || 0) > 0 ||
      (record.today_xp || 0) > 0 ||
      (record.completed_topics || []).length > 0);
  return {
    today_study_minutes: 0,
    today_xp: 0,
    current_streak: hadRealActivityYesterday ? (record.current_streak || 0) + 1 : 0,
    last_active_date: today,
  };
}

function computeLevel(xp) {
  let level = 1, threshold = 500, total = 0;
  while (xp >= total + threshold) { total += threshold; threshold += 250; level++; }
  return level;
}

function normalise(row) {
  return {
    studentId:             row.student_id,
    xpPoints:               row.xp_points,
    level:                  row.level,
    studyTimeMinutes:       row.study_time_minutes,
    learningPathMinutes:    row.learning_path_minutes,
    assignmentTimeMinutes:  row.assignment_time_minutes ?? 0,
    challengeTimeMinutes:   row.challenge_time_minutes ?? 0,
    topicsExplored:         row.topics_explored,
    challengesCompleted:    row.challenges_completed,
    assignmentsDone:        row.assignments_done,
    currentStreak:          row.current_streak,
    lastActiveDate:         row.last_active_date,
    todayStudyMinutes:      row.today_study_minutes,
    todayXP:                row.today_xp,
    completedTopics:        row.completed_topics ?? [],
    startedTopics:          row.started_topics ?? [],
    lastLesson:             row.last_lesson ?? '',
  };
}

async function getOrCreate(studentId) {
  let { data } = await supabase
    .from('student_stats')
    .select('*')
    .eq('student_id', studentId)
    .maybeSingle();

  if (!data) {
    const { data: userExists } = await supabase
      .from('users')
      .select('id')
      .eq('id', studentId)
      .maybeSingle();

    if (!userExists) {
      return {
        student_id: studentId, xp_points: 0, level: 1, current_streak: 0,
        completed_topics: [], study_time_minutes: 0, today_study_minutes: 0,
        today_xp: 0, assignments_done: 0, last_active_date: todayISO(),
      };
    }

    const { data: created, error: createErr } = await supabase
      .from('student_stats')
      .insert({ student_id: studentId, last_active_date: todayISO() })
      .select()
      .single();
    if (createErr) throw createErr;
    data = created;
  }
  return data;
}

async function getStudentStats(id) {
  let record = await getOrCreate(id);
  const today = todayISO();

  const rollover = computeStreakRollover(record, today);
  if (rollover) {
    const { data: updated } = await supabase
      .from('student_stats')
      .update({
        ...rollover,
        updated_at:          new Date().toISOString(),
      })
      .eq('student_id', id)
      .select()
      .single();
    record = updated ?? record;
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('curriculum, grade')
    .eq('id', id)
    .single();

  const curriculum  = userRow?.curriculum ?? '';
  const grade       = userRow?.grade ?? '';
  const totalTopics = await fetchTotalTopicsFromQdrant(curriculum, grade);

  const { count: completedChallenges } = await supabase
    .from('challenge_assignments')
    .select('id', { head: true, count: 'exact' })
    .eq('student_id', id)
    .eq('status', 'completed');

  const base = normalise(record);
  return {
    ...base,
    totalTopics,
    challengesCompleted: Number.isFinite(completedChallenges) ? Number(completedChallenges) : (base.challengesCompleted ?? 0),
  };
}

async function updateStudentStats(id, body) {
  const patch = {};
  if (body.xpPoints            != null) patch.xp_points            = body.xpPoints;
  if (body.level               != null) patch.level                = body.level;
  if (body.topicsExplored      != null) patch.topics_explored      = body.topicsExplored;
  if (body.challengesCompleted != null) patch.challenges_completed = body.challengesCompleted;
  if (body.assignmentsDone     != null) patch.assignments_done     = body.assignmentsDone;
  if (body.currentStreak       != null) patch.current_streak       = body.currentStreak;
  if (body.todayXP             != null) patch.today_xp             = body.todayXP;
  // completed_topics and all study-time fields stay excluded — see the
  // monolith's original comment: they're owned exclusively by
  // completeLesson()/recordStudyTime() so a stale full-state PUT from an idle
  // tab can never overwrite freshly-incremented real progress.
  if (body.lastLesson          != null) patch.last_lesson          = body.lastLesson;
  patch.updated_at = new Date().toISOString();

  // student_stats.student_id has a foreign key on users.id. Right after a
  // brand-new signup, /user/sync (auth-service) is still asynchronously
  // writing that users row — StudentDataContext's stats-sync effect can fire
  // this PUT before it lands, so a blind upsert intermittently 500s on a FK
  // violation (confirmed via local testing: same request, sometimes 500,
  // sometimes fine, purely timing-dependent). Mirror getOrCreate()'s guard:
  // if the user row isn't there yet, skip the write and return the same
  // zero-state shape rather than erroring — the next sync (this effect
  // re-fires on every stats change) succeeds once the row has landed.
  const { data: userExists } = await supabase
    .from('users')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (!userExists) {
    return normalise({
      student_id: id, xp_points: 0, level: 1, current_streak: 0,
      completed_topics: [], study_time_minutes: 0, today_study_minutes: 0,
      today_xp: 0, assignments_done: 0, last_active_date: todayISO(),
    });
  }

  const { data, error } = await supabase
    .from('student_stats')
    .upsert({ student_id: id, ...patch }, { onConflict: 'student_id' })
    .select()
    .single();

  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return normalise(data);
}

async function completeLesson(id, body) {
  const { topic, subject, grade, curriculum } = body ?? {};
  if (!topic) { const e = new Error('topic required'); e.status = 400; throw e; }

  const record = await getOrCreate(id);
  const today  = todayISO();
  const alreadyDone = (record.completed_topics ?? []).includes(topic);

  if (subject) {
    const { data: userRow } = await supabase.from('users').select('grade, curriculum').eq('id', id).maybeSingle();
    const resolvedGrade = grade || userRow?.grade;
    if (resolvedGrade) {
      supabase.from('topic_attempts').insert({
        student_id: id, topic, subject, grade: resolvedGrade,
        curriculum: curriculum || userRow?.curriculum || '',
        attempt_number: 1, total_questions: 0, correct_answers: 0,
        score: 100, passed: true, time_spent_seconds: 0, per_question_results: [],
      }).then(() => {}).catch(() => {});
    }
  }

  const patch = { last_lesson: topic, last_active_date: today, updated_at: new Date().toISOString() };

  if (!alreadyDone) {
    const newXP = (record.xp_points || 0) + 150;
    patch.xp_points        = newXP;
    patch.today_xp         = (record.today_xp || 0) + 150;
    patch.topics_explored  = (record.topics_explored || 0) + 1;
    patch.level             = computeLevel(newXP);
    patch.completed_topics = [...(record.completed_topics ?? []), topic];

    // Increment, not overwrite — a second topic on the same day used to reset this to 1.
    const { data: todayLog } = await supabase
      .from('student_daily_log')
      .select('topics_completed')
      .eq('student_id', id)
      .eq('log_date', today)
      .maybeSingle();

    await supabase.from('student_daily_log').upsert({
      student_id:       id,
      log_date:         today,
      xp_earned:        (record.today_xp || 0) + 150,
      topics_completed: (todayLog?.topics_completed || 0) + 1,
    }, { onConflict: 'student_id,log_date', ignoreDuplicates: false });
  }

  const { data: updated, error } = await supabase
    .from('student_stats')
    .update(patch)
    .eq('student_id', id)
    .select()
    .single();

  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return normalise(updated);
}

// B002 fix: persist "opened Learn/Listen but not yet completed" so it
// survives refresh/re-login — previously tracked only in frontend-local
// state, which the next GET's full-state hydration silently wiped since
// this array was never stored. XP/explore-count are already awarded
// client-side (StudentDataContext.startTopicActivity) and reach the server
// via the existing generic PUT sync; this endpoint only owns the array
// itself, atomically, so a stale full-state PUT from an idle tab can never
// drop a topic another tab just started — same reasoning as completed_topics.
async function startTopic(id, body) {
  const { topic } = body ?? {};
  if (!topic) { const e = new Error('topic required'); e.status = 400; throw e; }

  const record = await getOrCreate(id);
  const alreadyStarted = (record.started_topics ?? []).includes(topic)
    || (record.completed_topics ?? []).includes(topic);

  if (alreadyStarted) return normalise(record);

  const { data: updated, error } = await supabase
    .from('student_stats')
    .update({
      started_topics: [...(record.started_topics ?? []), topic],
      last_active_date: todayISO(),
      updated_at: new Date().toISOString(),
    })
    .eq('student_id', id)
    .select()
    .single();

  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return normalise(updated);
}

async function recordStudyTime(id, body) {
  const { minutes = 1, source, subject } = body ?? {};
  const today = todayISO();

  const { data: updated, error } = await supabase
    .rpc('increment_student_study_time', { p_student_id: id, p_minutes: minutes, p_source: source || null, p_today: today })
    .single();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  const totalMins       = updated.study_time_minutes;
  const todayMins        = updated.today_study_minutes;
  const learningPathMins = updated.learning_path_minutes;
  const assignmentMins   = updated.assignment_time_minutes;
  const challengeMins    = updated.challenge_time_minutes;

  await supabase.from('student_daily_log').upsert({
    student_id:    id,
    log_date:      today,
    study_minutes: todayMins,
  }, { onConflict: 'student_id,log_date', ignoreDuplicates: false });

  if (source === 'learningPath' && subject) {
    await supabase.rpc('increment_student_subject_time', {
      p_student_id: id, p_subject: subject, p_minutes: minutes, p_today: today,
    });
  }

  return { studyTimeMinutes: totalMins, todayStudyMinutes: todayMins, learningPathMinutes: learningPathMins, assignmentTimeMinutes: assignmentMins, challengeTimeMinutes: challengeMins };
}

// ── GET /student/:id/weekly?period=week|month ────────────────
// "week" (default): the current Mon-Sun, one bar per day, unchanged.
// "month": the last 28 days grouped into 4 weekly buckets — the frontend's
// bar chart renders one bar per entry, so 28 individual daily bars would be
// cramped and repeat day-of-week labels; weekly buckets read cleanly
// instead. Bug: previously the "Month" tab existed in the UI but nothing
// ever fetched month-range data — this is the real backend half of that fix.
async function getWeeklyActivity(id, period = 'week') {
  const today = new Date();

  if (period === 'month') {
    const from = new Date(today);
    from.setDate(today.getDate() - 27);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    const { data: logs } = await supabase
      .from('student_daily_log')
      .select('*')
      .eq('student_id', id)
      .gte('log_date', fromStr)
      .lte('log_date', toStr);

    const buckets = [0, 1, 2, 3].map(() => ({ studyMinutes: 0, xp: 0, topicsCompleted: 0 }));
    (logs ?? []).forEach(l => {
      const daysAgo = Math.floor((today - new Date(`${l.log_date}T00:00:00Z`)) / (1000 * 60 * 60 * 24));
      const bucketIdx = Math.min(3, Math.max(0, 3 - Math.floor(daysAgo / 7)));
      buckets[bucketIdx].studyMinutes    += l.study_minutes    ?? 0;
      buckets[bucketIdx].xp              += l.xp_earned        ?? 0;
      buckets[bucketIdx].topicsCompleted += l.topics_completed ?? 0;
    });

    return {
      days: buckets.map((b, i) => {
        const bucketStart = new Date(from);
        bucketStart.setDate(from.getDate() + i * 7);
        return { date: bucketStart.toISOString().split('T')[0], day: `Wk ${i + 1}`, ...b };
      }),
    };
  }

  const todayDay = today.getDay();
  const mondayOffset = todayDay === 0 ? -6 : 1 - todayDay;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({ date: d.toISOString().split('T')[0], day: DAY_NAMES[d.getDay()], future: d > today });
  }
  const from = days[0].date;
  const to   = days[days.length - 1].date;

  const { data: logs } = await supabase
    .from('student_daily_log')
    .select('*')
    .eq('student_id', id)
    .gte('log_date', from)
    .lte('log_date', to);

  const logMap = {};
  (logs ?? []).forEach(l => { logMap[l.log_date] = l; });

  return {
    days: days.map(d => ({
      date:            d.date,
      day:             d.day,
      studyMinutes:    d.future ? 0 : (logMap[d.date]?.study_minutes    ?? 0),
      xp:              d.future ? 0 : (logMap[d.date]?.xp_earned        ?? 0),
      topicsCompleted: d.future ? 0 : (logMap[d.date]?.topics_completed ?? 0),
    })),
  };
}

// ── GET /student/:id/performance?email=... ──────────────────
// Was looked up by email against analytics_events, filtering for
// 'ibpyp_quiz_result'/'ncert_quiz_result' events — but the frontend's real
// quiz-completion flow (useQuiz.ts) has never logged those event types (confirmed
// zero such rows exist anywhere in the database). It DOES write every real quiz
// attempt to `topic_attempts` via POST /student/track-attempt (topic, subject,
// grade, score) — this was already the real source of truth, just never wired
// up here, so Performance/"Mastered"/per-chapter scores stayed stuck at 0% no
// matter how many quizzes a student actually took. Reads topic_attempts by
// student_id (the id already in the URL) instead.
async function getStudentPerformance(id) {
  if (!id) return { topics: {}, avgScore: null, topicCount: 0 };

  const { data: attempts, error } = await supabase
    .from('topic_attempts')
    .select('topic, subject, grade, score, created_at')
    .eq('student_id', id)
    .order('created_at', { ascending: true });
  if (error || !attempts) return { topics: {}, avgScore: null, topicCount: 0 };

  const topicMap = {};
  const allScores = [];

  for (const a of attempts) {
    const topic = a.topic || '';
    if (!topic || typeof a.score !== 'number') continue;

    if (!topicMap[topic]) {
      topicMap[topic] = { subject: a.subject || '', grade: a.grade || '', quizScores: [], sessions: 0, lastActivity: '' };
    }
    const t = topicMap[topic];
    t.quizScores.push(a.score);
    allScores.push(a.score);
    t.sessions++;
    if (a.created_at && a.created_at > t.lastActivity) t.lastActivity = a.created_at;
  }

  const topics = {};
  for (const [topic, t] of Object.entries(topicMap)) {
    const avgScore = t.quizScores.length > 0
      ? Math.round(t.quizScores.reduce((a, b) => a + b, 0) / t.quizScores.length)
      : null;
    topics[topic] = { subject: t.subject, grade: t.grade, avgScore, quizCount: t.quizScores.length, sessions: t.sessions, lastActivity: t.lastActivity };
  }

  const avgScore = allScores.length > 0
    ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
    : null;

  return { topics, avgScore, topicCount: Object.keys(topics).length };
}

// ── GET /student/:id/attempts ────────────────────────────────
// Every real practice attempt (newest first) with its per-question answers,
// for the parent's topic drill-down. Optional subject filter (case-insensitive).
async function getTopicAttempts(id, subject) {
  if (!id) return { attempts: [] };

  const { data, error } = await supabase
    .from('topic_attempts')
    .select('id, topic, subject, attempt_number, score, passed, total_questions, correct_answers, time_spent_seconds, per_question_results, created_at')
    .eq('student_id', id)
    .order('created_at', { ascending: false });
  if (error || !data) return { attempts: [] };

  const want = (subject || '').trim().toLowerCase();
  const attempts = data
    // Old completeLesson() rows (no questions) aren't real quizzes.
    .filter(a => a.topic && typeof a.score === 'number' && (a.total_questions || (a.per_question_results || []).length))
    .filter(a => !want || (a.subject || '').trim().toLowerCase() === want)
    .map(a => ({
      id: a.id,
      topic: a.topic,
      subject: a.subject || '',
      attemptNumber: a.attempt_number ?? null,
      score: a.score,
      passed: !!a.passed,
      totalQuestions: a.total_questions || 0,
      correctAnswers: a.correct_answers ?? 0,
      timeSpentSeconds: a.time_spent_seconds || 0,
      createdAt: a.created_at,
      questions: (a.per_question_results || []).map(q => ({
        question: q.question || '',
        studentAnswer: q.studentAnswer ?? '',
        correctAnswer: q.correctAnswer ?? '',
        isCorrect: !!q.isCorrect,
        timeSeconds: q.timeSeconds ?? null,
      })),
    }));
  return { attempts };
}

// ── POST /student/track-attempt ──────────────────────────────
async function trackAttempt(body) {
  const {
    studentId, topic, subject, grade, curriculum = '',
    totalQuestions, correctAnswers, score,
    timeSpentSeconds = 0, perQuestionResults = [], attemptNumber = 1,
  } = body ?? {};

  if (!studentId || !topic || !subject || !grade || score == null) {
    const e = new Error('studentId, topic, subject, grade, score are required');
    e.status = 400;
    throw e;
  }

  // PASS_THRESHOLD contract: kept in sync manually with aivorah-frontend's
  // src/screens/student/utils/masteryRules.ts (PASS_THRESHOLD = 60). No
  // shared package between the two repos by design (RCA Phase 3 gate 7) —
  // if this value changes, update both files together.
  const passed = score >= 60;

  const { data, error } = await supabase
    .from('topic_attempts')
    .insert({
      student_id:           studentId,
      topic, subject, grade, curriculum,
      attempt_number:       attemptNumber,
      total_questions:      totalQuestions || perQuestionResults.length || 0,
      correct_answers:      correctAnswers ?? perQuestionResults.filter(q => q.isCorrect).length,
      score:                parseFloat(score),
      passed,
      time_spent_seconds:   timeSpentSeconds,
      per_question_results: perQuestionResults,
    })
    .select()
    .single();

  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return { ok: true, passed, attempt: data };
}

module.exports = { getStudentStats, updateStudentStats, completeLesson, startTopic, recordStudyTime, getWeeklyActivity, getStudentPerformance, getTopicAttempts, trackAttempt, computeStreakRollover };
