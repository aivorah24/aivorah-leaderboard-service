const supabase = require('./supabase');

/**
 * Get leaderboard logic, extracted from student routes.
 */
async function getLeaderboard({ limit = 50, teacherEmail = '', gradeFilter = [], schoolFilter = '', curriculumFilter = '' }) {
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

  let sq = supabase
    .from('student_stats')
    .select('student_id, xp_points, level, current_streak, completed_topics')
    .order('xp_points', { ascending: false });

  if (allowedUsers) {
    const allowedIds = Object.keys(allowedUsers);
    if (allowedIds.length === 0) return [];
    sq = sq.in('student_id', allowedIds);
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

  return stats.map((s, i) => {
    const user = userMap[s.student_id] ?? {};
    return {
      rank:    i + 1,
      id:      s.student_id,
      name:    user.name || 'Student',
      grade:   user.grade || 'Grade 3',
      score:   s.xp_points ?? 0,
      level:   s.level ?? 1,
      streak:  s.current_streak ?? 0,
      topics:  [...new Set(s.completed_topics ?? [])].length,
    };
  });
}

module.exports = { getLeaderboard };
