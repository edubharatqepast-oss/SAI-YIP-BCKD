-- ============================================
-- SAI.YIP Backend — D1 Schema Migration 0001
-- ============================================

-- Enable strict typing (Cloudflare D1 recommendation)
PRAGMA strict_tables = ON;

-- 1. Students (core identity)
CREATE TABLE IF NOT EXISTS students (
    id              TEXT PRIMARY KEY,
    kvad_id         TEXT NOT NULL UNIQUE CHECK (kvad_id GLOB 'KVAD-[0-9][0-9][0-9]'),
    email           TEXT,
    display_name    TEXT,
    lang            TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ml','hi','ta')),
    class           INTEGER CHECK (class BETWEEN 6 AND 10),
    school          TEXT NOT NULL DEFAULT 'KV Adoor',
    role            TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','teacher','admin')),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_students_email   ON students(email);
CREATE INDEX IF NOT EXISTS idx_students_kvad    ON students(kvad_id);
CREATE INDEX IF NOT EXISTS idx_students_role    ON students(role);

-- 2. Sessions (auth — token_hash never raw token)
CREATE TABLE IF NOT EXISTS student_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL CHECK (provider IN ('demo','google','none')),
    token_hash      TEXT,              -- hashed token, never plaintext
    sub             TEXT,              -- Google subject ID
    email           TEXT,
    sheet_ready     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at      INTEGER,
    revoked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_student   ON student_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token     ON student_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked   ON student_sessions(revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON student_sessions(expires_at);

-- 3. Challenge answers (one row per challenge attempt)
CREATE TABLE IF NOT EXISTS student_answers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    challenge_id    TEXT NOT NULL,
    correct         INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0,1)),
    answer_given    TEXT,
    score           INTEGER NOT NULL DEFAULT 0,
    skill           TEXT NOT NULL CHECK (skill IN ('Reasoning','Observation','Logic','Coding','Problem Solving')),
    level           INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
    time_taken_ms   INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(student_id, challenge_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_student    ON student_answers(student_id);
CREATE INDEX IF NOT EXISTS idx_answers_challenge  ON student_answers(challenge_id);
CREATE INDEX IF NOT EXISTS idx_answers_created    ON student_answers(created_at);

-- 4. Skills progression (current state per skill)
CREATE TABLE IF NOT EXISTS student_skills (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    skill           TEXT NOT NULL CHECK (skill IN ('Reasoning','Observation','Logic','Coding','Problem Solving')),
    level           INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
    score           INTEGER NOT NULL DEFAULT 0,
    tries           INTEGER NOT NULL DEFAULT 0,
    hint_lang       TEXT NOT NULL DEFAULT 'en' CHECK (hint_lang IN ('en','ml')),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(student_id, skill)
);
CREATE INDEX IF NOT EXISTS idx_skills_student ON student_skills(student_id);

-- 5. Skill history (last N scores per skill — supports streak & adaptation)
CREATE TABLE IF NOT EXISTS student_skill_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_skill_id INTEGER NOT NULL REFERENCES student_skills(id) ON DELETE CASCADE,
    score           INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_history_skill ON student_skill_history(student_skill_id);

-- 6. Points + badges aggregate
CREATE TABLE IF NOT EXISTS student_points (
    student_id      TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    total_points    INTEGER NOT NULL DEFAULT 0,
    badges          TEXT NOT NULL DEFAULT '[]',   -- JSON array of badge keys
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 7. Daily play quota (server-enforced)
CREATE TABLE IF NOT EXISTS student_quota (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    quota_date      TEXT NOT NULL,                    -- YYYY-MM-DD
    min_used        INTEGER NOT NULL DEFAULT 0,
    limit_minutes   INTEGER NOT NULL DEFAULT 60,
    session_started_at TEXT,                           -- ISO timestamp when daily session started
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(student_id, quota_date)
);
CREATE INDEX IF NOT EXISTS idx_quota_student_date ON student_quota(student_id, quota_date);
CREATE INDEX IF NOT EXISTS idx_quota_date         ON student_quota(quota_date);

-- 8. Game scores
CREATE TABLE IF NOT EXISTS game_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    game_id         TEXT NOT NULL,
    score           INTEGER NOT NULL DEFAULT 0,
    level           INTEGER NOT NULL DEFAULT 1,
    time_spent_ms   INTEGER,
    played_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(student_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_game_scores_student ON game_scores(student_id);
CREATE INDEX IF NOT EXISTS idx_game_scores_game    ON game_scores(game_id);
CREATE INDEX IF NOT EXISTS idx_game_scores_score   ON game_scores(score DESC);

-- 9. Analytics events (batch-uploaded, optional)
CREATE TABLE IF NOT EXISTS analytics_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT REFERENCES students(id) ON DELETE SET NULL,
    event           TEXT NOT NULL,
    data            TEXT NOT NULL DEFAULT '{}',   -- JSON payload
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_analytics_student ON analytics_events(student_id);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_event   ON analytics_events(event);

-- 10. Questions (cached from challenges.json / generated by Workers AI)
CREATE TABLE IF NOT EXISTS questions (
    id              TEXT PRIMARY KEY,
    skill           TEXT NOT NULL CHECK (skill IN ('Reasoning','Observation','Logic','Coding','Problem Solving')),
    level           INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
    type            TEXT NOT NULL CHECK (type IN ('mcq','input')),
    prompt_en       TEXT NOT NULL,
    prompt_ml       TEXT NOT NULL,
    options         TEXT,           -- JSON array for mcq, null for input
    answer          TEXT NOT NULL,
    hint_en         TEXT,
    hint_ml         TEXT,
    explanation_en  TEXT,
    explanation_ml  TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_questions_skill_level ON questions(skill, level);

-- ============================================
-- End of migration 0001
-- ============================================
