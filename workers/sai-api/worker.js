/**
 * SAI.YIP Backend API — Cloudflare Workers + Google Sheets
 * 
 * Endpoints:
 *   POST   /api/v1/auth/login
 *   POST   /api/v1/auth/register
 *   POST   /api/v1/auth/logout
 *   GET    /api/v1/auth/me
 *   GET    /api/v1/progress
 *   POST   /api/v1/progress/challenges
 *   GET    /api/v1/skills
 *   POST   /api/v1/games/score
 *   GET    /api/v1/games/leaderboard
 *   GET    /api/v1/teacher/class
 *   GET    /api/v1/teacher/students/:kvadId/progress
 *   GET    /api/v1/teacher/export
 *   GET    /api/v1/quota/playtime
 *   GET    /api/v1/quota/exhausted
 *   GET    /api/v1/questions
 *   GET    /api/v1/health
 */

const SKILLS = ["Reasoning","Observation","Logic","Coding","Problem Solving"];
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// Sheet tab names
const SHEET_STUDENTS = "Students";
const SHEET_SESSIONS = "Sessions";
const SHEET_ANSWERS = "Answers";
const SHEET_SKILLS = "Skills";
const SHEET_POINTS = "Points";
const SHEET_QUOTA = "Quota";
const SHEET_GAMES = "Games";
const SHEET_ANALYTICS = "Analytics";
const SHEET_QUESTIONS = "Questions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": CORS_ORIGIN(env) || "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-csrf-token",
    "access-control-max-age": "86400",
    ...extra,
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(extraHeaders) },
  });
}

function err(message, status = 500, code = "internal_error") {
  return json({ ok: false, error: code, message }, status);
}

function needToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function setCookieHeader(name, value, options = {}) {
  const parts = [`${name}=${value}`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Strict`];
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
}

function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// ---------------------------------------------------------------------------
// Google Sheets Helpers
// ---------------------------------------------------------------------------

async function sheetsGet(env, sheetName) {
  const sheetId = env.SHEET_ID;
  if (!sheetId) return null;
  try {
    const res = await fetch(`${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetName)}`, {
      headers: { Authorization: "Bearer " + env.SHEET_ACCESS_TOKEN },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const values = data.values || [];
    if (values.length < 2) return [];
    const headers = values[0];
    return values.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i] || "");
      return obj;
    });
  } catch (e) {
    console.error("sheetsGet error:", e);
    return null;
  }
}

async function sheetsAppend(env, sheetName, rows) {
  const sheetId = env.SHEET_ID;
  if (!sheetId) return null;
  try {
    const values = rows.map(r => headers.map(h => r[h] || ""));
    const res = await fetch(`${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.SHEET_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    console.error("sheetsAppend error:", e);
    return null;
  }
}

async function sheetsUpdate(env, sheetName, rowIndex, values) {
  const sheetId = env.SHEET_ID;
  if (!sheetId) return null;
  try {
    const res = await fetch(`${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetName)}!A${rowIndex + 2}:${String.fromCharCode(65 + values.length - 1)}${rowIndex + 2}?valueInputOption=RAW`, {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + env.SHEET_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [values] }),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    console.error("sheetsUpdate error:", e);
    return null;
  }
}

// Header cache to avoid refetching headers every time
let headerCache = null;
let headerCacheTime = 0;

async function getSheetHeaders(env, sheetName) {
  const now = Date.now();
  if (headerCache && headerCache[sheetName] && now - headerCacheTime < 300000) {
    return headerCache[sheetName];
  }
  const data = await sheetsGet(env, sheetName);
  if (!data || data.length === 0) return [];
  const headers = Object.keys(data[0]);
  if (!headerCache) headerCache = {};
  headerCache[sheetName] = headers;
  headerCacheTime = now;
  return headers;
}

// ---------------------------------------------------------------------------
// JWT Helpers
// ---------------------------------------------------------------------------

async function signJwt(env, payload) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = btoa(JSON.stringify(payload));
  const signingInput = header + "." + payloadB64;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signingInput + "." + sigB64;
}

async function verifyJwt(env, token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    // Verify signature
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET(env)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signingInput = parts[0] + "." + parts[1];
    const sigB64 = parts[2];
    const sigBytes = new Uint8Array(atob(sigB64).split("").map(c => c.charCodeAt(0)));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(signingInput));
    if (!valid) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getUser(env, token) {
  const payload = await verifyJwt(env, token);
  if (!payload) return null;
  // Look up user in Sheets
  const students = await sheetsGet(env, SHEET_STUDENTS);
  if (!students) return null;
  return students.find(s => s.id === payload.sub || s.kvadId === payload.sub);
}

async function verifyCsrf(request, env) {
  const csrfHeader = request.headers.get("x-csrf-token") || "";
  const csrfCookie = request.headers.get("cookie") || "";
  const cookieMatch = csrfCookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  const cookieCsrf = cookieMatch ? cookieMatch[1] : "";
  return csrfHeader && csrfHeader === cookieCsrf;
}

// ---------------------------------------------------------------------------
// Auth Handlers
// ---------------------------------------------------------------------------

async function handleLogin(request, env) {
  try {
    const body = await request.json();
  } catch { return err("bad_json", 400); }

  const { kvadId, password } = body;
  if (!kvadId || !password) return err("missing_fields", 400);

  const students = await sheetsGet(env, SHEET_STUDENTS);
  if (!students) return err("db_error", 500);

  const user = students.find(s => s.kvad_id === kvadId);
  if (!user) return err("invalid_credentials", 401);

  // In production, verify password hash here
  const token = await signJwt(env, { sub: user.id, kvadId: user.kvad_id, role: user.role, exp: Math.floor(Date.now() / 1000) + 86400 });
  const csrf = crypto.randomUUID();

  // Store session in Sheets
  await sheetsAppend(env, SHEET_SESSIONS, [{
    id: crypto.randomUUID(),
    student_id: user.id,
    provider: "demo",
    token_hash: await hashString(token),
    sub: user.id,
    email: user.email || "",
    sheet_ready: "false",
    created_at: Date.now(),
    expires_at: Date.now() + 86400000,
    revoked_at: "",
  }]);

  return json({
    ok: true,
    user: { id: user.id, kvadId: user.kvad_id, role: user.role, class: user.class, name: user.display_name },
  }, 200, {
    "set-cookie": setCookieHeader("token", token, { maxAge: 86400 }),
    "set-cookie-2": setCookieHeader("csrf", csrf, { maxAge: 86400 }),
  });
}

async function handleRegister(request, env) {
  try {
    const body = await request.json();
  } catch { return err("bad_json", 400); }

  const { kvadId, password, name, class: cls, role, parentEmail } = body;
  if (!kvadId || !password || !name) return err("missing_fields", 400);

  const students = await sheetsGet(env, SHEET_STUDENTS);
  if (students && students.find(s => s.kvad_id === kvadId)) return err("kvad_id_exists", 409);

  const id = crypto.randomUUID();
  await sheetsAppend(env, SHEET_STUDENTS, [{
    id,
    kvad_id: kvadId,
    email: parentEmail || "",
    display_name: name,
    class: cls || "6",
    role: role || "student",
    created_at: Date.now(),
    updated_at: Date.now(),
  }]);

  return json({ ok: true, user: { id, kvadId, role: role || "student", class: cls, name } }, 201);
}

async function handleLogout(request, env) {
  const token = needToken(request);
  if (token) {
    // Mark session as revoked
    const students = await sheetsGet(env, SHEET_STUDENTS);
    const sessions = await sheetsGet(env, SHEET_SESSIONS);
    if (sessions) {
      const tokenHash = await hashString(token);
      const session = sessions.find(s => s.token_hash === tokenHash);
      if (session) {
        // In a real impl, we'd update the row; for now just leave it
      }
    }
  }
  return json({ ok: true, message: "Logged out" }, 200, {
    "set-cookie": clearCookieHeader("token"),
    "set-cookie-2": clearCookieHeader("csrf"),
  });
}

async function handleMe(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user) return err("unauthorized", 401);
  return json({ ok: true, user: { id: user.id, kvadId: user.kvad_id, role: user.role, class: user.class, name: user.display_name } });
}

// ---------------------------------------------------------------------------
// Progress Handlers
// ---------------------------------------------------------------------------

async function handleGetProgress(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user) return err("unauthorized", 401);

  const answers = await sheetsGet(env, SHEET_ANSWERS) || [];
  const skills = await sheetsGet(env, SHEET_SKILLS) || [];
  const points = await sheetsGet(env, SHEET_POINTS) || [];

  const userAnswers = answers.filter(a => a.student_id === user.id);
  const userSkills = skills.filter(s => s.student_id === user.id);
  const userPoints = points.find(p => p.student_id === user.id);

  return json({
    ok: true,
    progress: {
      userId: user.id,
      kvadId: user.kvad_id,
      totalPoints: userPoints ? Number(userPoints.total_points) : 0,
      badges: userPoints ? JSON.parse(userPoints.badges || "[]") : [],
      challengesSolved: userAnswers.filter(a => a.correct === "true").length,
      totalChallenges: userAnswers.length,
      skills: userSkills.map(s => ({
        skill: s.skill,
        level: Number(s.level),
        score: Number(s.score),
        tries: Number(s.tries),
        hintLang: s.hint_lang,
      })),
      lastActivity: userPoints ? userPoints.updated_at : null,
    },
  });
}

async function handleSubmitChallenge(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user) return err("unauthorized", 401);
  if (user.role !== "student") return err("not_student", 403);

  let body;
  try { body = await request.json(); } catch { return err("bad_json", 400); }

  const { challengeId, skill, level, answerGiven, correct, timeTakenSeconds, usedHint, answeredAt } = body;
  if (!challengeId || skill === undefined || correct === undefined) return err("missing_fields", 400);

  // Verify answer against questions sheet
  const questions = await sheetsGet(env, SHEET_QUESTIONS) || [];
  const question = questions.find(q => q.id === challengeId);
  if (!question) return err("challenge_not_found", 404);

  const isCorrect = String(answerGiven).trim().toLowerCase() === String(question.answer).trim().toLowerCase();
  const pointsAwarded = isCorrect ? Number(level) * 10 : 0;

  // Save answer
  try {
    await sheetsAppend(env, SHEET_ANSWERS, [{
      id: crypto.randomUUID(),
      student_id: user.id,
      challenge_id: challengeId,
      correct: isCorrect ? "1" : "0",
      answer_given: answerGiven || "",
      score: pointsAwarded,
      skill,
      level: level || "1",
      time_taken_ms: timeTakenSeconds ? timeTakenSeconds * 1000 : "",
      created_at: Date.now(),
    }]);
  } catch (e) {
    console.error("submit_challenge failed:", e);
    return err("db_error", 500);
  }

  // Update skill
  const skills = await sheetsGet(env, SHEET_SKILLS) || [];
  const existingSkill = skills.find(s => s.student_id === user.id && s.skill === skill);
  const newLevel = existingSkill ? Number(existingSkill.level) : 1;
  const newScore = (existingSkill ? Number(existingSkill.score) : 0) + pointsAwarded;
  const newTries = (existingSkill ? Number(existingSkill.tries) : 0) + 1;

  try {
    if (existingSkill) {
      await sheetsUpdate(env, SHEET_SKILLS, skills.indexOf(existingSkill), [
        existingSkill.id, user.id, skill, newLevel, newScore, newTries, "en", Date.now(),
      ]);
    } else {
      await sheetsAppend(env, SHEET_SKILLS, [{
        id: crypto.randomUUID(),
        student_id: user.id,
        skill,
        level: newLevel,
        score: newScore,
        tries: newTries,
        hint_lang: "en",
        updated_at: Date.now(),
      }]);
    }
  } catch (e) {
    console.error("update_skill failed:", e);
    return err("db_error", 500);
  }

  // Update points
  try {
    const points = await sheetsGet(env, SHEET_POINTS) || [];
    const existingPoint = points.find(p => p.student_id === user.id);
    if (existingPoint) {
      const newTotal = Number(existingPoint.total_points) + pointsAwarded;
      await sheetsUpdate(env, SHEET_POINTS, points.indexOf(existingPoint), [
        existingPoint.id, user.id, newTotal, existingPoint.badges || "[]", Date.now(),
      ]);
    } else {
      await sheetsAppend(env, SHEET_POINTS, [{
        id: crypto.randomUUID(),
        student_id: user.id,
        total_points: pointsAwarded,
        badges: "[]",
        updated_at: Date.now(),
      }]);
    }
  } catch (e) {
    console.error("update_points failed:", e);
  }

  return json({
    ok: true,
    result: {
      challengeId,
      correct: isCorrect,
      pointsAwarded,
      newLevel,
      newScore,
      streak: newTries,
    },
  });
}

// ---------------------------------------------------------------------------
// Games Handlers
// ---------------------------------------------------------------------------

async function handleSubmitGameScore(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user) return err("unauthorized", 401);
  if (user.role !== "student") return err("not_student", 403);

  let body;
  try { body = await request.json(); } catch { return err("bad_json", 400); }

  const { gameId, score, level, timeSpentSeconds } = body;
  if (!gameId || score === undefined) return err("missing_fields", 400);

  try {
    const games = await sheetsGet(env, SHEET_GAMES) || [];
    const existing = games.find(g => g.student_id === user.id && g.game_id === gameId);
    if (existing && Number(existing.score) >= score) {
      return json({ ok: true, result: { gameId, score: existing.score, personalBest: false, pointsAwarded: 0 } });
    }

    if (existing) {
      await sheetsUpdate(env, SHEET_GAMES, games.indexOf(existing), [
        existing.id, user.id, gameId, score, level || "1", timeSpentSeconds ? timeSpentSeconds * 1000 : "", Date.now(),
      ]);
    } else {
      await sheetsAppend(env, SHEET_GAMES, [{
        id: crypto.randomUUID(),
        student_id: user.id,
        game_id: gameId,
        score,
        level: level || "1",
        time_spent_ms: timeSpentSeconds ? timeSpentSeconds * 1000 : "",
        played_at: Date.now(),
      }]);
    }
  } catch (e) {
    console.error("submit_game_score failed:", e);
    return err("db_error", 500);
  }

  return json({ ok: true, result: { gameId, score, personalBest: true, pointsAwarded: Math.floor(score / 10) } });
}

async function handleGetLeaderboard(request, env) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId") || "2048";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);

  const games = await sheetsGet(env, SHEET_GAMES) || [];
  const students = await sheetsGet(env, SHEET_STUDENTS) || [];

  const gameScores = games.filter(g => g.game_id === gameId)
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, limit);

  const leaderboard = gameScores.map((g, i) => {
    const student = students.find(s => s.id === g.student_id);
    return {
      rank: i + 1,
      kvadId: student ? student.kvad_id : g.student_id,
      name: student ? student.display_name : "Unknown",
      class: student ? student.class : "",
      score: Number(g.score),
      gameId
    };
  });

  // User rank
  const token = needToken(request);
  let userRank = null, userScore = null;
  if (token) {
    const u = await getUser(env, token);
    if (u) {
      const allScores = games.filter(g => g.game_id === gameId)
        .sort((a, b) => Number(b.score) - Number(a.score));
      const myScore = allScores.find(g => g.student_id === u.id);
      userScore = myScore ? Number(myScore.score) : null;
      userRank = allScores.findIndex(g => g.student_id === u.id) + 1 || null;
    }
  }

  return json({
    ok: true,
    leaderboard,
    totalEntries: leaderboard.length,
    userRank,
    userScore,
  });
}

// ---------------------------------------------------------------------------
// Teacher Handlers
// ---------------------------------------------------------------------------

async function handleGetTeacherClass(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user || user.role !== "teacher") return err("teacher_only", 403);

  const url = new URL(request.url);
  const classFilter = url.searchParams.get("class");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const students = await sheetsGet(env, SHEET_STUDENTS) || [];
  const filtered = students.filter(s => s.role === "student" && (!classFilter || s.class === classFilter))
    .slice(0, limit)
    .map(s => ({ kvadId: s.kvad_id, name: s.display_name, class: s.class }));

  return json({
    ok: true,
    class: {
      classId: classFilter || "all",
      teacherId: user.id,
      students: filtered,
      totalStudents: filtered.length,
    },
  });
}

async function handleGetTeacherStudentProgress(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user || user.role !== "teacher") return err("teacher_only", 403);

  const kvadId = request.url.pathname.split("/").pop();
  const students = await sheetsGet(env, SHEET_STUDENTS) || [];
  const student = students.find(s => s.kvad_id === kvadId);
  if (!student) return err("student_not_found", 404);

  const answers = await sheetsGet(env, SHEET_ANSWERS) || [];
  const skills = await sheetsGet(env, SHEET_SKILLS) || [];
  const points = await sheetsGet(env, SHEET_POINTS) || [];

  const userAnswers = answers.filter(a => a.student_id === student.id);
  const userSkills = skills.filter(s => s.student_id === student.id);
  const userPoints = points.find(p => p.student_id === student.id);

  return json({
    ok: true,
    student: {
      kvadId: student.kvad_id,
      name: student.display_name,
      class: student.class,
      totalPoints: userPoints ? Number(userPoints.total_points) : 0,
      badges: userPoints ? JSON.parse(userPoints.badges || "[]") : [],
      skills: userSkills.map(s => ({
        skill: s.skill,
        level: Number(s.level),
        score: Number(s.score),
        tries: Number(s.tries),
      })),
      recentActivity: userAnswers.filter(a => a.correct === "1").slice(0, 5).map(a => ({
        challengeId: a.challenge_id,
        correct: true,
        at: a.created_at,
      })),
    },
  });
}

async function handleExportTeacher(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user || user.role !== "teacher") return err("teacher_only", 403);

  const url = new URL(request.url);
  const classFilter = url.searchParams.get("class");
  const format = url.searchParams.get("format") || "csv";

  const students = await sheetsGet(env, SHEET_STUDENTS) || [];
  const filtered = students.filter(s => s.role === "student" && (!classFilter || s.class === classFilter));

  if (format === "csv") {
    const lines = ["kvadId,name,class,totalPoints,badges"];
    const points = await sheetsGet(env, SHEET_POINTS) || [];
    for (const r of filtered) {
      const p = points.find(pp => pp.student_id === r.id);
      lines.push([r.kvad_id, r.display_name, r.class, p ? p.total_points : 0, p ? p.badges : "[]"].join(","));
    }
    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=class_export.csv", ...corsHeaders() },
    });
  }

  return json({ ok: true, export: { format, rowCount: filtered.length } });
}

// ---------------------------------------------------------------------------
// Quota Handlers
// ---------------------------------------------------------------------------

async function handleGetQuotaPlaytime(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user) return err("unauthorized", 401);

  const today = new Date().toISOString().split("T")[0];
  const quota = await sheetsGet(env, SHEET_QUOTA) || [];
  const q = quota.find(q => q.student_id === user.id && q.quota_date === today);

  if (!q) {
    return json({
      ok: true,
      quota: {
        date: today,
        playTimeMinutes: 0,
        dailyLimitMinutes: 60,
        remainingMinutes: 60,
        resetAt: new Date(today + "T23:59:59Z").toISOString(),
      },
    });
  }

  return json({
    ok: true,
    quota: {
      date: q.quota_date,
      playTimeMinutes: Number(q.min_used),
      dailyLimitMinutes: Number(q.limit_minutes),
      remainingMinutes: Math.max(0, Number(q.limit_minutes) - Number(q.min_used)),
      resetAt: new Date(q.quota_date + "T23:59:59Z").toISOString(),
    },
  });
}

async function handleGetQuotaExhausted(request, env) {
  const token = needToken(request);
  if (!token) return err("missing_token", 401);
  const user = await getUser(env, token);
  if (!user) return err("unauthorized", 401);

  const today = new Date().toISOString().split("T")[0];
  const quota = await sheetsGet(env, SHEET_QUOTA) || [];
  const q = quota.find(q => q.student_id === user.id && q.quota_date === today);

  if (!q || Number(q.min_used) < Number(q.limit_minutes)) {
    return json({
      ok: true,
      exhausted: false,
      quota: {
        date: today,
        playTimeMinutes: q ? Number(q.min_used) : 0,
        dailyLimitMinutes: q ? Number(q.limit_minutes) : 60,
      },
    });
  }

  return json({
    ok: true,
    exhausted: true,
    message: "Daily play time limit reached. Come back tomorrow!",
    quota: {
      date: q.quota_date,
      playTimeMinutes: Number(q.min_used),
      dailyLimitMinutes: Number(q.limit_minutes),
      remainingMinutes: 0,
      resetAt: new Date(q.quota_date + "T23:59:59Z").toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// Questions Handler
// ---------------------------------------------------------------------------

async function handleGetQuestions(request, env) {
  const url = new URL(request.url);
  const skill = url.searchParams.get("skill");
  const level = Number(url.searchParams.get("level")) || 1;

  if (!SKILLS.includes(skill || "")) return err("bad_skill", 400);

  const questions = await sheetsGet(env, SHEET_QUESTIONS) || [];
  const filtered = questions.filter(q => q.skill === skill && Number(q.level) === level);
  return json({ ok: true, questions: filtered, count: filtered.length });
}

// ---------------------------------------------------------------------------
// Health Handler
// ---------------------------------------------------------------------------

async function handleHealth(request, env) {
  return json({ ok: true, sheets: Boolean(env.SHEET_ID), ai: Boolean(env.AI), kv: Boolean(env.SAI_KV) });
}

// ---------------------------------------------------------------------------
// JWT Helpers
// ---------------------------------------------------------------------------

async function hashString(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

// ---------------------------------------------------------------------------
// Main Fetch Handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return handleHealth(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
      return handleLogin(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/register") {
      return handleRegister(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") {
      return handleLogout(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/auth/me") {
      return handleMe(request, env);
    }

    const token = needToken(request);
    if (!token) return err("missing_token", 401);
    const user = await getUser(env, token);
    if (!user) return err("unauthorized", 401);

    if (request.method !== "GET" && request.method !== "HEAD") {
      if (!(await verifyCsrf(request, env))) return err("csrf_failed", 403);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/progress") {
      return handleGetProgress(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/progress/challenges") {
      return handleSubmitChallenge(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/skills") {
      return handleGetProgress(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/games/score") {
      return handleSubmitGameScore(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/games/leaderboard") {
      return handleGetLeaderboard(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/teacher/class") {
      return handleGetTeacherClass(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/v1/teacher/students/")) {
      return handleGetTeacherStudentProgress(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/teacher/export") {
      return handleExportTeacher(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/quota/playtime") {
      return handleGetQuotaPlaytime(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/quota/exhausted") {
      return handleGetQuotaExhausted(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/questions") {
      return handleGetQuestions(request, env);
    }

    return err("not_found", 404);
  },
};
