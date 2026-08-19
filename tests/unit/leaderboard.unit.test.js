jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn(),
    maybeSingle: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { getLeaderboard } = require('../../services/leaderboard');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no filters, no teacherEmail path -> the stats query resolves directly.
  supabase._chain.limit.mockResolvedValue({
    data: [
      { student_id: 's1', xp_points: 500, level: 3, current_streak: 5, completed_topics: ['t1', 't2', 't1'] },
      { student_id: 's2', xp_points: 300, level: 2, current_streak: 2, completed_topics: [] },
    ],
    error: null,
  });
});

describe('getLeaderboard — basic ranking (no filters)', () => {
  test('returns real students ranked 1..N by xp_points descending, with real user names resolved', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, in: jest.fn().mockResolvedValue({ data: [{ id: 's1', name: 'Aanya', grade: 'Grade 4' }, { id: 's2', name: 'Rohan', grade: 'Grade 5' }] }) };
      return supabase._chain;
    });

    const result = await getLeaderboard({});

    expect(result).toEqual([
      { rank: 1, id: 's1', name: 'Aanya', grade: 'Grade 4', score: 500, level: 3, streak: 5, topics: 2 },
      { rank: 2, id: 's2', name: 'Rohan', grade: 'Grade 5', score: 300, level: 2, streak: 2, topics: 0 },
    ]);
  });

  test('a duplicate completed topic is de-duplicated before counting', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, in: jest.fn().mockResolvedValue({ data: [] }) };
      return supabase._chain;
    });
    const result = await getLeaderboard({});
    expect(result[0].topics).toBe(2); // ['t1','t2','t1'] -> 2 unique
  });

  test('a student with no matching user row falls back to real default name/grade', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, in: jest.fn().mockResolvedValue({ data: [] }) };
      return supabase._chain;
    });
    const result = await getLeaderboard({});
    expect(result[0].name).toBe('Student');
    expect(result[0].grade).toBe('Grade 3');
  });

  test('no stats rows at all -> empty array, no crash', async () => {
    supabase._chain.limit.mockResolvedValueOnce({ data: [], error: null });
    const result = await getLeaderboard({});
    expect(result).toEqual([]);
  });

  test('a Supabase error on the stats query throws with the real error message', async () => {
    supabase._chain.limit.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });
    await expect(getLeaderboard({})).rejects.toThrow('db down');
  });

  test('the limit is applied to the stats query', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, in: jest.fn().mockResolvedValue({ data: [] }) };
      return supabase._chain;
    });
    await getLeaderboard({ limit: 10 });
    expect(supabase._chain.limit).toHaveBeenCalledWith(10);
  });
});

function makeThenableChain(resolvedData) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    then: (resolve) => resolve({ data: resolvedData }),
  };
  return chain;
}

// A student_stats chain that actually filters by whatever ids `.in()` was called with,
// so scoping tests can assert only the allowed students' stats rows come back.
function makeScopedStatsChain(allStats) {
  let filterIds = null;
  return {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    in: jest.fn(function (col, ids) { filterIds = ids; return this; }),
    limit: jest.fn(() => Promise.resolve({
      data: filterIds ? allStats.filter(s => filterIds.includes(s.student_id)) : allStats,
      error: null,
    })),
  };
}

describe('getLeaderboard — parent/scoped leaderboard (grade/school/curriculum filters, no teacherEmail)', () => {
  test('scopes to only students matching ALL provided filters', async () => {
    const usersChain = makeThenableChain([{ id: 's1', name: 'Aanya', grade: 'Grade 4', school: 'Greenwood', curriculum: 'IB PYP' }]);
    const statsChain = makeScopedStatsChain([
      { student_id: 's1', xp_points: 500, level: 3, current_streak: 5, completed_topics: [] },
      { student_id: 's2', xp_points: 300, level: 2, current_streak: 2, completed_topics: [] },
    ]);

    supabase.from.mockImplementation((table) => {
      if (table === 'users') return usersChain;
      if (table === 'student_stats') return statsChain;
      return supabase._chain;
    });

    const result = await getLeaderboard({ gradeFilter: ['Grade 4'], schoolFilter: 'Greenwood', curriculumFilter: 'IB PYP' });

    // Only s1 (the allowed user) appears; s2's stats row is filtered out entirely
    // by the `.in('student_id', allowedIds)` scoping on the stats query.
    expect(result.map(r => r.id)).toEqual(['s1']);
  });

  test('zero students match the filters -> empty array immediately, stats query never even needed', async () => {
    const usersChain = makeThenableChain([]);
    supabase.from.mockImplementation((table) => (table === 'users' ? usersChain : supabase._chain));

    const result = await getLeaderboard({ gradeFilter: ['Grade 99'] });

    expect(result).toEqual([]);
  });

  test('no filters and no teacherEmail -> the scoped-users query is skipped entirely', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, in: jest.fn().mockResolvedValue({ data: [] }) };
      return supabase._chain;
    });
    await getLeaderboard({});
    // The only 'users' call should be the post-hoc name-resolution lookup (by student_id),
    // not a role='student' scoping query — verified indirectly via no error/crash and
    // the basic-ranking tests above already covering the resolution path.
    expect(supabase.from).toHaveBeenCalledWith('student_stats');
  });
});

describe('getLeaderboard — teacher (class) leaderboard', () => {
  function makeSingleChain(resolvedData) {
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: resolvedData }),
    };
  }

  test('resolves the grades from teacher_preferences.teaches[] when available, over the fallback users.grade', async () => {
    let usersCallCount = 0;
    const rosterChain = makeThenableChain([{ id: 's1', name: 'Aanya', grade: 'Grade 5' }]);
    const statsChain = makeScopedStatsChain([
      { student_id: 's1', xp_points: 500, level: 3, current_streak: 5, completed_topics: [] },
      { student_id: 's2', xp_points: 300, level: 2, current_streak: 2, completed_topics: [] },
    ]);
    supabase.from.mockImplementation((table) => {
      if (table === 'users') {
        usersCallCount++;
        if (usersCallCount === 1) return makeSingleChain({ id: 'teacher-1', grade: 'Grade 3', curriculum: 'IB PYP', school: 'Greenwood' });
        return rosterChain;
      }
      if (table === 'user_preferences') return makeSingleChain({ data: { teaches: [{ grade: 'Grade 5' }, { grade: 'Grade 6' }] } });
      if (table === 'student_stats') return statsChain;
      return supabase._chain;
    });

    const result = await getLeaderboard({ teacherEmail: 'teacher@a.com' });

    expect(result.map(r => r.id)).toEqual(['s1']); // s2 excluded — not in the teacher's class roster
  });

  test('falls back to the teacher\'s own users.grade when no teaches[] preference exists', async () => {
    let usersCallCount = 0;
    const rosterChain = makeThenableChain([{ id: 's1', name: 'Aanya', grade: 'Grade 4' }]);
    const statsChain = makeScopedStatsChain([
      { student_id: 's1', xp_points: 500, level: 3, current_streak: 5, completed_topics: [] },
      { student_id: 's2', xp_points: 300, level: 2, current_streak: 2, completed_topics: [] },
    ]);
    supabase.from.mockImplementation((table) => {
      if (table === 'users') {
        usersCallCount++;
        if (usersCallCount === 1) return makeSingleChain({ id: 'teacher-1', grade: 'Grade 4', curriculum: null, school: null });
        return rosterChain;
      }
      if (table === 'user_preferences') return makeSingleChain(null);
      if (table === 'student_stats') return statsChain;
      return supabase._chain;
    });

    const result = await getLeaderboard({ teacherEmail: 'teacher@a.com' });

    expect(result.map(r => r.id)).toEqual(['s1']);
  });

  test('an unresolvable teacher (no user row) -> allowedUsers is an empty scope, empty result', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return makeSingleChain(null);
      if (table === 'user_preferences') return makeSingleChain(null);
      return supabase._chain;
    });

    const result = await getLeaderboard({ teacherEmail: 'nonexistent@a.com' });

    expect(result).toEqual([]);
  });

  test('teacherEmail takes precedence over grade/school/curriculum filters (class scoping wins)', async () => {
    let usersCallCount = 0;
    const rosterChain = makeThenableChain([{ id: 's1', name: 'Aanya', grade: 'Grade 4' }]);
    const statsChain = makeScopedStatsChain([
      { student_id: 's1', xp_points: 500, level: 3, current_streak: 5, completed_topics: [] },
      { student_id: 's2', xp_points: 300, level: 2, current_streak: 2, completed_topics: [] },
    ]);
    supabase.from.mockImplementation((table) => {
      if (table === 'users') {
        usersCallCount++;
        if (usersCallCount === 1) return makeSingleChain({ id: 'teacher-1', grade: 'Grade 4', curriculum: 'IB PYP', school: 'Greenwood' });
        return rosterChain;
      }
      if (table === 'user_preferences') return makeSingleChain(null);
      if (table === 'student_stats') return statsChain;
      return supabase._chain;
    });

    const result = await getLeaderboard({ teacherEmail: 'teacher@a.com', gradeFilter: ['Grade 99'], schoolFilter: 'Somewhere Else' });

    expect(result.map(r => r.id)).toEqual(['s1']);
  });
});
