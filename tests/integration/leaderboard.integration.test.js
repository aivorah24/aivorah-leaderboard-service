const request = require('supertest');

jest.mock('../../services/leaderboard', () => ({
  getLeaderboard: jest.fn(),
}));

const { getLeaderboard } = require('../../services/leaderboard');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  getLeaderboard.mockResolvedValue([]);
});

describe('GET /health', () => {
  test('reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'aivorah-leaderboard-service' });
  });
});

describe('GET /student/leaderboard', () => {
  test('defaults limit to 50 when not provided', async () => {
    await request(app).get('/student/leaderboard');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  test('honors an explicit limit under the cap', async () => {
    await request(app).get('/student/leaderboard?limit=10');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  test('caps limit at 500 even when a larger value is requested', async () => {
    await request(app).get('/student/leaderboard?limit=9999');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });

  test('a non-numeric limit falls back to the default of 50', async () => {
    await request(app).get('/student/leaderboard?limit=abc');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  test('lowercases and trims teacherEmail', async () => {
    await request(app).get('/student/leaderboard?teacherEmail=%20Teacher%40A.com%20');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ teacherEmail: 'teacher@a.com' }));
  });

  test('splits a comma-separated grade param into gradeFilter, trimming each entry', async () => {
    await request(app).get('/student/leaderboard?grade=Grade%204%2C%20Grade%205');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ gradeFilter: ['Grade 4', 'Grade 5'] }));
  });

  test('a single grade value produces a single-element gradeFilter', async () => {
    await request(app).get('/student/leaderboard?grade=Grade%204');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ gradeFilter: ['Grade 4'] }));
  });

  test('no grade param produces an empty gradeFilter', async () => {
    await request(app).get('/student/leaderboard');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ gradeFilter: [] }));
  });

  test('passes through school and curriculum filters', async () => {
    await request(app).get('/student/leaderboard?school=Greenwood&curriculum=IB%20PYP');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ schoolFilter: 'Greenwood', curriculumFilter: 'IB PYP' }));
  });

  test('returns the real leaderboard array the service resolves', async () => {
    getLeaderboard.mockResolvedValue([
      { rank: 1, id: 's1', name: 'Aanya', grade: 'Grade 4', score: 500, level: 3, streak: 5, topics: 2 },
    ]);
    const res = await request(app).get('/student/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { rank: 1, id: 's1', name: 'Aanya', grade: 'Grade 4', score: 500, level: 3, streak: 5, topics: 2 },
    ]);
  });

  test('a service error maps to a 500 with the real error message', async () => {
    getLeaderboard.mockRejectedValue(new Error('db unreachable'));
    const res = await request(app).get('/student/leaderboard');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'db unreachable' });
  });
});
