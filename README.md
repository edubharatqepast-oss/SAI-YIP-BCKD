# SAI.YIP Backend API

Cloudflare Workers backend for SAI.YIP — Smart Adaptive Learning PWA for KV Adoor students.

## Architecture

```
Frontend (Cloudflare Pages)  →  Workers API  →  Google Sheets (database)
                                              ↳ KV (cache, sessions)
                                              ↳ Workers AI (question generation)
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values
```

### 3. Set secrets
```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
```

### 4. Set up Google Sheets
Create a Google Sheet with these tabs (row 1 = headers):

| Tab | Columns |
|-----|---------|
| Students | id, kvad_id, email, display_name, class, role, created_at, updated_at |
| Sessions | id, student_id, provider, token_hash, sub, email, sheet_ready, created_at, expires_at, revoked_at |
| Answers | id, student_id, challenge_id, correct, answer_given, score, skill, level, time_taken_ms, created_at |
| Skills | id, student_id, skill, level, score, tries, hint_lang, updated_at |
| Points | student_id, total_points, badges, updated_at |
| Quota | id, student_id, quota_date, min_used, limit_minutes, session_started_at, updated_at |
| Games | id, student_id, game_id, score, level, time_spent_ms, played_at |
| Analytics | id, student_id, event, data, created_at |
| Questions | id, skill, level, type, prompt_en, prompt_ml, options, answer, hint_en, hint_ml, explanation_en, explanation_ml, created_at |

### 5. Develop locally
```bash
npm run dev
```

### 6. Deploy
```bash
npm run deploy
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/auth/login` | No | Student login |
| POST | `/api/v1/auth/register` | No | Register new student |
| POST | `/api/v1/auth/logout` | Required | Logout |
| GET | `/api/v1/auth/me` | Required | Get current user |
| GET | `/api/v1/progress` | Required | Get user progress |
| POST | `/api/v1/progress/challenges` | Required | Submit challenge answer |
| GET | `/api/v1/skills` | Required | Get user skills |
| POST | `/api/v1/games/score` | Required | Submit game score |
| GET | `/api/v1/games/leaderboard` | Optional | Get game leaderboard |
| GET | `/api/v1/teacher/class` | Teacher | Get class students |
| GET | `/api/v1/teacher/students/:kvadId/progress` | Teacher | Get student progress |
| GET | `/api/v1/teacher/export` | Teacher | Export class data |
| GET | `/api/v1/quota/playtime` | Required | Get daily play time |
| GET | `/api/v1/quota/exhausted` | Required | Check quota status |
| GET | `/api/v1/questions` | Optional | Get questions by skill/level |
| GET | `/api/v1/health` | No | Health check |

## Security

- All state-changing endpoints require CSRF token
- Auth via HttpOnly cookies
- Rate limiting recommended via Workers KV
- Google Sheets as database backend

## License

MIT
