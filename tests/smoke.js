// Smoke test for the standalone service — proves it runs and answers
// correctly with ZERO dependency on the rest of the ai-mentor app.
//
// Run the service first (npm start), then: node tests/smoke.js

require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:4003';

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

async function main() {
  console.log(`Testing ${BASE_URL}\n`);

  console.log('GET /health');
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  check('responds ok:true', health.ok === true);

  console.log('\nGET /student/leaderboard?limit=5');
  const res = await fetch(`${BASE_URL}/student/leaderboard?limit=5`);
  const body = await res.json();
  check('returns 200', res.status === 200);
  check('returns an array', Array.isArray(body));
  check('honors limit', body.length <= 5);
  if (body.length > 1) {
    check('sorted by score descending', body[0].score >= body[1].score);
    check('rank fields are sequential', body[0].rank === 1 && body[1].rank === 2);
  }

  console.log('\nGET /student/leaderboard?teacherEmail=nonexistent@aivorah.test');
  const teacherRes = await fetch(`${BASE_URL}/student/leaderboard?teacherEmail=nonexistent@aivorah.test`);
  const teacherBody = await teacherRes.json();
  check('returns 200', teacherRes.status === 200);
  check('returns an array (empty for unknown teacher)', Array.isArray(teacherBody));

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
