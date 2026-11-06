const supabase = require('./supabase');

const PERIODS = new Set(['all', 'today', 'week', 'month', 'custom']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// PostgREST returns at most 1000 rows per request by default; a month of
// daily logs for a 40+ student class goes past that, so period queries page.
const PAGE_SIZE = 1000;

function isoDay(d) {
  return d.toISOString().split('T')[0];
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/**
 * Turn a leaderboard period into an inclusive { from, to } range of
 * 'YYYY-MM-DD' days, or null for the all-time leaderboard.
 * Days are UTC, the same calendar student_daily_log.log_date is written in
 * (student-stats.js todayISO). Weeks run Monday-Sunday, matching
 * GET /student/:id/weekly.
 */
function resolvePeriodRange(period = 'all', date = '', now = new Date()) {
  const p = String(period || 'all').toLowerCase();
  if (!PERIODS.has(p)) throw badRequest(`Unknown period "${period}". Use all, today, week, month or custom.`);
  if (p === 'all') return null;

  const today = isoDay(now);
  if (p === 'today') return { from: today, to: today };

  if (p === 'week') {
    const dow = now.getUTCDay(); // 0 = Sunday
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow === 0 ? 6 : dow - 1)));
    const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
    return { from: isoDay(monday), to: isoDay(sunday) };
  }

  if (p === 'month') {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const last  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { from: isoDay(first), to: isoDay(last) };
  }

  // custom: one chosen day
  const d = String(date || '').trim();
  const parsed = ISO_DATE.test(d) ? new Date(`${d}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || isoDay(parsed) !== d) {
    throw badRequest('period=custom needs date=YYYY-MM-DD');
  }
  return { from: d, to: d };
}

async function fetchAllPages(buildQuery) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function toEntry(s, user, rank, score) {
  return {
    rank,
    id:      s.student_id,
    name:    user.name || 'Student',
    grade:   user.grade || 'Grade 3',
    score,
    level:   s.level ?? 1,
    streak:  s.current_streak ?? 0,
    topics:  [...new Set(s.completed_topics ?? [])].length,
  };
}

/**
 * Leaderboard ranked by XP earned in a date range (student_daily_log.xp_earned)
 * instead of all-time XP (student_stats.xp_points).
 * Scoped: every student in scope who has a stats row is listed, 0 XP included,
 * so the class roster stays the same whichever period is picked.
 * Unscoped: only students who earned XP in the range.
 */
async function getPeriodLeaderboard({ range, allowedUsers, limit }) {
  const allowedIds = allowedUsers ? Object.keys(allowedUsers) : null;

  const logs = await fetchAllPages(() => {
    let q = supabase
      .from('student_daily_log')
      .select('student_id, log_date, xp_earned')
      .gte('log_date', range.from)
      .lte('log_date', range.to)
      .order('log_date', { ascending: true });
    if (allowedIds) q = q.in('student_id', allowedIds);
    return q;
  });

  const periodXP = {};
  logs.forEach(l => { periodXP[l.student_id] = (periodXP[l.student_id] || 0) + (l.xp_earned || 0); });

  const candidateIds = allowedIds || Object.keys(periodXP).filter(id => periodXP[id] > 0);
  if (candidateIds.length === 0) return [];

  const stats = await fetchAllPages(() => supabase
    .from('student_stats')
    .select('student_id, xp_points, level, current_streak, completed_topics')
    .in('student_id', candidateIds)
    .order('student_id', { ascending: true }));
  if (stats.length === 0) return [];

  let userMap = allowedUsers;
  if (!userMap) {
    const { data: users } = await supabase
      .from('users')
      .select('id, name, grade')
      .in('id', stats.map(s => s.student_id));
    userMap = {};
    (users ?? []).forEach(u => { userMap[u.id] = u; });
  }

  // Highest XP in the period first; ties go to all-time XP, then name, so the
  // order is stable between refreshes.
  const sorted = [...stats].sort((a, b) =>
    (periodXP[b.student_id] || 0) - (periodXP[a.student_id] || 0)
    || (b.xp_points || 0) - (a.xp_points || 0)
    || String(userMap[a.student_id]?.name || '').localeCompare(String(userMap[b.student_id]?.name || '')));

  return sorted
    .slice(0, limit)
    .map((s, i) => toEntry(s, userMap[s.student_id] ?? {}, i + 1, periodXP[s.student_id] || 0));
}

/**
 * Get leaderboard logic, extracted from student routes.
 *
 * period/date: 'all' (default, all-time XP) or 'today' | 'week' | 'month' |
 * 'custom' (+ date) to rank by XP earned in that range.
 * classGrade: teacher leaderboard only — narrow the class to one of the
 * teacher's grades. A grade the teacher doesn't teach returns nothing.
 */
async function getLeaderboard({
  limit = 50, teacherEmail = '', gradeFilter = [], schoolFilter = '', curriculumFilter = '',
  period = 'all', date = '', classGrade = '', now = new Date(),
}) {
  const range = resolvePeriodRange(period, date, now);
  let allowedUsers = null;

  if (!teacherEmail && (gradeFilter.length > 0 || schoolFilter || curriculumFilter)) {
    // Scoped (parent) leaderboard: students matching ALL provided filters.
    let uq = supabase
      .from('users')
      .select('id, name, grade, school, curriculum')
      .eq('role', 'student');

    if (gradeFilter.length > 0) uq = uq.in('grade', gradeFilter);
    if (schoolFilter)           uq = uq.eq('school', schoolFilter);
    if (curriculumFilter)       uq = uq.eq('curriculum', curriculumFilter);

    const { data: us } = await uq;
    allowedUsers = {};
    (us || []).forEach(u => { allowedUsers[u.id] = u; });
  }

  if (teacherEmail) {
    const { data: teacher } = await supabase
      .from('users')
      .select('id, grade, curriculum, school')
      .eq('email', teacherEmail)
      .maybeSingle();

    // Grades the teacher teaches: teaches[] (authoritative) → users.grade
    let scopeGrades = null;
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', teacherEmail)
      .maybeSingle();

    const teaches = prefs?.data?.teaches;
    if (Array.isArray(teaches) && teaches.length > 0) {
      const g = [...new Set(teaches.map(t => t.grade).filter(Boolean))];
      if (g.length) scopeGrades = g;
    } else if (teacher?.grade) {
      scopeGrades = [teacher.grade];
    }

    if (classGrade) {
      // Never widen the class: only one of the teacher's own grades.
      if (scopeGrades && !scopeGrades.includes(classGrade)) return [];
      scopeGrades = [classGrade];
    }

    // Class leaderboard = every student in the teacher's school + curriculum
    let uq = supabase
      .from('users')
      .select('id, name, grade')
      .eq('role', 'student');

    if (scopeGrades)          uq = uq.in('grade', scopeGrades);
    if (teacher?.curriculum)  uq = uq.eq('curriculum', teacher.curriculum);
    if (teacher?.school)      uq = uq.eq('school', teacher.school);

    const { data: us } = await uq;
    allowedUsers = {};
    (us || []).forEach(u => { allowedUsers[u.id] = u; });
  }

  if (allowedUsers && Object.keys(allowedUsers).length === 0) return [];

  if (range) return getPeriodLeaderboard({ range, allowedUsers, limit });

  let sq = supabase
    .from('student_stats')
    .select('student_id, xp_points, level, current_streak, completed_topics')
    .order('xp_points', { ascending: false });

  if (allowedUsers) {
    sq = sq.in('student_id', Object.keys(allowedUsers));
  }
  sq = sq.limit(limit);

  const { data: stats, error } = await sq;
  if (error) throw new Error(error.message);
  if (!stats || stats.length === 0) return [];

  let userMap = allowedUsers;
  if (!userMap) {
    const ids = stats.map(s => s.student_id);
    const { data: users } = await supabase
      .from('users')
      .select('id, name, grade')
      .in('id', ids);
    userMap = {};
    (users ?? []).forEach(u => { userMap[u.id] = u; });
  }

  return stats.map((s, i) => toEntry(s, userMap[s.student_id] ?? {}, i + 1, s.xp_points ?? 0));
}

module.exports = { getLeaderboard, resolvePeriodRange };
