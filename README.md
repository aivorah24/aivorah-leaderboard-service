# aivorah-leaderboard-service

Leaderboard and student stats (XP, streaks, study time, lesson/topic completion, quiz attempts). Extracted from the `ai-mentor` monolith.

**Called by:** frontend student dashboard, progress and leaderboard screens.

## Endpoints
| Route | What it does |
|---|---|
| `GET /student/leaderboard` | Ranked leaderboard |
| `GET/PUT /student/:id` | Read / update a student's stats |
| `POST /student/:id/complete-lesson, /start-topic, /study-time` | Record learning activity |
| `GET /student/:id/weekly, /performance, /attempts` | Weekly progress, performance, quiz attempts |
| `POST /student/track-attempt` | Record a quiz attempt |
| `GET /health` | Health check |

## Run locally
```bash
npm ci
cp .env.example .env   # fill in values; see table below
npm run dev            # nodemon, port 4003
```

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `4003`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project and service-role key (server-only, never expose) |
| `QDRANT_URL`, `QDRANT_API_KEY` | Qdrant vector DB (curriculum/topic data) |
| `BASE_URL` | Target for `npm run test:smoke` only |

## Tests
```bash
npm test            # jest
npm run test:smoke  # hits a running instance at BASE_URL
```

## Deploy
- **Render** web service `aivorah-leaderboard-service` → https://aivorah-leaderboard-service.onrender.com
- Auto-deploys from `main`. Build `npm install`, start `npm start`.
- CI: `.circleci/config.yml` and `.github/workflows/ci.yml` run the tests (GitHub Actions is billing-blocked on the account)
- After a merge, check the live commit on Render matches the branch head.

## Auth
No token check yet: routes trust the student id in the URL. See the auth audit in `aivorah-handover`.

## Folder layout
| Path | Why it exists |
|---|---|
| `index.js` | Express app: middleware, route mounting, `/health`, listen |
| `routes/` | `leaderboard.js`, `student-stats.js` (HTTP layer only) |
| `services/` | Business logic and clients: leaderboard, student stats, analytics, Supabase, Qdrant |
| `utils/` | `curriculum.js`: curriculum name helpers |
| `tests/` | Jest tests + `smoke.js` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for PR rules.
