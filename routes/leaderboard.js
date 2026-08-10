const express = require('express');
const router  = express.Router();
const { getLeaderboard } = require('../services/leaderboard');

// GET /student/leaderboard?limit=10&teacherEmail=xxx
// Returns top students ranked by XP from student_stats + users tables.
// When teacherEmail is supplied, it becomes a *class* leaderboard scoped to
// that teacher: only their linked students, in the same school + curriculum
// and the grade(s) the teacher actually teaches.
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const teacherEmail = String(req.query.teacherEmail || '').toLowerCase().trim();
    const gradeFilter = String(req.query.grade || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const schoolFilter = String(req.query.school || '').trim();
    const curriculumFilter = String(req.query.curriculum || '').trim();

    const leaderboard = await getLeaderboard({
      limit,
      teacherEmail,
      gradeFilter,
      schoolFilter,
      curriculumFilter
    });

    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
