const request = require('supertest');

jest.mock('../../services/leaderboard', () => ({
  getLeaderboard: jest.fn(),
}));

// index.js now also mounts routes/student-stats.js, which otherwise pulls in
// the real services/supabase.js (and a real createClient() call) at module
// load time — mocked here the same way leaderboard is, since this suite only
// exercises the leaderboard route.
jest.mock('../../services/student-stats', () => ({
  getStudentStats: jest.fn(),
  updateStudentStats: jest.fn(),
  completeLesson: jest.fn(),
  recordStudyTime: jest.fn(),
}));

const { getLeaderboard } = require('../../services/leaderboard');
const { getStudentStats, updateStudentStats, completeLesson, recordStudyTime } = require('../../services/student-stats');
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

  test('defaults to the all-time period with no custom date or class grade', async () => {
    await request(app).get('/student/leaderboard');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ period: 'all', date: '', classGrade: '' }));
  });

  test('passes period, date and classGrade through', async () => {
    await request(app).get('/student/leaderboard?teacherEmail=t%40a.com&period=Custom&date=2026-11-02&classGrade=Grade%204');
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({
      teacherEmail: 't@a.com', period: 'custom', date: '2026-11-02', classGrade: 'Grade 4',
    }));
  });

  test('a bad period/date comes back as a 400, not a 500', async () => {
    getLeaderboard.mockRejectedValueOnce(Object.assign(new Error('period=custom needs date=YYYY-MM-DD'), { status: 400 }));
    const res = await request(app).get('/student/leaderboard?period=custom');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date=YYYY-MM-DD/);
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

  // /student/leaderboard must never be swallowed by student-stats' /:id wildcard.
  test('a real /student/leaderboard request never reaches getStudentStats', async () => {
    await request(app).get('/student/leaderboard');
    expect(getStudentStats).not.toHaveBeenCalled();
  });
});

describe('GET /student/:id', () => {
  test('returns the real stats object the service resolves', async () => {
    getStudentStats.mockResolvedValue({ studentId: 's1', xpPoints: 200 });
    const res = await request(app).get('/student/s1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ studentId: 's1', xpPoints: 200 });
    expect(getStudentStats).toHaveBeenCalledWith('s1');
  });
});

describe('PUT /student/:id', () => {
  test('forwards the real body to updateStudentStats', async () => {
    updateStudentStats.mockResolvedValue({ studentId: 's1', xpPoints: 500 });
    const res = await request(app).put('/student/s1').send({ xpPoints: 500 });
    expect(res.status).toBe(200);
    expect(updateStudentStats).toHaveBeenCalledWith('s1', { xpPoints: 500 });
  });
});

describe('POST /student/:id/complete-lesson', () => {
  test('a real missing-topic 400 from the service is passed through', async () => {
    const err = new Error('topic required'); err.status = 400;
    completeLesson.mockRejectedValue(err);
    const res = await request(app).post('/student/s1/complete-lesson').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /student/:id/study-time', () => {
  test('forwards the real body to recordStudyTime', async () => {
    recordStudyTime.mockResolvedValue({ studyTimeMinutes: 60 });
    const res = await request(app).post('/student/s1/study-time').send({ minutes: 10 });
    expect(res.status).toBe(200);
    expect(recordStudyTime).toHaveBeenCalledWith('s1', { minutes: 10 });
  });
});
