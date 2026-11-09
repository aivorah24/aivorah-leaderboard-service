jest.mock('../../services/supabase', () => {
  const chain = {
    select:      jest.fn().mockReturnThis(),
    eq:          jest.fn().mockReturnThis(),
    in:          jest.fn().mockReturnThis(),
    gte:         jest.fn().mockReturnThis(),
    lte:         jest.fn().mockReturnThis(),
    order:       jest.fn().mockReturnThis(),
    update:      jest.fn().mockReturnThis(),
    insert:      jest.fn().mockReturnThis(),
    upsert:      jest.fn().mockReturnThis(),
    limit:       jest.fn(),
    single:      jest.fn(),
    maybeSingle: jest.fn(),
    then:        (resolve) => resolve({ data: [], error: null }), // fire-and-forget inserts
  };
  const rpcResult = { single: jest.fn() };
  return { from: jest.fn(() => chain), rpc: jest.fn(() => rpcResult), _chain: chain, _rpcResult: rpcResult };
});

jest.mock('../../services/qdrant', () => ({
  client: { scroll: jest.fn() },
  resolveCollection: jest.fn(() => ({ collection: 'c', qdrantCurriculum: 'IB PYP', qdrantGrade: 'Grade 4' })),
}));

const supabase = require('../../services/supabase');
const qdrant = require('../../services/qdrant');
const { getStudentStats, updateStudentStats, completeLesson, startTopic, recordStudyTime, getWeeklyActivity, getStudentPerformance, getTopicAttempts, trackAttempt } = require('../../services/student-stats');

const STATS_ROW = {
  student_id: 's1', xp_points: 200, level: 1, current_streak: 3,
  completed_topics: ['t1'], study_time_minutes: 50, today_study_minutes: 10,
  today_xp: 50, assignments_done: 2, last_active_date: new Date().toISOString().split('T')[0],
  last_lesson: 't1',
};

beforeEach(() => {
  jest.clearAllMocks();
  supabase._chain.maybeSingle.mockResolvedValue({ data: STATS_ROW });
  supabase._chain.single.mockResolvedValue({ data: { curriculum: 'IB PYP', grade: 'Grade 4' } });
  supabase._chain.limit.mockResolvedValue({ count: 0 });
  qdrant.client.scroll.mockResolvedValue({ points: [], next_page_offset: null });
});

describe('getStudentStats', () => {
  test('a real existing row for today is returned without a day-rollover write', async () => {
    const result = await getStudentStats('s1');
    expect(result.xpPoints).toBe(200);
    expect(result.studentId).toBe('s1');
  });

  test('the stats row, the users row and the challenge count are requested at the same time', async () => {
    let releaseStats;
    supabase._chain.maybeSingle.mockReturnValueOnce(new Promise((r) => { releaseStats = r; }));
    const pending = getStudentStats('s1');
    await new Promise((r) => setImmediate(r));
    // Still waiting on student_stats, yet the other two lookups already went out.
    const tables = supabase.from.mock.calls.map((c) => c[0]);
    expect(tables).toEqual(expect.arrayContaining(['student_stats', 'users', 'challenge_assignments']));
    releaseStats({ data: STATS_ROW });
    const result = await pending;
    expect(result.xpPoints).toBe(200);
  });

  test('a real Qdrant failure falls back to totalTopics: 0, not a thrown error', async () => {
    qdrant.client.scroll.mockRejectedValue(new Error('unreachable'));
    const result = await getStudentStats('s1');
    expect(result.totalTopics).toBe(0);
  });
});

describe('updateStudentStats', () => {
  test('a real PUT patch upserts only the truthy fields provided', async () => {
    supabase._chain.single.mockResolvedValue({ data: { ...STATS_ROW, xp_points: 999 } });
    const result = await updateStudentStats('s1', { xpPoints: 999 });
    expect(supabase.from).toHaveBeenCalledWith('student_stats');
    expect(result.xpPoints).toBe(999);
  });

  test('a real db error is surfaced as a 500', async () => {
    supabase._chain.single.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(updateStudentStats('s1', { xpPoints: 1 })).rejects.toMatchObject({ status: 500 });
  });

  // Regression test: right after a brand-new signup, the users row can still
  // be landing when this PUT fires (StudentDataContext's stats-sync effect).
  // student_stats.student_id has a FK on users.id, so a blind upsert used to
  // 500 intermittently — confirmed via local testing (same request, some
  // requests failed, some didn't, purely timing-dependent on whether the
  // signup's users-row write had landed yet).
  test('a real not-yet-created user row is handled gracefully, not a 500', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: null }); // users row not found
    const result = await updateStudentStats('brand-new-id', { xpPoints: 500 });
    expect(result.xpPoints).toBe(0); // zero-state, not the requested patch — nothing was written
    expect(supabase.from).not.toHaveBeenCalledWith('student_stats'); // never attempted the upsert
  });
});

describe('updateStudentStats — mirrors todayXP into student_daily_log', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyLogUpserts = () => supabase._chain.upsert.mock.calls
    .map(c => c[0])
    .filter(row => row && row.log_date);

  beforeEach(() => {
    supabase._chain.single.mockResolvedValue({ data: STATS_ROW });
  });

  test('challenge/quiz XP synced via PUT is written to today\'s daily log', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 's1' } })       // users row exists
      .mockResolvedValueOnce({ data: { xp_earned: 150 } }); // today's log so far (a lesson)
    await updateStudentStats('s1', { todayXP: 230, lastActiveDate: today });
    expect(dailyLogUpserts()).toEqual([{ student_id: 's1', log_date: today, xp_earned: 230 }]);
  });

  test('a stale PUT with a lower todayXP never lowers the logged XP', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 's1' } })
      .mockResolvedValueOnce({ data: { xp_earned: 300 } });
    await updateStudentStats('s1', { todayXP: 120, lastActiveDate: today });
    expect(dailyLogUpserts()).toEqual([]);
  });

  test('todayXP left over from another day is not written to today', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 's1' } });
    await updateStudentStats('s1', { todayXP: 90, lastActiveDate: '2020-01-01' });
    expect(dailyLogUpserts()).toEqual([]);
  });

  test('no todayXP in the body (or 0) -> no daily log write', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: { id: 's1' } });
    await updateStudentStats('s1', { xpPoints: 999 });
    await updateStudentStats('s1', { todayXP: 0, lastActiveDate: today });
    expect(dailyLogUpserts()).toEqual([]);
  });

  test('a failing daily-log write does not fail the stats PUT', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 's1' } })
      .mockRejectedValueOnce(new Error('daily log down'));
    const result = await updateStudentStats('s1', { todayXP: 40, lastActiveDate: today });
    expect(result.xpPoints).toBe(200);
  });
});

describe('completeLesson', () => {
  test('a real missing topic throws a real 400', async () => {
    await expect(completeLesson('s1', {})).rejects.toMatchObject({ status: 400 });
  });

  test('a real NEW topic awards 150 XP and appends to completed_topics', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: STATS_ROW }); // getOrCreate
    supabase._chain.single.mockResolvedValue({ data: { ...STATS_ROW, xp_points: 350, completed_topics: ['t1', 't2'] } });
    const result = await completeLesson('s1', { topic: 't2' });
    expect(result.xpPoints).toBe(350);
    expect(result.completedTopics).toEqual(['t1', 't2']);
  });

  test('a second NEW topic on the same day increments the daily log, not overwrites it to 1', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: STATS_ROW })                   // getOrCreate
      .mockResolvedValueOnce({ data: { topics_completed: 1 } });    // today's daily log
    supabase._chain.single.mockResolvedValue({ data: { ...STATS_ROW, completed_topics: ['t1', 't2'] } });

    await completeLesson('s1', { topic: 't2' });

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ log_date: expect.any(String), topics_completed: 2 }),
      expect.anything(),
    );
  });

  test('the first topic of the day starts the daily log at 1', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: STATS_ROW })
      .mockResolvedValueOnce({ data: null }); // no log row yet today
    supabase._chain.single.mockResolvedValue({ data: STATS_ROW });

    await completeLesson('s1', { topic: 't2' });

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ topics_completed: 1 }),
      expect.anything(),
    );
  });

  test('a real ALREADY-completed topic awards no extra XP', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: STATS_ROW });
    supabase._chain.single.mockResolvedValue({ data: STATS_ROW }); // unchanged
    const result = await completeLesson('s1', { topic: 't1' }); // t1 already in completed_topics
    expect(result.xpPoints).toBe(200); // unchanged from STATS_ROW
  });
});

describe('startTopic (B002 fix)', () => {
  test('a real missing topic throws a real 400', async () => {
    await expect(startTopic('s1', {})).rejects.toMatchObject({ status: 400 });
  });

  test('a real NEW started topic is appended to started_topics', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: { ...STATS_ROW, started_topics: ['t1'] } }); // getOrCreate
    supabase._chain.single.mockResolvedValue({ data: { ...STATS_ROW, started_topics: ['t1', 't3'] } });
    const result = await startTopic('s1', { topic: 't3' });
    expect(supabase.from).toHaveBeenCalledWith('student_stats');
    expect(result.startedTopics).toEqual(['t1', 't3']);
  });

  test('a real ALREADY-started topic is a no-op, not duplicated', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: { ...STATS_ROW, started_topics: ['t1'] } });
    const result = await startTopic('s1', { topic: 't1' });
    expect(result.startedTopics).toEqual(['t1']); // unchanged, not appended again
  });

  test('a real ALREADY-completed topic is also treated as started, not re-added', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: { ...STATS_ROW, completed_topics: ['t1'], started_topics: [] } });
    const result = await startTopic('s1', { topic: 't1' });
    expect(result.startedTopics).toEqual([]); // no write attempted — a completed topic is never shown as merely in-progress
  });
});

describe('recordStudyTime', () => {
  test('a real minutes increment calls the atomic RPC and returns real totals', async () => {
    supabase._rpcResult.single.mockResolvedValue({
      data: { study_time_minutes: 60, today_study_minutes: 20, learning_path_minutes: 10, assignment_time_minutes: 5, challenge_time_minutes: 0 },
      error: null,
    });
    const result = await recordStudyTime('s1', { minutes: 10, source: 'learningPath', subject: 'Math' });
    expect(supabase.rpc).toHaveBeenCalledWith('increment_student_study_time', expect.objectContaining({ p_student_id: 's1', p_minutes: 10 }));
    expect(result.studyTimeMinutes).toBe(60);
  });

  test('a real rpc error is surfaced as a 500', async () => {
    supabase._rpcResult.single.mockResolvedValue({ data: null, error: { message: 'rpc failed' } });
    await expect(recordStudyTime('s1', { minutes: 5 })).rejects.toMatchObject({ status: 500 });
  });
});

describe('getWeeklyActivity', () => {
  test('returns a real 7-day window with real zeros for days with no log', async () => {
    supabase._chain.limit.mockResolvedValue({ data: [] }); // .gte/.lte chain resolves via `then`
    supabase._chain.then = (resolve) => resolve({ data: [] });
    const result = await getWeeklyActivity('s1');
    expect(result.days).toHaveLength(7);
    expect(result.days[0]).toHaveProperty('studyMinutes', 0);
  });

  test('a real logged day is mapped onto its real date', async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    supabase._chain.then = (resolve) => resolve({ data: [{ log_date: todayStr, study_minutes: 30, xp_earned: 50, topics_completed: 2 }] });
    const result = await getWeeklyActivity('s1');
    const todayEntry = result.days.find(d => d.date === todayStr);
    expect(todayEntry.studyMinutes).toBe(30);
    expect(todayEntry.xp).toBe(50);
  });

  test('period="month" returns 4 real weekly buckets covering the last 28 days, not 7 individual days', async () => {
    supabase._chain.then = (resolve) => resolve({ data: [] });
    const result = await getWeeklyActivity('s1', 'month');
    expect(result.days).toHaveLength(4);
  });

  test('period="month" sums each real logged day into its real containing week bucket', async () => {
    const today = new Date();
    const tenDaysAgo = new Date(today); tenDaysAgo.setDate(today.getDate() - 10);
    const tenDaysAgoStr = tenDaysAgo.toISOString().split('T')[0];
    supabase._chain.then = (resolve) => resolve({
      data: [{ log_date: tenDaysAgoStr, study_minutes: 40, xp_earned: 60, topics_completed: 3 }],
    });
    const result = await getWeeklyActivity('s1', 'month');
    const totalStudyMinutes = result.days.reduce((sum, d) => sum + d.studyMinutes, 0);
    const totalXp = result.days.reduce((sum, d) => sum + d.xp, 0);
    expect(totalStudyMinutes).toBe(40);
    expect(totalXp).toBe(60);
  });

  test('period defaults to "week" (7 individual days) when not specified, unchanged from before', async () => {
    supabase._chain.then = (resolve) => resolve({ data: [] });
    const result = await getWeeklyActivity('s1');
    expect(result.days).toHaveLength(7);
  });
});

describe('getStudentPerformance', () => {
  // Bug: this used to read analytics_events for 'ibpyp_quiz_result'/
  // 'ncert_quiz_result' events, which the real quiz-completion flow
  // (useQuiz.ts) never logs — confirmed zero such rows exist anywhere in the
  // database. Real quiz attempts DO land in topic_attempts (via
  // POST /student/track-attempt), so that's what this now reads, keyed by
  // student_id (the id param), not email.
  test('a real empty id returns the real zero-state shape without querying the DB', async () => {
    const result = await getStudentPerformance('');
    expect(result).toEqual({ topics: {}, avgScore: null, topicCount: 0 });
    expect(supabase.from).not.toHaveBeenCalledWith('topic_attempts');
  });

  test('real topic_attempts rows are averaged per topic and overall', async () => {
    supabase._chain.then = (resolve) => resolve({
      data: [
        { topic: 'Fractions', subject: 'Math', grade: 'Grade 4', score: 80, created_at: '2026-01-01' },
        { topic: 'Fractions', subject: 'Math', grade: 'Grade 4', score: 60, created_at: '2026-01-02' },
      ],
      error: null,
    });
    const result = await getStudentPerformance('student-1');
    expect(supabase.from).toHaveBeenCalledWith('topic_attempts');
    expect(result.topics.Fractions.avgScore).toBe(70);
    expect(result.topics.Fractions.quizCount).toBe(2);
    expect(result.topics.Fractions.sessions).toBe(2);
    expect(result.avgScore).toBe(70);
    expect(result.topicCount).toBe(1);
  });

  test('a Supabase error returns the zero-state shape rather than throwing', async () => {
    supabase._chain.then = (resolve) => resolve({ data: null, error: { message: 'boom' } });
    const result = await getStudentPerformance('student-1');
    expect(result).toEqual({ topics: {}, avgScore: null, topicCount: 0 });
  });
});

describe('getTopicAttempts', () => {
  const Q = [
    { question: '2+2?', studentAnswer: '5', correctAnswer: '4', isCorrect: false, timeSeconds: 7 },
    { question: '3+3?', studentAnswer: '6', correctAnswer: '6', isCorrect: true, timeSeconds: 4 },
  ];

  test('an empty id returns no attempts without querying the DB', async () => {
    expect(await getTopicAttempts('')).toEqual({ attempts: [] });
    expect(supabase.from).not.toHaveBeenCalledWith('topic_attempts');
  });

  test('returns real attempts with answers, filtered by subject, dropping synthetic rows', async () => {
    supabase._chain.then = (resolve) => resolve({
      data: [
        { id: 'a2', topic: 'Fractions', subject: 'Mathematics', attempt_number: 2, score: 50, passed: false, total_questions: 2, correct_answers: 1, time_spent_seconds: 40, per_question_results: Q, created_at: '2026-10-02' },
        { id: 'a1', topic: 'Kite', subject: 'English', attempt_number: 1, score: 100, passed: true, total_questions: 2, correct_answers: 2, time_spent_seconds: 30, per_question_results: [], created_at: '2026-10-01' },
        { id: 'syn', topic: 'Fractions', subject: 'Mathematics', score: 100, total_questions: 0, per_question_results: [], created_at: '2026-09-01' },
      ],
      error: null,
    });
    const { attempts } = await getTopicAttempts('student-1', 'mathematics');
    expect(supabase._chain.eq).toHaveBeenCalledWith('student_id', 'student-1');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: 'a2', topic: 'Fractions', attemptNumber: 2, score: 50, timeSpentSeconds: 40, correctAnswers: 1 });
    expect(attempts[0].questions[0]).toEqual({ question: '2+2?', studentAnswer: '5', correctAnswer: '4', isCorrect: false, timeSeconds: 7 });
  });

  test('the spoken question keeps its type and AI evaluation (History report)', async () => {
    const evaluation = { score: 7, outOf: 10, passed: true, verdict: 'good', covered: ['main idea'], missing: [], mistakes: [], feedback: 'Nice!' };
    supabase._chain.then = (resolve) => resolve({
      data: [{ id: 'a3', topic: 'Kite', subject: 'English', attempt_number: 1, score: 67, passed: true, total_questions: 3, correct_answers: 2, time_spent_seconds: 90,
        per_question_results: [...Q, { question: 'Explain "Kite"', studentAnswer: 'It flies', correctAnswer: '', isCorrect: true, timeSeconds: 40, type: 'spoken', evaluation }],
        created_at: '2026-11-07T10:30:00Z' }],
      error: null,
    });
    const { attempts } = await getTopicAttempts('student-1', 'English');
    expect(attempts[0].createdAt).toBe('2026-11-07T10:30:00Z');
    expect(attempts[0].questions[2]).toEqual({ question: 'Explain "Kite"', studentAnswer: 'It flies', correctAnswer: '', isCorrect: true, timeSeconds: 40, type: 'spoken', evaluation });
    // ordinary questions are unchanged (no type / evaluation keys)
    expect(attempts[0].questions[0]).not.toHaveProperty('type');
  });

  test('a Supabase error returns no attempts rather than throwing', async () => {
    supabase._chain.then = (resolve) => resolve({ data: null, error: { message: 'boom' } });
    expect(await getTopicAttempts('student-1')).toEqual({ attempts: [] });
  });
});

describe('trackAttempt', () => {
  test('a real missing required field throws a real 400', async () => {
    await expect(trackAttempt({ studentId: 's1', topic: 't1' })).rejects.toMatchObject({ status: 400 });
  });

  test('a real score >= 60 is recorded as passed', async () => {
    supabase._chain.single.mockResolvedValue({ data: { id: 'a1' }, error: null });
    const result = await trackAttempt({ studentId: 's1', topic: 't1', subject: 'Math', grade: 'Grade 4', score: 75 });
    expect(result.passed).toBe(true);
    expect(supabase.from).toHaveBeenCalledWith('topic_attempts');
  });

  test('a real score below 60 is recorded as not passed', async () => {
    supabase._chain.single.mockResolvedValue({ data: { id: 'a1' }, error: null });
    const result = await trackAttempt({ studentId: 's1', topic: 't1', subject: 'Math', grade: 'Grade 4', score: 40 });
    expect(result.passed).toBe(false);
  });
});
