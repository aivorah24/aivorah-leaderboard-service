jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../services/supabase');
const { getLeaderboard, resolvePeriodRange } = require('../../services/leaderboard');

// Thursday 2026-11-05, 10:00 UTC
const NOW = new Date('2026-11-05T10:00:00Z');

describe('resolvePeriodRange', () => {
  test('all (or nothing) -> null, the all-time leaderboard', () => {
    expect(resolvePeriodRange('all', '', NOW)).toBeNull();
    expect(resolvePeriodRange(undefined, '', NOW)).toBeNull();
  });

  test('today -> just today', () => {
    expect(resolvePeriodRange('today', '', NOW)).toEqual({ from: '2026-11-05', to: '2026-11-05' });
  });

  test('week -> Monday to Sunday of the current week', () => {
    expect(resolvePeriodRange('week', '', NOW)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  test('week on a Sunday still belongs to the week that started Monday', () => {
    expect(resolvePeriodRange('week', '', new Date('2026-11-08T22:00:00Z'))).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  test('week across a month boundary', () => {
    expect(resolvePeriodRange('week', '', new Date('2026-12-02T08:00:00Z'))).toEqual({ from: '2026-11-30', to: '2026-12-06' });
  });

  test('month -> first to last day of the current month', () => {
    expect(resolvePeriodRange('month', '', NOW)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(resolvePeriodRange('month', '', new Date('2028-02-10T00:00:00Z'))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  test('custom -> the chosen day', () => {
    expect(resolvePeriodRange('custom', '2026-10-21', NOW)).toEqual({ from: '2026-10-21', to: '2026-10-21' });
  });

  test('custom without a valid date is a 400', () => {
    expect(() => resolvePeriodRange('custom', '', NOW)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => resolvePeriodRange('custom', '2026-02-30', NOW)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => resolvePeriodRange('custom', '21/10/2026', NOW)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('an unknown period is a 400', () => {
    expect(() => resolvePeriodRange('year', '', NOW)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

// ── helpers ────────────────────────────────────────────────
function singleChain(data) {
  return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data }) };
}

function rosterChain(rows) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn(function (col, vals) { chain.inCalls.push([col, vals]); return this; }),
    inCalls: [],
    then: (resolve) => resolve({ data: rows }),
  };
  return chain;
}

// A query chain over `rows` that honours .in/.gte/.lte and pages via .range().
function tableChain(rows) {
  const state = { in: null, gte: null, lte: null };
  const chain = {
    calls: [],
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    in: jest.fn(function (col, vals) { state.in = [col, vals]; return this; }),
    gte: jest.fn(function (col, v) { state.gte = [col, v]; return this; }),
    lte: jest.fn(function (col, v) { state.lte = [col, v]; return this; }),
    range: jest.fn((from, to) => {
      chain.calls.push({ ...state, range: [from, to] });
      const filtered = rows.filter(r =>
        (!state.in || state.in[1].includes(r[state.in[0]])) &&
        (!state.gte || r[state.gte[0]] >= state.gte[1]) &&
        (!state.lte || r[state.lte[0]] <= state.lte[1]));
      return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
    }),
  };
  return chain;
}

const ROSTER = [
  { id: 'a', name: 'Aanya', grade: 'Grade 4' },
  { id: 'b', name: 'Bilal', grade: 'Grade 4' },
  { id: 'c', name: 'Chitra', grade: 'Grade 5' },
];
const STATS = [
  { student_id: 'a', xp_points: 900, level: 3, current_streak: 4, completed_topics: ['t1'] },
  { student_id: 'b', xp_points: 200, level: 1, current_streak: 1, completed_topics: [] },
  { student_id: 'c', xp_points: 500, level: 2, current_streak: 0, completed_topics: [] },
];
const LOGS = [
  { student_id: 'a', log_date: '2026-10-20', xp_earned: 500 }, // last month
  { student_id: 'b', log_date: '2026-11-02', xp_earned: 60 },
  { student_id: 'b', log_date: '2026-11-05', xp_earned: 90 },
  { student_id: 'c', log_date: '2026-11-05', xp_earned: 40 },
  { student_id: 'a', log_date: '2026-11-05', xp_earned: 10 },
];

function mockTeacherTables({ teaches = [{ grade: 'Grade 4' }, { grade: 'Grade 5' }], roster = ROSTER } = {}) {
  const tables = {
    roster: rosterChain(roster),
    stats: tableChain(STATS),
    logs: tableChain(LOGS),
  };
  let usersCalls = 0;
  supabase.from.mockImplementation((table) => {
    if (table === 'users') {
      usersCalls++;
      return usersCalls === 1
        ? singleChain({ id: 't1', grade: 'Grade 4', curriculum: 'IB PYP', school: 'Greenwood' })
        : tables.roster;
    }
    if (table === 'user_preferences') return singleChain({ data: { teaches } });
    if (table === 'student_stats') return tables.stats;
    if (table === 'student_daily_log') return tables.logs;
    throw new Error(`unexpected table ${table}`);
  });
  return tables;
}

beforeEach(() => jest.clearAllMocks());

describe('getLeaderboard — period leaderboards (teacher class)', () => {
  test('today ranks by XP earned today, not all-time XP', async () => {
    const t = mockTeacherTables();
    const result = await getLeaderboard({ teacherEmail: 't@x.com', period: 'today', now: NOW });

    expect(result.map(r => [r.rank, r.id, r.score])).toEqual([[1, 'b', 90], [2, 'c', 40], [3, 'a', 10]]);
    expect(t.logs.calls[0]).toMatchObject({ gte: ['log_date', '2026-11-05'], lte: ['log_date', '2026-11-05'] });
  });

  test('week sums every day of the week', async () => {
    mockTeacherTables();
    const result = await getLeaderboard({ teacherEmail: 't@x.com', period: 'week', now: NOW });
    expect(result.map(r => [r.id, r.score])).toEqual([['b', 150], ['c', 40], ['a', 10]]);
  });

  test('a custom day nobody was active on keeps the whole class, all at 0 XP, ordered by all-time XP', async () => {
    mockTeacherTables();
    const result = await getLeaderboard({ teacherEmail: 't@x.com', period: 'custom', date: '2026-10-01', now: NOW });
    expect(result.map(r => [r.rank, r.id, r.score])).toEqual([[1, 'a', 0], [2, 'c', 0], [3, 'b', 0]]);
  });

  test('custom day picks only that day\'s XP', async () => {
    mockTeacherTables();
    const result = await getLeaderboard({ teacherEmail: 't@x.com', period: 'custom', date: '2026-10-20', now: NOW });
    expect(result[0]).toMatchObject({ id: 'a', score: 500, name: 'Aanya', grade: 'Grade 4', level: 3, streak: 4, topics: 1 });
  });

  test('period queries only read the class\'s students', async () => {
    const t = mockTeacherTables();
    await getLeaderboard({ teacherEmail: 't@x.com', period: 'month', now: NOW });
    expect(t.logs.calls[0].in).toEqual(['student_id', ['a', 'b', 'c']]);
    expect(t.stats.calls[0].in).toEqual(['student_id', ['a', 'b', 'c']]);
  });

  test('limit applies after ranking', async () => {
    mockTeacherTables();
    const result = await getLeaderboard({ teacherEmail: 't@x.com', period: 'week', limit: 1, now: NOW });
    expect(result.map(r => r.id)).toEqual(['b']);
  });

  test('daily logs past one page (1000 rows) are all counted', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ student_id: 'b', log_date: '2026-11-05', xp_earned: 1, i }));
    const t = mockTeacherTables();
    t.logs = tableChain(many);
    supabase.from.mockImplementation((table) => {
      if (table === 'student_daily_log') return t.logs;
      if (table === 'student_stats') return t.stats;
      if (table === 'user_preferences') return singleChain(null);
      return table === 'users' && !t.seenTeacher ? (t.seenTeacher = true, singleChain({ grade: 'Grade 4' })) : t.roster;
    });
    const result = await getLeaderboard({ teacherEmail: 't@x.com', period: 'today', now: NOW });
    expect(result.find(r => r.id === 'b').score).toBe(1500);
    expect(t.logs.calls.map(c => c.range)).toEqual([[0, 999], [1000, 1999]]);
  });
});

describe('getLeaderboard — classGrade (teacher grade filter)', () => {
  test('narrows the class roster to the chosen grade', async () => {
    const t = mockTeacherTables();
    await getLeaderboard({ teacherEmail: 't@x.com', classGrade: 'Grade 5', period: 'today', now: NOW });
    expect(t.roster.inCalls).toEqual([['grade', ['Grade 5']]]);
  });

  test('without classGrade the roster covers every grade the teacher teaches', async () => {
    const t = mockTeacherTables();
    await getLeaderboard({ teacherEmail: 't@x.com', period: 'today', now: NOW });
    expect(t.roster.inCalls).toEqual([['grade', ['Grade 4', 'Grade 5']]]);
  });

  test('a grade the teacher does not teach returns nothing (never widens the class)', async () => {
    const t = mockTeacherTables();
    const result = await getLeaderboard({ teacherEmail: 't@x.com', classGrade: 'Grade 9', period: 'today', now: NOW });
    expect(result).toEqual([]);
    expect(t.logs.calls).toEqual([]);
  });
});

describe('getLeaderboard — unscoped period leaderboard', () => {
  test('lists only students who earned XP in the range', async () => {
    const stats = tableChain(STATS);
    const logs = tableChain(LOGS);
    supabase.from.mockImplementation((table) => {
      if (table === 'student_daily_log') return logs;
      if (table === 'student_stats') return stats;
      if (table === 'users') return { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: ROSTER }) };
      throw new Error(table);
    });
    const result = await getLeaderboard({ period: 'custom', date: '2026-11-02', now: NOW });
    expect(result.map(r => [r.id, r.name, r.score])).toEqual([['b', 'Bilal', 60]]);
  });
});
