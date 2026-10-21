// Regression test for Bug #3.1 / #22 (aivorah-frontend BUGS_AND_FIXES.md).
// Same fix and same test cases as ai-mentor/server/tests/student-streak-rollover.test.js
// — kept in sync since this service's getStudentStats() was ported verbatim
// from the monolith's GET /student/:id and had the identical bug.

jest.mock('../../services/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/qdrant', () => ({ client: { scroll: jest.fn() }, resolveCollection: jest.fn() }));
jest.mock('../../services/analytics', () => ({ readEvents: jest.fn() }));

const { computeStreakRollover } = require('../../services/student-stats');

describe('computeStreakRollover', () => {
  test('brand-new account, never active, opened on a later day -> streak stays 0 (not credited to 1)', () => {
    const record = {
      last_active_date: '2026-08-24',
      current_streak: 0,
      today_study_minutes: 0,
      today_xp: 0,
      completed_topics: [],
    };
    expect(computeStreakRollover(record, '2026-08-27').current_streak).toBe(0);
  });

  test('genuinely active yesterday (real study minutes) -> streak continues/increments', () => {
    const record = {
      last_active_date: '2026-08-26',
      current_streak: 3,
      today_study_minutes: 15,
      today_xp: 20,
      completed_topics: ['topic-a'],
    };
    expect(computeStreakRollover(record, '2026-08-27').current_streak).toBe(4);
  });

  test('active yesterday only via completed_topics (no study minutes tracked) -> still counts', () => {
    const record = {
      last_active_date: '2026-08-26',
      current_streak: 1,
      today_study_minutes: 0,
      today_xp: 0,
      completed_topics: ['topic-a', 'topic-b'],
    };
    expect(computeStreakRollover(record, '2026-08-27').current_streak).toBe(2);
  });

  test('skipped a day (no activity for 2+ days) -> streak resets to 0, not credited to 1', () => {
    const record = {
      last_active_date: '2026-08-20',
      current_streak: 5,
      today_study_minutes: 8,
      today_xp: 10,
      completed_topics: ['x'],
    };
    expect(computeStreakRollover(record, '2026-08-27').current_streak).toBe(0);
  });

  test('yesterday recorded but with zero real activity -> streak resets to 0, not credited to 1', () => {
    const record = {
      last_active_date: '2026-08-26',
      current_streak: 0,
      today_study_minutes: 0,
      today_xp: 0,
      completed_topics: [],
    };
    expect(computeStreakRollover(record, '2026-08-27').current_streak).toBe(0);
  });

  test('same calendar day as last_active_date -> no rollover at all (null)', () => {
    const record = { last_active_date: '2026-08-27', current_streak: 2, today_study_minutes: 5, today_xp: 5, completed_topics: [] };
    expect(computeStreakRollover(record, '2026-08-27')).toBeNull();
  });

  test('always resets today_study_minutes/today_xp to 0 and stamps last_active_date on rollover', () => {
    const record = { last_active_date: '2026-08-26', current_streak: 1, today_study_minutes: 30, today_xp: 40, completed_topics: ['a'] };
    const result = computeStreakRollover(record, '2026-08-27');
    expect(result.today_study_minutes).toBe(0);
    expect(result.today_xp).toBe(0);
    expect(result.last_active_date).toBe('2026-08-27');
  });
});
