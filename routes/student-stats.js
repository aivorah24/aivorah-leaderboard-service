const express = require('express');
const router  = express.Router();
const studentStats = require('../services/student-stats');

router.get('/:id', async (req, res) => {
  try {
    const stats = await studentStats.getStudentStats(req.params.id);
    res.json(stats);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const stats = await studentStats.updateStudentStats(req.params.id, req.body ?? {});
    res.json(stats);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:id/complete-lesson', async (req, res) => {
  try {
    const stats = await studentStats.completeLesson(req.params.id, req.body ?? {});
    res.json(stats);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:id/study-time', async (req, res) => {
  try {
    const result = await studentStats.recordStudyTime(req.params.id, req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:id/weekly', async (req, res) => {
  try {
    const result = await studentStats.getWeeklyActivity(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:id/performance', async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email) : '';
    const result = await studentStats.getStudentPerformance(email);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/track-attempt', async (req, res) => {
  try {
    const result = await studentStats.trackAttempt(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
