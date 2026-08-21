// Standalone leaderboard microservice — extracted from ai-mentor/server/routes/student.js.
// Serves GET /student/leaderboard on its own port.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const leaderboardRoute = require('./routes/leaderboard');
const studentStatsRoute = require('./routes/student-stats');

const app = express();
app.use(cors());
app.use(express.json());

// leaderboard MUST mount before student-stats — its literal '/leaderboard'
// path would otherwise be swallowed by student-stats' '/:id' wildcard.
app.use('/student', leaderboardRoute);
app.use('/student', studentStatsRoute);

app.get('/health', (req, res) => res.json({ ok: true, service: 'aivorah-leaderboard-service' }));

const PORT = process.env.PORT || 4003;
if (require.main === module) {
  app.listen(PORT, () => console.log(`[aivorah-leaderboard-service] listening on port ${PORT}`));
}

module.exports = app;
