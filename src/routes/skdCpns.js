const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
const { logAdminActivity } = require("../utils/activityLogger");
const multer = require("multer");
const xlsx = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// HELPER: Plan access check untuk SKD CPNS
// ============================================================
const CPNS_PLAN_RANK = {
  gratis: 0,
  cpns_to_eceran: 1,
  cpns_to_all: 2,
  cpns_3m: 3,
  cpns_6m: 3,
};

async function getUserCpnsAccess(userId) {
  const res = await pool.query(
    `SELECT p.name, p.plan_type, p.target_type, p.quota_limit,
            s.quota_remaining, s.expires_at, s.status
     FROM subscriptions s
     JOIN plans p ON s.plan_id = p.id
     WHERE s.user_id = $1
       AND s.status = 'active'
       AND s.expires_at > NOW()
       AND p.target_type = 'cpns'`,
    [userId]
  );
  return res.rows;
}

function hasCpnsPlanAccess(activePlans, requiredPlan) {
  if (!requiredPlan || requiredPlan === "gratis") return true;
  for (const plan of activePlans) {
    const pRank = CPNS_PLAN_RANK[plan.name] ?? 0;
    const reqRank = CPNS_PLAN_RANK[requiredPlan] ?? 0;
    if (pRank >= reqRank) return true;
    // quota plan: check remaining
    if (plan.plan_type === "quota" && (plan.quota_remaining || 0) > 0) return true;
  }
  return false;
}

// ============================================================
// PUBLIC/STUDENT: Subtes & Topics
// ============================================================

// GET /api/skd/subjects — daftar subtes SKD
router.get("/subjects", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.*, COALESCE(tc.cnt, 0)::int AS topic_count
       FROM skd_subjects s
       LEFT JOIN (SELECT subject_id, COUNT(*) AS cnt FROM skd_topics GROUP BY subject_id) tc ON tc.subject_id = s.id
       WHERE s.is_active = TRUE
       ORDER BY s.display_order ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/skd/subjects/:subjectId/topics
router.get("/subjects/:subjectId/topics", verifyToken, async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const result = await pool.query(
      `SELECT t.*, COUNT(q.id) as actual_question_count
       FROM skd_topics t
       LEFT JOIN skd_questions q ON q.topic_id = t.id AND q.tryout_package_id IS NULL
       WHERE t.subject_id = $1
       GROUP BY t.id
       ORDER BY t.display_order ASC`,
      [subjectId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PUBLIC/STUDENT: Tryout Packages
// ============================================================

// GET /api/skd/packages
router.get("/packages", verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM skd_tryout_packages ORDER BY created_at DESC"
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// TRYOUT FLOW: Start, Questions, Submit, Result
// ============================================================

// POST /api/skd/tryout/start
router.post("/tryout/start", verifyToken, async (req, res, next) => {
  const { package_id } = req.body;
  const userId = req.user.id;

  if (!package_id) {
    return res.status(400).json({ success: false, error: "package_id diperlukan" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Get package
    const pkgRes = await client.query(
      "SELECT * FROM skd_tryout_packages WHERE id = $1 AND is_active = TRUE",
      [package_id]
    );
    if (pkgRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Paket tidak ditemukan atau tidak aktif" });
    }
    const pkg = pkgRes.rows[0];

    // Check plan access
    const activePlans = await getUserCpnsAccess(userId);
    const requiredPlan = pkg.required_plan || "gratis";

    if (!hasCpnsPlanAccess(activePlans, requiredPlan)) {
      // Check if user has quota plan and decrement
      const quotaPlan = activePlans.find(
        (p) => p.plan_type === "quota" && (p.quota_remaining || 0) > 0
      );
      if (!quotaPlan) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          error: "Akses ditolak. Upgrade paket CPNS untuk mengerjakan tryout ini.",
        });
      }
    }

    // Check registration status (for free packages)
    if (requiredPlan === "gratis") {
      const regRes = await client.query(
        `SELECT * FROM tryout_registrations
         WHERE user_id = $1 AND package_type = 'cpns' AND cpns_package_id = $2 AND status = 'approved'`,
        [userId, package_id]
      );
      // Cek apakah sudah pernah kerjakan
      const doneRes = await client.query(
        `SELECT id FROM skd_tryout_sessions
         WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NOT NULL`,
        [userId, package_id]
      );
      if (regRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          error: "Daftar dan verifikasi sosial media terlebih dahulu untuk mengakses tryout gratis.",
          needsRegistration: true,
        });
      }
      if (doneRes.rows.length > 0 && activePlans.length === 0) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          error: "Akun gratis hanya dapat mengerjakan setiap paket tryout 1 kali.",
        });
      }
    }

    // Decrement quota if applicable
    const quotaPlan = activePlans.find(
      (p) => p.plan_type === "quota" && (p.quota_remaining || 0) > 0
    );
    if (requiredPlan !== "gratis" && quotaPlan) {
      await client.query(
        `UPDATE subscriptions SET quota_remaining = quota_remaining - 1
         WHERE user_id = $1 AND plan_id = (SELECT id FROM plans WHERE name = $2 LIMIT 1)`,
        [userId, quotaPlan.name]
      );
    }

    // Create session
    const sessionRes = await client.query(
      `INSERT INTO skd_tryout_sessions (user_id, package_id)
       VALUES ($1, $2) RETURNING *`,
      [userId, package_id]
    );
    const session = sessionRes.rows[0];

    await client.query("COMMIT");
    res.json({ success: true, data: { sessionId: session.id, session } });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/skd/tryout/session/:sessionId/questions
router.get("/tryout/session/:sessionId/questions", verifyToken, async (req, res, next) => {
  const { sessionId } = req.params;
  const userId = req.user.id;

  try {
    // Verify session ownership
    const sessionRes = await pool.query(
      "SELECT * FROM skd_tryout_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, userId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Sesi tidak ditemukan" });
    }
    const session = sessionRes.rows[0];

    // Get package config
    const pkgRes = await pool.query(
      "SELECT * FROM skd_tryout_packages WHERE id = $1",
      [session.package_id]
    );
    if (pkgRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Paket tidak ditemukan" });
    }
    const pkg = pkgRes.rows[0];
    let subjectConfig = pkg.subject_config;
    if (typeof subjectConfig === "string") subjectConfig = JSON.parse(subjectConfig);

    // Get all questions for this package
    const questionsData = [];
    let position = 0;
    for (const subConfig of subjectConfig) {
      const subjectRes = await pool.query(
        "SELECT * FROM skd_subjects WHERE LOWER(name) = LOWER($1) LIMIT 1",
        [subConfig.name]
      );
      if (subjectRes.rows.length === 0) continue;
      const subject = subjectRes.rows[0];
      const qCount = subConfig.questionCount || subject.question_count;

      // Get questions for this subtes
      const qRes = await pool.query(
        `SELECT q.*, s.name AS subject_name, s.is_tkp, s.points_correct as subject_points_correct
         FROM skd_questions q
         JOIN skd_subjects s ON q.subject_id = s.id
         WHERE q.tryout_package_id = $1 AND q.subject_id = $2
         ORDER BY q.display_order ASC, q.created_at ASC
         LIMIT $3`,
        [session.package_id, subject.id, qCount]
      );

      const questionIds = qRes.rows.map((q) => q.id);

      // Get choices
      const choicesRes = await pool.query(
        `SELECT * FROM skd_answer_choices WHERE question_id = ANY($1::uuid[]) ORDER BY label ASC`,
        [questionIds]
      );
      const choicesMap = {};
      choicesRes.rows.forEach((c) => {
        if (!choicesMap[c.question_id]) choicesMap[c.question_id] = [];
        choicesMap[c.question_id].push(c);
      });

      // Get existing answers
      const answersRes = await pool.query(
        `SELECT * FROM skd_user_answers WHERE session_id = $1 AND question_id = ANY($2::uuid[])`,
        [sessionId, questionIds]
      );
      const answersMap = {};
      answersRes.rows.forEach((a) => { answersMap[a.question_id] = a; });

      for (const q of qRes.rows) {
        questionsData.push({
          ...q,
          choices: choicesMap[q.id] || [],
          existingAnswer: answersMap[q.id] || null,
          position: position++,
          subjectConfig: subConfig,
        });
      }
    }

    res.json({
      success: true,
      data: {
        session,
        questions: questionsData,
        package: pkg,
        subjectConfig,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/skd/tryout/answer — save single answer
router.post("/tryout/answer", verifyToken, async (req, res, next) => {
  const { session_id, question_id, chosen_choice_id, is_flagged, time_spent_sec, position } = req.body;
  const userId = req.user.id;

  try {
    // Verify ownership
    const sessionRes = await pool.query(
      "SELECT id FROM skd_tryout_sessions WHERE id = $1 AND user_id = $2 AND submitted_at IS NULL",
      [session_id, userId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(403).json({ success: false, error: "Sesi tidak valid" });
    }

    // Calculate points if answer provided
    let pointsEarned = 0;
    if (chosen_choice_id) {
      const choiceRes = await pool.query(
        `SELECT ac.*, sq.is_tkp as subject_is_tkp, ss.points_correct as subject_points_correct
         FROM skd_answer_choices ac
         JOIN skd_questions sq ON ac.question_id = sq.id
         JOIN skd_subjects ss ON sq.subject_id = ss.id
         WHERE ac.id = $1`,
        [chosen_choice_id]
      );
      if (choiceRes.rows.length > 0) {
        const choice = choiceRes.rows[0];
        if (choice.subject_is_tkp) {
          pointsEarned = choice.tkp_point || 0;
        } else {
          pointsEarned = choice.is_correct ? (choice.subject_points_correct || 5) : 0;
        }
      }
    }

    // Upsert answer
    await pool.query(
      `INSERT INTO skd_user_answers (session_id, question_id, chosen_choice_id, is_flagged, time_spent_sec, position, points_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id, question_id)
       DO UPDATE SET chosen_choice_id = $3, is_flagged = $4, time_spent_sec = $5, position = $6, points_earned = $7`,
      [session_id, question_id, chosen_choice_id || null, is_flagged || false, time_spent_sec || 0, position || 0, pointsEarned]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/skd/tryout/submit-bulk — submit all answers + finalize
router.post("/tryout/submit-bulk", verifyToken, async (req, res, next) => {
  const { session_id, answers } = req.body;
  const userId = req.user.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify session
    const sessionRes = await client.query(
      "SELECT * FROM skd_tryout_sessions WHERE id = $1 AND user_id = $2 AND submitted_at IS NULL",
      [session_id, userId]
    );
    if (sessionRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, error: "Sesi tidak valid atau sudah disubmit" });
    }

    // Upsert all answers
    for (const ans of answers || []) {
      let pointsEarned = 0;
      if (ans.chosen_choice_id) {
        const choiceRes = await client.query(
          `SELECT ac.*, sq.is_tkp as subject_is_tkp, ss.points_correct as subject_points_correct
           FROM skd_answer_choices ac
           JOIN skd_questions sq ON ac.question_id = sq.id
           JOIN skd_subjects ss ON sq.subject_id = ss.id
           WHERE ac.id = $1`,
          [ans.chosen_choice_id]
        );
        if (choiceRes.rows.length > 0) {
          const choice = choiceRes.rows[0];
          pointsEarned = choice.subject_is_tkp
            ? (choice.tkp_point || 0)
            : choice.is_correct ? (choice.subject_points_correct || 5) : 0;
        }
      }
      await client.query(
        `INSERT INTO skd_user_answers (session_id, question_id, chosen_choice_id, is_flagged, time_spent_sec, position, points_earned)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (session_id, question_id)
         DO UPDATE SET chosen_choice_id = $3, is_flagged = $4, time_spent_sec = $5, position = $6, points_earned = $7`,
        [session_id, ans.question_id, ans.chosen_choice_id || null, ans.is_flagged || false, ans.time_spent_sec || 0, ans.position || 0, pointsEarned]
      );
    }

    // Calculate total scores per subtes
    const subjectScoreRes = await client.query(
      `SELECT sq.subject_id, ss.name as subject_name, ss.is_tkp, ss.passing_grade,
              SUM(ua.points_earned) as total_points
       FROM skd_user_answers ua
       JOIN skd_questions sq ON ua.question_id = sq.id
       JOIN skd_subjects ss ON sq.subject_id = ss.id
       WHERE ua.session_id = $1
       GROUP BY sq.subject_id, ss.name, ss.is_tkp, ss.passing_grade`,
      [session_id]
    );

    let twkScore = 0, tiuScore = 0, tkpScore = 0;
    const scoreBreakdown = {};
    let allPassed = true;

    subjectScoreRes.rows.forEach((row) => {
      const pts = parseInt(row.total_points) || 0;
      scoreBreakdown[row.subject_name] = { score: pts, passing_grade: row.passing_grade, passed: pts >= row.passing_grade };
      if (pts < row.passing_grade) allPassed = false;
      if (row.subject_name === "TWK") twkScore = pts;
      else if (row.subject_name === "TIU") tiuScore = pts;
      else if (row.subject_name === "TKP") tkpScore = pts;
    });

    const totalScore = twkScore + tiuScore + tkpScore;

    // Update session
    await client.query(
      `UPDATE skd_tryout_sessions
       SET submitted_at = NOW(), total_score = $1, twk_score = $2, tiu_score = $3, tkp_score = $4,
           score_breakdown = $5, is_passed = $6
       WHERE id = $7`,
      [totalScore, twkScore, tiuScore, tkpScore, JSON.stringify(scoreBreakdown), allPassed, session_id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      data: { sessionId: session_id, totalScore, twkScore, tiuScore, tkpScore, scoreBreakdown, isPassed: allPassed },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/skd/tryout/result/:sessionId
router.get("/tryout/result/:sessionId", verifyToken, async (req, res, next) => {
  const { sessionId } = req.params;
  const userId = req.user.id;

  try {
    const sessionRes = await pool.query(
      `SELECT s.*, p.title as package_title, p.subject_config
       FROM skd_tryout_sessions s
       JOIN skd_tryout_packages p ON s.package_id = p.id
       WHERE s.id = $1 AND s.user_id = $2`,
      [sessionId, userId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Sesi tidak ditemukan" });
    }
    const session = sessionRes.rows[0];

    // Get all answers with question & choice details
    const answersRes = await pool.query(
      `SELECT ua.*,
              q.content AS question_content, q.image_url, q.stimulus,
              ss.name AS subject_name, ss.is_tkp,
              ac.label AS chosen_label, ac.content AS chosen_content, ac.is_correct AS chosen_is_correct, ac.tkp_point,
              ac.explanation
       FROM skd_user_answers ua
       JOIN skd_questions q ON ua.question_id = q.id
       JOIN skd_subjects ss ON q.subject_id = ss.id
       LEFT JOIN skd_answer_choices ac ON ua.chosen_choice_id = ac.id
       WHERE ua.session_id = $1
       ORDER BY ua.position ASC`,
      [sessionId]
    );

    // Get correct choices for each question
    const questionIds = answersRes.rows.map((a) => a.question_id);
    const correctChoicesRes = await pool.query(
      `SELECT q.id as question_id, ac.*
       FROM skd_questions q
       JOIN skd_answer_choices ac ON ac.question_id = q.id
       WHERE q.id = ANY($1::uuid[]) AND (ac.is_correct = TRUE OR ac.tkp_point = (
         SELECT MAX(tkp_point) FROM skd_answer_choices WHERE question_id = q.id
       ))`,
      [questionIds]
    );
    const correctMap = {};
    correctChoicesRes.rows.forEach((c) => { correctMap[c.question_id] = c; });

    // Get all choices for all questions
    const allChoicesRes = await pool.query(
      `SELECT * FROM skd_answer_choices WHERE question_id = ANY($1::uuid[]) ORDER BY label ASC`,
      [questionIds]
    );
    const allChoicesMap = {};
    allChoicesRes.rows.forEach((c) => {
      if (!allChoicesMap[c.question_id]) allChoicesMap[c.question_id] = [];
      allChoicesMap[c.question_id].push(c);
    });

    // Get subjects info
    const subjectsRes = await pool.query(
      "SELECT * FROM skd_subjects ORDER BY display_order ASC"
    );

    res.json({
      success: true,
      data: {
        session,
        answers: answersRes.rows.map((a) => ({
          ...a,
          correctChoice: correctMap[a.question_id],
          allChoices: allChoicesMap[a.question_id] || [],
        })),
        subjects: subjectsRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// TRYOUT REGISTRATION (Verifikasi Sosmed untuk gratis)
// ============================================================

// GET /api/skd/registration-status/:packageId
router.get("/registration-status/:packageId", verifyToken, async (req, res, next) => {
  const { packageId } = req.params;
  const userId = req.user.id;
  try {
    const regRes = await pool.query(
      `SELECT * FROM tryout_registrations
       WHERE user_id = $1 AND package_type = 'cpns' AND cpns_package_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, packageId]
    );
    const doneRes = await pool.query(
      `SELECT id FROM skd_tryout_sessions WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NOT NULL`,
      [userId, packageId]
    );
    res.json({
      success: true,
      data: {
        registration: regRes.rows[0] || null,
        completed: doneRes.rows.length > 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/skd/register — social media registration
router.post("/register", verifyToken, async (req, res, next) => {
  const { package_id, contact_email, screenshot_follow_url, screenshot_repost_url, platform } = req.body;
  const userId = req.user.id;
  try {
    // Check existing pending/approved
    const existing = await pool.query(
      `SELECT * FROM tryout_registrations
       WHERE user_id = $1 AND package_type = 'cpns' AND cpns_package_id = $2
         AND status IN ('pending', 'approved')`,
      [userId, package_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Sudah ada pendaftaran untuk tryout ini.",
        data: existing.rows[0],
      });
    }

    const result = await pool.query(
      `INSERT INTO tryout_registrations
       (user_id, contact_email, package_type, cpns_package_id, screenshot_follow_url, screenshot_repost_url, platform, status)
       VALUES ($1, $2, 'cpns', $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [userId, contact_email, package_id, screenshot_follow_url, screenshot_repost_url || null, platform || "instagram"]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/skd/complete-status/:packageId — check completion
router.get("/complete-status/:packageId", verifyToken, async (req, res, next) => {
  const { packageId } = req.params;
  const userId = req.user.id;
  try {
    const res2 = await pool.query(
      `SELECT id FROM skd_tryout_sessions WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NOT NULL LIMIT 1`,
      [userId, packageId]
    );
    res.json({ success: true, data: { completed: res2.rows.length > 0 } });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LATIHAN SOAL FLOW
// ============================================================

// POST /api/skd/latihan/start
router.post("/latihan/start", verifyToken, async (req, res, next) => {
  const { subject_id, topic_id, question_count = 20 } = req.body;
  const userId = req.user.id;

  try {
    if (topic_id) {
      const topicRes = await pool.query("SELECT required_plan FROM skd_topics WHERE id = $1", [topic_id]);
      const requiredPlan = topicRes.rows[0]?.required_plan || "gratis";
      if (requiredPlan === "premium") {
        const userPlans = await getUserCpnsAccess(userId);
        const hasAccess = hasCpnsPlanAccess(userPlans, requiredPlan);
        if (!hasAccess && req.user.role !== "admin") {
          return res.status(403).json({
            success: false,
            error: "Akses Premium diperlukan. Upgrade paket CPNS Anda untuk mengakses paket latihan ini."
          });
        }
      }
    }

    let query;
    let params;
    if (topic_id) {
      query = `SELECT q.*, s.name AS subject_name, s.is_tkp
               FROM skd_questions q
               JOIN skd_subjects s ON q.subject_id = s.id
               WHERE q.topic_id = $1 AND q.tryout_package_id IS NULL
               ORDER BY q.created_at ASC, q.id ASC`;
      params = [topic_id];
    } else if (subject_id) {
      query = `SELECT q.*, s.name AS subject_name, s.is_tkp
               FROM skd_questions q
               JOIN skd_subjects s ON q.subject_id = s.id
               WHERE q.subject_id = $1 AND q.tryout_package_id IS NULL
               ORDER BY q.created_at ASC, q.id ASC LIMIT $2`;
      params = [subject_id, question_count];
    } else {
      return res.status(400).json({ success: false, error: "subject_id atau topic_id diperlukan" });
    }

    const qRes = await pool.query(query, params);
    const questions = qRes.rows;
    if (questions.length === 0) {
      return res.status(404).json({ success: false, error: "Belum ada soal untuk latihan ini" });
    }

    const questionIds = questions.map((q) => q.id);
    const choicesRes = await pool.query(
      "SELECT * FROM skd_answer_choices WHERE question_id = ANY($1::uuid[]) ORDER BY label ASC",
      [questionIds]
    );
    const choicesMap = {};
    choicesRes.rows.forEach((c) => {
      if (!choicesMap[c.question_id]) choicesMap[c.question_id] = [];
      choicesMap[c.question_id].push(c);
    });

    const subjectRes = await pool.query("SELECT * FROM skd_subjects WHERE id = $1", [subject_id || questions[0].subject_id]);
    const subject = subjectRes.rows[0];

    res.json({
      success: true,
      data: {
        questions: questions.map((q, i) => ({
          ...q,
          choices: choicesMap[q.id] || [],
          position: i,
        })),
        subject,
        questionCount: questions.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/skd/latihan/submit
router.post("/latihan/submit", verifyToken, async (req, res, next) => {
  const { subject_id, topic_id, answers, question_count } = req.body;
  const userId = req.user.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Get subject name
    const subRes = await client.query("SELECT * FROM skd_subjects WHERE id = $1", [subject_id]);
    const subject = subRes.rows[0];

    let totalScore = 0, correctCount = 0, incorrectCount = 0, unansweredCount = 0;
    const processedAnswers = [];

    for (const ans of answers || []) {
      let isCorrect = false;
      let pointsEarned = 0;

      if (ans.chosen_choice_id) {
        const choiceRes = await client.query(
          `SELECT ac.*, q.id as qid FROM skd_answer_choices ac
           JOIN skd_questions q ON ac.question_id = q.id
           WHERE ac.id = $1`,
          [ans.chosen_choice_id]
        );
        if (choiceRes.rows.length > 0) {
          const choice = choiceRes.rows[0];
          if (subject?.is_tkp) {
            pointsEarned = choice.tkp_point || 0;
            isCorrect = pointsEarned >= 4; // TKP: dianggap "benar" jika pilih nilai >= 4
          } else {
            isCorrect = choice.is_correct;
            pointsEarned = choice.is_correct ? (subject?.points_correct || 5) : 0;
          }
        }
        if (isCorrect) correctCount++;
        else incorrectCount++;
      } else {
        unansweredCount++;
      }
      totalScore += pointsEarned;
      processedAnswers.push({ ...ans, is_correct: isCorrect, points_earned: pointsEarned });
    }

    // Create session
    const sessionRes = await client.query(
      `INSERT INTO skd_latihan_sessions
       (user_id, subject_id, topic_id, subject_name, total_questions, correct_count, incorrect_count, unanswered_count, total_score, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
      [userId, subject_id, topic_id || null, subject?.name || "", question_count || answers.length, correctCount, incorrectCount, unansweredCount, totalScore]
    );
    const session = sessionRes.rows[0];

    // Save answers
    for (const ans of processedAnswers) {
      await client.query(
        `INSERT INTO skd_latihan_answers
         (session_id, question_id, chosen_choice_id, is_correct, points_earned, time_spent_sec, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [session.id, ans.question_id, ans.chosen_choice_id || null, ans.is_correct, ans.points_earned, ans.time_spent_sec || 0, ans.position || 0]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, data: { sessionId: session.id, session } });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/skd/latihan/result/:sessionId
router.get("/latihan/result/:sessionId", verifyToken, async (req, res, next) => {
  const { sessionId } = req.params;
  const userId = req.user.id;
  try {
    const sessionRes = await pool.query(
      `SELECT ls.*, ss.name as subject_name_detail, ss.is_tkp, ss.passing_grade,
              st.title as topic_title
       FROM skd_latihan_sessions ls
       LEFT JOIN skd_subjects ss ON ls.subject_id = ss.id
       LEFT JOIN skd_topics st ON ls.topic_id = st.id
       WHERE ls.id = $1 AND ls.user_id = $2`,
      [sessionId, userId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Sesi latihan tidak ditemukan" });
    }
    const session = sessionRes.rows[0];

    const answersRes = await pool.query(
      `SELECT la.*, q.content AS question_content, q.image_url, q.stimulus,
              ac.label AS chosen_label, ac.content AS chosen_content, ac.explanation,
              ac.is_correct AS chosen_is_correct, ac.tkp_point
       FROM skd_latihan_answers la
       JOIN skd_questions q ON la.question_id = q.id
       LEFT JOIN skd_answer_choices ac ON la.chosen_choice_id = ac.id
       WHERE la.session_id = $1
       ORDER BY la.position ASC`,
      [sessionId]
    );

    const questionIds = answersRes.rows.map((a) => a.question_id);
    const allChoicesRes = await pool.query(
      "SELECT * FROM skd_answer_choices WHERE question_id = ANY($1::uuid[]) ORDER BY label ASC",
      [questionIds]
    );
    const allChoicesMap = {};
    allChoicesRes.rows.forEach((c) => {
      if (!allChoicesMap[c.question_id]) allChoicesMap[c.question_id] = [];
      allChoicesMap[c.question_id].push(c);
    });

    res.json({
      success: true,
      data: {
        session,
        answers: answersRes.rows.map((a) => ({
          ...a,
          allChoices: allChoicesMap[a.question_id] || [],
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LEADERBOARD
// ============================================================
router.get("/leaderboard/:packageId", verifyToken, async (req, res, next) => {
  const { packageId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  try {
    const result = await pool.query(
      `SELECT s.id, s.total_score, s.twk_score, s.tiu_score, s.tkp_score, s.is_passed, s.submitted_at,
              u.name as user_name
       FROM skd_tryout_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.package_id = $1 AND s.submitted_at IS NOT NULL
       ORDER BY s.total_score DESC, s.submitted_at ASC
       LIMIT $2`,
      [packageId, limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ADMIN: Kelola Subjects & Topics
// ============================================================

// CRUD Subjects
router.get("/admin/subjects", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM skd_subjects ORDER BY display_order ASC");
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post("/admin/subjects", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { name, full_name, description, question_count, duration_minutes, passing_grade, is_tkp, display_order, is_active, icon } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO skd_subjects (name, full_name, description, question_count, duration_minutes, passing_grade, is_tkp, display_order, is_active, icon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        name,
        full_name || name,
        description || null,
        question_count || 30,
        duration_minutes || 30,
        passing_grade || 65,
        is_tkp || false,
        display_order || 0,
        is_active !== undefined ? is_active : true,
        icon || null
      ]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch("/admin/subjects/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { name, full_name, description, passing_grade, is_active, question_count, duration_minutes, is_tkp, icon } = req.body;
  try {
    const result = await pool.query(
      `UPDATE skd_subjects SET
         name = COALESCE($1, name),
         full_name = COALESCE($2, full_name),
         description = COALESCE($3, description),
         passing_grade = COALESCE($4, passing_grade),
         is_active = COALESCE($5, is_active),
         question_count = COALESCE($6, question_count),
         duration_minutes = COALESCE($7, duration_minutes),
         is_tkp = COALESCE($8, is_tkp),
         icon = COALESCE($9, icon)
       WHERE id = $10 RETURNING *`,
      [name, full_name, description, passing_grade, is_active, question_count, duration_minutes, is_tkp, icon, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete("/admin/subjects/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM skd_subjects WHERE id = $1", [id]);
    res.json({ success: true, message: "Subtes berhasil dihapus" });
  } catch (err) { next(err); }
});

// CRUD Topics
router.get("/admin/subjects/:subjectId/topics", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM skd_topics WHERE subject_id = $1 ORDER BY display_order ASC",
      [req.params.subjectId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// Ensure required_plan column exists on skd_topics
pool.query("ALTER TABLE skd_topics ADD COLUMN IF NOT EXISTS required_plan VARCHAR(50) DEFAULT 'gratis';").catch(() => {});

router.post("/admin/subjects/:subjectId/topics", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { subjectId } = req.params;
  const { title, description, icon, difficulty_level, display_order, is_popular, required_plan } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO skd_topics (subject_id, title, description, icon, difficulty_level, display_order, is_popular, required_plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        subjectId,
        title,
        description ?? null,
        icon ?? "topic",
        difficulty_level ?? "Dasar",
        display_order ?? 0,
        is_popular ?? false,
        required_plan ?? "gratis"
      ]
    );
    await logAdminActivity(req.user.id, "create", "skd_topic", result.rows[0].id, { title });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch("/admin/topics/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { title, description, icon, difficulty_level, display_order, is_popular, required_plan } = req.body;
  try {
    const result = await pool.query(
      `UPDATE skd_topics SET
         title = COALESCE($1, title), description = COALESCE($2, description),
         icon = COALESCE($3, icon), difficulty_level = COALESCE($4, difficulty_level),
         display_order = COALESCE($5, display_order), is_popular = COALESCE($6, is_popular),
         required_plan = COALESCE($7, required_plan)
       WHERE id = $8 RETURNING *`,
      [
        title ?? null,
        description ?? null,
        icon ?? null,
        difficulty_level ?? null,
        display_order ?? null,
        is_popular ?? null,
        required_plan ?? null,
        id
      ]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete("/admin/topics/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    await pool.query("DELETE FROM skd_topics WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// ADMIN: Kelola Questions
// ============================================================

// GET questions (filter by subject, topic, package)
router.get("/admin/questions", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { subject_id, topic_id, package_id, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let where = "1=1";
    const params = [];
    let pi = 1;
    if (subject_id) { where += ` AND q.subject_id = $${pi++}`; params.push(subject_id); }
    if (topic_id) { where += ` AND q.topic_id = $${pi++}`; params.push(topic_id); }
    
    if (package_id) {
      if (package_id === "none" || package_id === "null" || package_id === "latihan-umum") {
        where += ` AND q.tryout_package_id IS NULL`;
      } else {
        where += ` AND q.tryout_package_id = $${pi++}`;
        params.push(package_id);
      }
    }

    const countRes = await pool.query(`SELECT COUNT(*) FROM skd_questions q WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT q.*, ss.name as subject_name, st.title as topic_title
       FROM skd_questions q
       JOIN skd_subjects ss ON q.subject_id = ss.id
       LEFT JOIN skd_topics st ON q.topic_id = st.id
       WHERE ${where}
       ORDER BY q.created_at DESC
       LIMIT $${pi++} OFFSET $${pi++}`,
      params
    );

    const questionIds = result.rows.map((q) => q.id);
    const choicesRes = questionIds.length > 0
      ? await pool.query("SELECT * FROM skd_answer_choices WHERE question_id = ANY($1::uuid[]) ORDER BY label ASC", [questionIds])
      : { rows: [] };
    const choicesMap = {};
    choicesRes.rows.forEach((c) => {
      if (!choicesMap[c.question_id]) choicesMap[c.question_id] = [];
      choicesMap[c.question_id].push(c);
    });

    res.json({
      success: true,
      data: result.rows.map((q) => ({ ...q, choices: choicesMap[q.id] || [] })),
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
});

// POST question
router.post("/admin/questions", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { subject_id, topic_id, tryout_package_id, content, stimulus, image_url, image_position, difficulty, source, display_order, choices } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const cleanPackageId = (tryout_package_id === "none" || tryout_package_id === "null" || tryout_package_id === "latihan-umum" || !tryout_package_id) ? null : tryout_package_id;
    
    const qRes = await client.query(
      `INSERT INTO skd_questions (subject_id, topic_id, tryout_package_id, content, stimulus, image_url, image_position, difficulty, source, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [subject_id, topic_id || null, cleanPackageId, content, stimulus || null, image_url || null, image_position || "after", difficulty || "medium", source || "manual", display_order || 0]
    );
    const question = qRes.rows[0];

    if (choices && choices.length > 0) {
      for (const c of choices) {
        await client.query(
          `INSERT INTO skd_answer_choices (question_id, label, content, is_correct, tkp_point, explanation)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [question.id, c.label, c.content, c.is_correct || false, c.tkp_point || 0, c.explanation || null]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, data: question });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// PATCH question
router.patch("/admin/questions/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { content, stimulus, image_url, image_position, difficulty, topic_id, choices } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const qRes = await client.query(
      `UPDATE skd_questions SET
         content = COALESCE($1, content), stimulus = $2,
         image_url = COALESCE($3, image_url), image_position = COALESCE($4, image_position),
         difficulty = COALESCE($5, difficulty), topic_id = $6
       WHERE id = $7 RETURNING *`,
      [content, stimulus || null, image_url, image_position, difficulty, topic_id || null, id]
    );

    if (choices && choices.length > 0) {
      await client.query("DELETE FROM skd_answer_choices WHERE question_id = $1", [id]);
      for (const c of choices) {
        await client.query(
          `INSERT INTO skd_answer_choices (question_id, label, content, is_correct, tkp_point, explanation)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, c.label, c.content, c.is_correct || false, c.tkp_point || 0, c.explanation || null]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, data: qRes.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// DELETE question
router.delete("/admin/questions/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    await pool.query("DELETE FROM skd_questions WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE bulk
router.delete("/admin/questions/bulk", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { subject_id, topic_id, package_id } = req.body;
  try {
    let where = "1=1";
    const params = [];
    let pi = 1;
    if (subject_id) { where += ` AND subject_id = $${pi++}`; params.push(subject_id); }
    if (topic_id) { where += ` AND topic_id = $${pi++}`; params.push(topic_id); }
    
    if (package_id) {
      if (package_id === "none" || package_id === "null" || package_id === "latihan-umum") {
        where += ` AND tryout_package_id IS NULL`;
      } else {
        where += ` AND tryout_package_id = $${pi++}`;
        params.push(package_id);
      }
    }
    const result = await pool.query(`DELETE FROM skd_questions WHERE ${where} RETURNING id`, params);
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) { next(err); }
});

// POST import Excel
router.post("/admin/questions/import", [verifyToken, verifyAdmin], upload.single("file"), async (req, res, next) => {
  const { subject_id, topic_id, package_id } = req.body;
  if (!req.file) return res.status(400).json({ success: false, error: "File Excel diperlukan" });
  if (!subject_id) return res.status(400).json({ success: false, error: "subject_id diperlukan" });

  const ALIASES = {
    soal:          ['soal', 'content', 'question', 'pertanyaan'],
    stimulus:      ['stimulus', 'wacana', 'bacaan', 'stimulus/wacana', 'stimulus/wacana (opsional)'],
    opsi_a:        ['opsi a', 'opsia', 'choice_a', 'pilihan a', 'a'],
    opsi_b:        ['opsi b', 'opsib', 'choice_b', 'pilihan b', 'b'],
    opsi_c:        ['opsi c', 'opsic', 'choice_c', 'pilihan c', 'c'],
    opsi_d:        ['opsi d', 'opsid', 'choice_d', 'pilihan d', 'd'],
    opsi_e:        ['opsi e', 'opsie', 'choice_e', 'pilihan e', 'e'],
    kunci:         ['kunci jawaban', 'kunci', 'correct_label', 'answer', 'jawaban', 'kunci_jawaban'],
    pembahasan:    ['pembahasan', 'explanation', 'penjelasan'],
    difficulty:    ['difficulty', 'kesulitan', 'tingkat kesulitan'],
    poin_a:        ['poin a', 'poina', 'point_a', 'poin_a'],
    poin_b:        ['poin b', 'poinb', 'point_b', 'poin_b'],
    poin_c:        ['poin c', 'poinc', 'point_c', 'poin_c'],
    poin_d:        ['poin d', 'poind', 'point_d', 'poin_d'],
    poin_e:        ['poin e', 'poine', 'point_e', 'poin_e'],
  };

  const resolve = (row, key) => {
    const aliases = ALIASES[key];
    for (const alias of aliases) {
      for (const rowKey of Object.keys(row)) {
        const clean = rowKey.replace(/^\uFEFF/, '').trim().toLowerCase();
        if (clean === alias) {
          const val = row[rowKey];
          if (val === null || val === undefined) return '';
          return String(val).trim();
        }
      }
    }
    return '';
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const cleanPackageId = (package_id === "none" || package_id === "null" || package_id === "latihan-umum" || !package_id) ? null : package_id;

    // Process subject characteristics
    const isTkpQuery = await client.query("SELECT is_tkp FROM skd_subjects WHERE id = $1", [subject_id]);
    const isTkp = isTkpQuery.rows[0]?.is_tkp || false;

    let imported = 0;
    for (const row of rows) {
      const content = resolve(row, 'soal');
      if (!content) continue;

      const stimulus = resolve(row, 'stimulus') || null;
      let rawDiff = resolve(row, 'difficulty').toLowerCase();
      const difficulty = ['easy', 'mudah'].includes(rawDiff) ? 'easy' :
                         ['hard', 'sulit'].includes(rawDiff) ? 'hard' : 'medium';
      const explanation = resolve(row, 'pembahasan') || null;

      const qRes = await client.query(
        `INSERT INTO skd_questions (subject_id, topic_id, tryout_package_id, content, stimulus, difficulty, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'import') RETURNING id`,
        [subject_id, topic_id || null, cleanPackageId, content, stimulus, difficulty]
      );
      const questionId = qRes.rows[0].id;

      // Process choices A–E
      const options = {
        A: resolve(row, 'opsi_a'),
        B: resolve(row, 'opsi_b'),
        C: resolve(row, 'opsi_c'),
        D: resolve(row, 'opsi_d'),
        E: resolve(row, 'opsi_e')
      };

      const points = {
        A: parseInt(resolve(row, 'poin_a')) || 0,
        B: parseInt(resolve(row, 'poin_b')) || 0,
        C: parseInt(resolve(row, 'poin_c')) || 0,
        D: parseInt(resolve(row, 'poin_d')) || 0,
        E: parseInt(resolve(row, 'poin_e')) || 0
      };

      const kunci = (resolve(row, 'kunci') || '').toUpperCase().trim();

      for (const label of ["A", "B", "C", "D", "E"]) {
        const choiceContent = options[label];
        if (!choiceContent) continue;
        const isCorrect = !isTkp && kunci === label;
        const tkpPoint = isTkp ? (points[label] || 0) : 0;
        await client.query(
          `INSERT INTO skd_answer_choices (question_id, label, content, is_correct, tkp_point, explanation)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [questionId, label, choiceContent, isCorrect, tkpPoint, (label === kunci) ? explanation : null]
        );
      }
      imported++;
    }

    await client.query("COMMIT");
    res.json({ success: true, imported, message: `${imported} soal berhasil diimport` });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// ============================================================
// ADMIN: Kelola Tryout Packages
// ============================================================

router.get("/admin/packages", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM skd_tryout_packages ORDER BY created_at DESC");
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// Ensure icon column exists on skd_tryout_packages
pool.query("ALTER TABLE skd_tryout_packages ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT 'assignment';").catch(() => {});

router.post("/admin/packages", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { title, description, subject_config, scheduled_at, is_public, is_active, required_plan, package_number, icon } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO skd_tryout_packages (title, description, subject_config, scheduled_at, is_public, is_active, required_plan, package_number, icon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        title,
        description ?? null,
        JSON.stringify(subject_config ?? []),
        scheduled_at ?? null,
        is_public !== false,
        is_active !== false,
        required_plan ?? "gratis",
        package_number ?? null,
        icon ?? "assignment"
      ]
    );
    await logAdminActivity(req.user.id, "create", "skd_package", result.rows[0].id, { title });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch("/admin/packages/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { title, description, subject_config, scheduled_at, is_public, is_active, required_plan, package_number, icon } = req.body;
  try {
    const result = await pool.query(
      `UPDATE skd_tryout_packages SET
         title = COALESCE($1, title), description = COALESCE($2, description),
         subject_config = COALESCE($3, subject_config), scheduled_at = $4,
         is_public = COALESCE($5, is_public), is_active = COALESCE($6, is_active),
         required_plan = COALESCE($7, required_plan), package_number = COALESCE($8, package_number),
         icon = COALESCE($9, icon)
       WHERE id = $10 RETURNING *`,
      [
        title ?? null,
        description ?? null,
        subject_config ? JSON.stringify(subject_config) : null,
        scheduled_at ?? null,
        is_public ?? null,
        is_active ?? null,
        required_plan ?? null,
        package_number ?? null,
        icon ?? null,
        id
      ]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete("/admin/packages/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    await pool.query("DELETE FROM skd_tryout_packages WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET package stats (soal per subtes)
router.get("/admin/packages/:id/stats", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  try {
    const pkgRes = await pool.query("SELECT * FROM skd_tryout_packages WHERE id = $1", [id]);
    if (pkgRes.rows.length === 0) return res.status(404).json({ success: false, error: "Paket tidak ditemukan" });
    const pkg = pkgRes.rows[0];
    let config = pkg.subject_config;
    if (typeof config === "string") config = JSON.parse(config);

    const stats = await Promise.all(
      (config || []).map(async (sub) => {
        const subRes = await pool.query("SELECT id FROM skd_subjects WHERE LOWER(name) = LOWER($1) LIMIT 1", [sub.name]);
        if (subRes.rows.length === 0) return { name: sub.name, needed: sub.questionCount, available: 0 };
        const countRes = await pool.query(
          "SELECT COUNT(*) as total FROM skd_questions WHERE subject_id = $1 AND tryout_package_id = $2",
          [subRes.rows[0].id, id]
        );
        return { name: sub.name, needed: sub.questionCount, available: parseInt(countRes.rows[0].total) };
      })
    );
    res.json({ success: true, data: stats });
  } catch (err) { next(err); }
});

// Admin: Registration management
router.get("/admin/registrations", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let where = "r.package_type = 'cpns'";
    const params = [];
    if (status) { where += ` AND r.status = $${params.length + 1}`; params.push(status); }
    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT r.*, u.name as user_name, u.email as user_email, p.title as package_title
       FROM tryout_registrations r
       JOIN users u ON r.user_id = u.id
       LEFT JOIN skd_tryout_packages p ON r.cpns_package_id = p.id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.patch("/admin/registrations/:id", [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { status, rejection_reason, admin_notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE tryout_registrations SET status = $1, rejection_reason = $2, admin_notes = $3, updated_at = NOW()
       WHERE id = $4 AND package_type = 'cpns' RETURNING *`,
      [status, rejection_reason || null, admin_notes || null, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
