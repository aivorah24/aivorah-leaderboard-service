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

jest.mock('../../services/analytics', () => ({ readEvents: jest.fn() }));

const supabase = require('../../services/supabase');
const qdrant = require('../../services/qdrant');
const { readEvents } = require('../../services/analytics');
const { getStudentStats, updateStudentStats, completeLesson, recordStudyTime, getWeeklyActivity, getStudentPerformance, trackAttempt } = require('../../services/student-stats');

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

  test('a real ALREADY-completed topic awards no extra XP', async () => {
    supabase._chain.maybeSingle.mockResolvedValue({ data: STATS_ROW });
    supabase._chain.single.mockResolvedValue({ data: STATS_ROW }); // unchanged
    const result = await completeLesson('s1', { topic: 't1' }); // t1 already in completed_topics
    expect(result.xpPoints).toBe(200); // unchanged from STATS_ROW
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
});

describe('getStudentPerformance', () => {
  test('a real empty email returns the real zero-state shape without querying events', async () => {
    const result = await getStudentPerformance('');
    expect(result).toEqual({ topics: {}, avgScore: null, topicCount: 0 });
    expect(readEvents).not.toHaveBeenCalled();
  });

  test('real quiz-result events are averaged per topic and overall', async () => {
    readEvents.mockResolvedValue([
      { topic: 'Fractions', subject: 'Math', grade: 'Grade 4', eventType: 'ibpyp_quiz_result', score: 80, timestamp: '2026-01-01' },
      { topic: 'Fractions', subject: 'Math', grade: 'Grade 4', eventType: 'ibpyp_quiz_result', score: 60, timestamp: '2026-01-02' },
      { topic: 'Fractions', subject: 'Math', grade: 'Grade 4', eventType: 'lesson_started' },
    ]);
    const result = await getStudentPerformance('a@a.com');
    expect(result.topics.Fractions.avgScore).toBe(70);
    expect(result.topics.Fractions.sessions).toBe(1);
    expect(result.avgScore).toBe(70);
    expect(result.topicCount).toBe(1);
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
