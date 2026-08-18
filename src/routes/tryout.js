const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
const { logAdminActivity } = require("../utils/activityLogger");
const { calculateScore } = require("../services/scoringService");
const {
  calculateIRTScore,
  getStatusFromMastery,
  batchUpdateItemStats,
  getItemStatsForQuestions,
} = require("../services/irtScoringService");
const {
  isPackageCompleted,
  markPackageCompleted,
} = require("../utils/tryoutCompletionUtil");
const { getUtbkPackageAttemptInfo } = require("../utils/utbkAttemptUtil");

function parseLocalDate(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    // pg driver returns timestamp-without-timezone values as Date objects
    // interpreting the raw digits as UTC. But admin entered them as local time (WIB).
    // Extract the UTC components and create a new Date treating them as local time.
    return new Date(
      dateVal.getUTCFullYear(),
      dateVal.getUTCMonth(),
      dateVal.getUTCDate(),
      dateVal.getUTCHours(),
      dateVal.getUTCMinutes(),
      dateVal.getUTCSeconds()
    );
  }
  let str = String(dateVal).trim();
  if (str.includes('T')) {
    str = str.split('.')[0].replace('Z', '');
  }
  str = str.replace(' ', 'T');
  const parts = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (parts) {
    return new Date(
      parseInt(parts[1], 10),
      parseInt(parts[2], 10) - 1,
      parseInt(parts[3], 10),
      parseInt(parts[4] || '0', 10),
      parseInt(parts[5] || '0', 10),
      parseInt(parts[6] || '0', 10)
    );
  }
  const d = new Date(dateVal);
  return isNaN(d.getTime()) ? null : d;
}

// --- Get Allocated Duration in Seconds for Session Helper ---
async function getSessionAllocatedDurationSec(dbOrPool, sessionId) {
  try {
    const res = await dbOrPool.query(
      `SELECT ts.started_at, tp.subject_config,
         ARRAY_AGG(DISTINCT LOWER(s.name)) as subtest_names
       FROM tryout_sessions ts
       JOIN tryout_packages tp ON ts.package_id = tp.id
       JOIN user_answers ua ON ua.session_id = ts.id
       JOIN questions q ON ua.question_id = q.id
       LEFT JOIN subjects s ON q.subject_id = s.id
       WHERE ts.id = $1
       GROUP BY ts.id, ts.started_at, tp.subject_config`,
      [sessionId]
    );
    if (res.rows.length === 0) return null;
    const { started_at, subject_config, subtest_names } = res.rows[0];
    let config = subject_config;
    if (typeof config === "string") {
      try { config = JSON.parse(config); } catch { config = []; }
    }
    if (!Array.isArray(config)) config = [];

    const lowerNames = (subtest_names || []).filter(Boolean);
    let totalAllocatedSec = 0;
    if (config.length > 0 && lowerNames.length > 0) {
      config.forEach((sub) => {
        if (lowerNames.includes((sub.name || "").toLowerCase())) {
          const min = Number(sub.durationMin || sub.duration || 30);
          const sec = Number(sub.durationSec || 0);
          totalAllocatedSec += min * 60 + sec;
        }
      });
    }
    if (totalAllocatedSec === 0) {
      totalAllocatedSec = 30 * 60; // 30 mins fallback
    }
    return { started_at: new Date(started_at), totalAllocatedSec };
  } catch (err) {
    console.error("[DURATION CHECK] Error querying duration:", err.message);
    return null;
  }
}

// --- Auto Submit Expired Tryout Sessions Helper ---
async function autoSubmitSession(dbOrPool, sessionId, userId) {
  try {
    const sessionRes = await dbOrPool.query(
      `SELECT ts.id, ts.package_id, ts.user_id, ts.submitted_at, tp.end_date 
       FROM tryout_sessions ts 
       JOIN tryout_packages tp ON tp.id = ts.package_id 
       WHERE ts.id = $1 AND ts.submitted_at IS NULL`,
      [sessionId]
    );
    if (sessionRes.rows.length === 0) return null;
    const session = sessionRes.rows[0];

    const answersRes = await dbOrPool.query(
      `SELECT
        ua.chosen_choice_id,
        ua.answer_text,
        COALESCE(ac.is_correct, false) as is_correct,
        ua.question_id,
        COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
        COALESCE(q.difficulty, 'medium') as difficulty,
        COALESCE(q.question_type, 'multiple_choice') as question_type,
        COALESCE(s.name, 'Unknown') as subject_name
      FROM user_answers ua
      LEFT JOIN answer_choices ac ON ua.chosen_choice_id = ac.id
      LEFT JOIN questions q ON ua.question_id = q.id
      LEFT JOIN subjects s ON q.subject_id = s.id
      WHERE ua.session_id = $1`,
      [sessionId]
    );

    for (const ans of answersRes.rows) {
      if (ans.question_type === "short_answer" && ans.answer_text) {
        const correctRes = await dbOrPool.query(
          `SELECT content FROM answer_choices WHERE question_id = $1 AND is_correct = true LIMIT 1`,
          [ans.question_id]
        );
        if (correctRes.rows.length > 0) {
          ans.is_correct =
            correctRes.rows[0].content.trim().toLowerCase() ===
            ans.answer_text.trim().toLowerCase();
        }
      } else if (ans.question_type === "complex_mc_tf") {
        const choicesRes = await dbOrPool.query(
          `SELECT label, is_correct FROM answer_choices WHERE question_id = $1`,
          [ans.question_id]
        );
        let userAnswersObj = {};
        try {
          userAnswersObj = ans.answer_text ? JSON.parse(ans.answer_text) : {};
        } catch (e) {}
        ans.is_correct = choicesRes.rows.length > 0 && choicesRes.rows.every((c) => {
          const studentAns = userAnswersObj[c.label];
          return studentAns !== undefined && studentAns === c.is_correct;
        });
      }
    }

    const questionIds = answersRes.rows.map(a => a.question_id).filter(Boolean);
    const itemStatsMap = await getItemStatsForQuestions(dbOrPool, questionIds);

    const formattedAnswers = answersRes.rows.map((ans) => ({
      chosen_choice_id: ans.chosen_choice_id,
      is_correct: ans.is_correct === true,
      question_id: ans.question_id,
      difficulty: ans.difficulty || "medium",
      subject_name: ans.subject_name,
      time_spent_sec: ans.time_spent_sec || 0,
      question_type: ans.question_type,
      answer_text: ans.answer_text,
      irtParams: itemStatsMap[ans.question_id] || undefined,
    }));

    const irtResults = calculateIRTScore(formattedAnswers);
    const classicalResults = calculateScore(
      answersRes.rows.map((ans) => ({
        chosen_choice_id: ans.chosen_choice_id,
        is_correct: ans.is_correct,
        question_id: ans.question_id,
      }))
    );

    const finalResults = {
      ...irtResults,
      classical_score: classicalResults.total_score,
      scoringMethod: "IRT-3PL",
      autoSubmitted: true,
    };

    const submitTime = session.end_date || new Date();
    await dbOrPool.query(
      `UPDATE tryout_sessions SET submitted_at = $1, total_score = $2, score_breakdown = $3 WHERE id = $4`,
      [submitTime, finalResults.totalScore, JSON.stringify(finalResults), sessionId]
    );

    await markPackageCompleted(dbOrPool, session.user_id, "utbk", session.package_id);
    return finalResults;
  } catch (err) {
    console.error(`[AUTO-SUBMIT] Error auto submitting session ${sessionId}:`, err.message);
    return null;
  }
}

async function autoSubmitExpiredSessionsForUser(dbOrPool, userId) {
  if (!userId) return;
  try {
    const activeUtbkRes = await dbOrPool.query(
      `SELECT 1 FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
         AND (p.target_type = 'utbk' OR p.target_type = 'all') AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
       LIMIT 1`,
      [userId]
    );
    if (activeUtbkRes.rows.length > 0) {
      return; // Premium user: dates don't expire for them
    }

    const expiredRes = await dbOrPool.query(
      `SELECT ts.id, tp.end_date
       FROM tryout_sessions ts
       JOIN tryout_packages tp ON tp.id = ts.package_id
       WHERE ts.user_id = $1 AND ts.submitted_at IS NULL AND tp.end_date IS NOT NULL`,
      [userId]
    );

    const now = new Date();
    for (const row of expiredRes.rows) {
      const endDateObj = parseLocalDate(row.end_date);
      if (endDateObj && endDateObj < now) {
        await autoSubmitSession(dbOrPool, row.id, userId);
      }
    }
  } catch (err) {
    console.error("[AUTO-SUBMIT] Error checking expired sessions:", err.message);
  }
}

// --- Admin Package Management ---

// List all packages
router.get("/packages", verifyToken, async (req, res, next) => {
  try {
    if (req.user && req.user.id) {
      await autoSubmitExpiredSessionsForUser(pool, req.user.id);
    }
    const result = await pool.query(`
      SELECT 
        tp.*,
        COALESCE(s.student_count, 0)::int AS student_count,
        COALESCE(q.easy_count, 0)::int AS easy_count,
        COALESCE(q.medium_count, 0)::int AS medium_count,
        COALESCE(q.hard_count, 0)::int AS hard_count,
        COALESCE(q.total_questions, 0)::int AS total_questions
      FROM tryout_packages tp
      LEFT JOIN (
        SELECT package_id, COUNT(DISTINCT user_id) AS student_count
        FROM tryout_sessions
        GROUP BY package_id
      ) s ON s.package_id = tp.id
      LEFT JOIN (
        SELECT 
          tryout_package_id,
          COUNT(*) AS total_questions,
          COUNT(CASE WHEN difficulty = 'easy' THEN 1 END) AS easy_count,
          COUNT(CASE WHEN difficulty = 'medium' THEN 1 END) AS medium_count,
          COUNT(CASE WHEN difficulty = 'hard' THEN 1 END) AS hard_count
        FROM questions
        WHERE tryout_package_id IS NOT NULL
        GROUP BY tryout_package_id
      ) q ON q.tryout_package_id = tp.id
      ORDER BY tp.created_at DESC
    `);

    const packages = await Promise.all(
      result.rows.map(async (pkg) => {
        let attemptInfo = null;
        if (req.user && req.user.id) {
          attemptInfo = await getUtbkPackageAttemptInfo(pool, req.user.id, pkg.id);
        }
        return {
          ...pkg,
          attempts_used: attemptInfo?.completedAttempts || 0,
          max_attempts: 2,
          can_attempt: attemptInfo ? attemptInfo.canAttempt : true,
        };
      })
    );

    res.json({ success: true, data: packages });
  } catch (error) {
    next(error);
  }
});

// Get package question stats (berapa soal tersedia per subtes)
router.get(
  "/packages/:id/stats",
  verifyToken,
  verifyAdmin,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const pkgRes = await pool.query(
        "SELECT * FROM tryout_packages WHERE id = $1",
        [id],
      );
      if (pkgRes.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Package not found" });
      }
      const pkg = pkgRes.rows[0];
      let subjectConfig = pkg.subject_config;
      if (typeof subjectConfig === "string") {
        try {
          subjectConfig = JSON.parse(subjectConfig);
        } catch {
          subjectConfig = [];
        }
      }
      if (!Array.isArray(subjectConfig)) subjectConfig = [];

      const stats = await Promise.all(
        subjectConfig.map(async (sub) => {
          const subjectRes = await pool.query(
            "SELECT id, name FROM subjects WHERE LOWER(name) = LOWER($1) LIMIT 1",
            [sub.name],
          );
          if (subjectRes.rows.length === 0) {
            return {
              name: sub.name,
              needed: sub.questionCount || 20,
              available: 0,
            };
          }
          const countRes = await pool.query(
            "SELECT COUNT(*) as total FROM questions WHERE subject_id = $1",
            [subjectRes.rows[0].id],
          );
          return {
            name: sub.name,
            needed: sub.questionCount || 20,
            available: parseInt(countRes.rows[0].total),
          };
        }),
      );

      res.json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  },
);

// Create package
// Ensure end_date and required_plan column defaults on tryout_packages
pool.query("ALTER TABLE tryout_packages ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;").catch(() => {});
pool.query("ALTER TABLE tryout_packages ALTER COLUMN required_plan SET DEFAULT 'premium'; UPDATE tryout_packages SET required_plan = 'premium' WHERE required_plan = 'gratis' OR required_plan IS NULL;").catch(() => {});

// Create package
router.post("/packages", [verifyToken, verifyAdmin], async (req, res, next) => {
  const {
    title,
    subject_config,
    scheduled_at,
    end_date,
    is_public,
    is_active,
    required_plan,
    package_number,
  } = req.body;
  if (!title || !title.trim()) {
    return res
      .status(400)
      .json({ success: false, error: "Judul tryout wajib diisi." });
  }
  try {
    const configJson =
      typeof subject_config === "string"
        ? subject_config
        : JSON.stringify(subject_config || []);
    const scheduledValue = scheduled_at && scheduled_at.trim() !== "" ? scheduled_at.trim() : null;
    const endDateValue = end_date && end_date.trim() !== "" ? end_date.trim() : null;
    const packageNumValue = package_number && package_number.trim() !== "" ? package_number.trim() : null;
    const result = await pool.query(
      "INSERT INTO tryout_packages (title, subject_config, scheduled_at, end_date, is_public, is_active, required_plan, package_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
      [
        title.trim(),
        configJson,
        scheduledValue,
        endDateValue,
        is_public ?? true,
        is_active ?? true,
        required_plan || "premium",
        packageNumValue,
      ],
    );
    logAdminActivity(req, 'CREATE', 'PAKET_TRYOUT', result.rows[0].title, `Membuat paket UTBK Tryout: ${result.rows[0].title}`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (
      error.code === "23505" &&
      error.constraint === "tryout_packages_title_key"
    ) {
      return res.status(409).json({
        success: false,
        error: `Judul "${title}" sudah digunakan. Gunakan judul yang berbeda.`,
      });
    }
    next(error);
  }
});

// Update package
router.patch(
  "/packages/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    const { id } = req.params;
    const {
      title,
      subject_config,
      scheduled_at,
      end_date,
      is_public,
      is_active,
      required_plan,
      package_number,
    } = req.body;
    if (!title || !title.trim()) {
      return res
        .status(400)
        .json({ success: false, error: "Judul tryout wajib diisi." });
    }
    try {
      const configJson =
        typeof subject_config === "string"
          ? subject_config
          : JSON.stringify(subject_config || []);
      const scheduledValue = scheduled_at && scheduled_at.trim() !== "" ? scheduled_at.trim() : null;
      const endDateValue = end_date && end_date.trim() !== "" ? end_date.trim() : null;
      const packageNumValue = package_number && package_number.trim() !== "" ? package_number.trim() : null;
      const result = await pool.query(
        "UPDATE tryout_packages SET title = $1, subject_config = $2, scheduled_at = $3, end_date = $4, is_public = $5, is_active = COALESCE($6, is_active), required_plan = $7, package_number = $8 WHERE id = $9 RETURNING *",
        [
          title.trim(),
          configJson,
          scheduledValue,
          endDateValue,
          is_public,
          is_active,
          required_plan || "premium",
          packageNumValue,
          id,
        ],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "Package not found" });
      logAdminActivity(req, 'UPDATE', 'PAKET_TRYOUT', result.rows[0].title, `Memperbarui paket UTBK Tryout: ${result.rows[0].title}`);
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      if (
        error.code === "23505" &&
        error.constraint === "tryout_packages_title_key"
      ) {
        return res.status(409).json({
          success: false,
          error: `Judul "${title}" sudah digunakan. Gunakan judul yang berbeda.`,
        });
      }
      next(error);
    }
  },
);

// Delete package
router.delete(
  "/packages/:id",
  [verifyToken, verifyAdmin],
  async (req, res, next) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Delete registrations referencing this package (avoids check constraint violation on package_type checks)
      await client.query(
        "DELETE FROM tryout_registrations WHERE utbk_package_id = $1",
        [id],
      );

      // 2. Delete tryout sessions referencing this package (cascades to user_answers)
      await client.query("DELETE FROM tryout_sessions WHERE package_id = $1", [
        id,
      ]);

      // 3. Delete bookmarks referencing questions in this package
      await client.query(
        `DELETE FROM bookmarks WHERE question_id IN (SELECT id FROM questions WHERE tryout_package_id = $1)`,
        [id],
      );

      // 4. Delete user_answers referencing questions in this package (in case session cascade missed it)
      await client.query(
        `DELETE FROM user_answers WHERE question_id IN (SELECT id FROM questions WHERE tryout_package_id = $1)`,
        [id],
      );

      // 5. Delete questions under this package (this will cascade delete answer_choices)
      await client.query(`DELETE FROM questions WHERE tryout_package_id = $1`, [
        id,
      ]);

      // 6. Delete the package itself
      const result = await client.query(
        "DELETE FROM tryout_packages WHERE id = $1 RETURNING *",
        [id],
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Package not found" });
      }

      await client.query("COMMIT");
      logAdminActivity(req, 'DELETE', 'PAKET_TRYOUT', result.rows[0].title, `Menghapus paket UTBK Tryout: ${result.rows[0].title}`);
      res.json({
        success: true,
        message: "Package and its questions deleted successfully",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

// --- Tryout Registration System for Gratis Users ---

// Submit social media verification proof
router.post("/register", verifyToken, async (req, res, next) => {
  try {
    const {
      package_type,
      package_id,
      social_username,
      comment_link,
      platform,
      contact_email,
    } = req.body;

    if (
      !package_type ||
      !package_id ||
      !social_username ||
      !comment_link ||
      !platform ||
      !contact_email
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Data pendaftaran tidak lengkap. Isi username, link komentar, pilih platform, dan isi email.",
      });
    }

    if (!["utbk", "um"].includes(package_type)) {
      return res
        .status(400)
        .json({ success: false, error: "Tipe paket tidak valid." });
    }

    if (!["instagram", "x"].includes(platform)) {
      return res.status(400).json({
        success: false,
        error: "Platform tidak valid. Pilih Instagram atau X.",
      });
    }

    // Verify user is on a free plan
    const userRes = await pool.query(
      "SELECT current_plan FROM users WHERE id = $1",
      [req.user.id],
    );
    const currentPlan = userRes.rows[0]?.current_plan || "gratis";
    if (currentPlan === "premium" || currentPlan?.startsWith('utbk_')) {
      return res.status(400).json({
        success: false,
        error: "Pengguna Premium tidak memerlukan pendaftaran sosial media.",
      });
    }

    // Check if user has already completed this specific tryout package (free plan limit)
    const packageType = package_type;
    let packageDone = await isPackageCompleted(
      pool,
      req.user.id,
      packageType,
      package_id,
    );
    if (!packageDone && package_type === "um") {
      const sessionCompleted = await pool.query(
        "SELECT 1 FROM um_tryout_sessions WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NOT NULL LIMIT 1",
        [req.user.id, package_id],
      );
      packageDone = sessionCompleted.rows.length > 0;
    }

    if (packageDone) {
      return res.status(403).json({
        success: false,
        error:
          "Akun gratis hanya dapat mengerjakan setiap paket tryout sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
        code: "FREE_LIMIT_REACHED",
      });
    }

    // Check if already registered for this package
    const checkField =
      package_type === "utbk" ? "utbk_package_id" : "um_package_id";
    const check = await pool.query(
      `SELECT * FROM tryout_registrations WHERE user_id = $1 AND ${checkField} = $2`,
      [req.user.id, package_id],
    );

    if (check.rows.length > 0) {
      const existing = check.rows[0];
      if (existing.status === "pending") {
        return res.status(400).json({
          success: false,
          error: "Anda sudah mendaftar dan sedang menunggu verifikasi admin.",
        });
      } else if (existing.status === "approved") {
        return res.status(400).json({
          success: false,
          error: "Pendaftaran Anda sudah disetujui. Silakan mulai tryout.",
        });
      } else {
        // If rejected, delete and allow re-registration
        await pool.query("DELETE FROM tryout_registrations WHERE id = $1", [
          existing.id,
        ]);
      }
    }

    const utbkPackageId = package_type === "utbk" ? package_id : null;
    const umPackageId = package_type === "um" ? package_id : null;

    const result = await pool.query(
      `INSERT INTO tryout_registrations (user_id, contact_email, package_type, utbk_package_id, um_package_id, social_username, comment_link, platform, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [
        req.user.id,
        contact_email,
        package_type,
        utbkPackageId,
        umPackageId,
        social_username,
        comment_link,
        platform,
      ],
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Get registration status
router.get(
  "/registration-status/:packageType/:packageId",
  verifyToken,
  async (req, res, next) => {
    try {
      const { packageType, packageId } = req.params;
      if (!["utbk", "um"].includes(packageType)) {
        return res
          .status(400)
          .json({ success: false, error: "Tipe paket tidak valid." });
      }
      if (packageType === "utbk" && req.user && req.user.id) {
        await autoSubmitExpiredSessionsForUser(pool, req.user.id);
      }
      const checkField =
        packageType === "utbk" ? "utbk_package_id" : "um_package_id";
      const regResult = await pool.query(
        `SELECT status, rejection_reason FROM tryout_registrations WHERE user_id = $1 AND ${checkField} = $2`,
        [req.user.id, packageId],
      );
      const completed = await isPackageCompleted(
        pool,
        req.user.id,
        packageType,
        packageId,
      );
      let isCompleted = completed;
      if (!isCompleted && packageType === "um") {
        const sessionRes = await pool.query(
          "SELECT 1 FROM um_tryout_sessions WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NOT NULL LIMIT 1",
          [req.user.id, packageId],
        );
        isCompleted = sessionRes.rows.length > 0;
      }
      let target_ptn = null;
      let target_major = null;
      let completedSubtests = [];
      let activeSessions = {};
      let answeredCounts = {};

      let attemptInfo = null;
      if (packageType === "utbk") {
        const sessionTargetRes = await pool.query(
          "SELECT target_ptn, target_major FROM tryout_sessions WHERE user_id = $1 AND package_id = $2 AND target_ptn IS NOT NULL LIMIT 1",
          [req.user.id, packageId]
        );
        if (sessionTargetRes.rows.length > 0) {
          target_ptn = sessionTargetRes.rows[0].target_ptn;
          target_major = sessionTargetRes.rows[0].target_major;
        }

        attemptInfo = await getUtbkPackageAttemptInfo(pool, req.user.id, packageId);
        if (attemptInfo.completedAttempts >= 2) {
          isCompleted = true;
        }

        // Hydrate active attempt's subtests for multi-device/cache persistence
        const activeAttemptSessions = await pool.query(
          `SELECT ts.id, ts.submitted_at,
             (SELECT s.name FROM user_answers ua
              JOIN questions q ON ua.question_id = q.id
              LEFT JOIN subjects s ON q.subject_id = s.id
              WHERE ua.session_id = ts.id AND s.name IS NOT NULL
              GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 1) as subtest_name,
             (SELECT COUNT(*) FROM user_answers ua2
              WHERE ua2.session_id = ts.id AND (ua2.chosen_choice_id IS NOT NULL OR (ua2.answer_text IS NOT NULL AND ua2.answer_text != ''))) as answered_count
           FROM tryout_sessions ts
           WHERE ts.user_id = $1 AND ts.package_id = $2
             AND ts.started_at >= NOW() - INTERVAL '24 hours'
           ORDER BY ts.started_at ASC`,
          [req.user.id, packageId]
        );

        activeAttemptSessions.rows.forEach(r => {
          if (r.subtest_name) {
            activeSessions[r.subtest_name] = r.id;
            answeredCounts[r.subtest_name] = parseInt(r.answered_count || 0, 10);
            if (r.submitted_at) {
              completedSubtests.push(r.subtest_name);
            }
          }
        });
      }

      const responsePayload = {
        completed: isCompleted,
        target_ptn,
        target_major,
        completed_subtests: completedSubtests,
        active_sessions: activeSessions,
        answered_counts: answeredCounts,
        attempt_info: attemptInfo,
        completed_attempts: attemptInfo?.completedAttempts || 0,
        attempts_used: attemptInfo?.attemptsUsed || 0,
        max_attempts: 2,
        can_attempt: attemptInfo ? attemptInfo.canAttempt : true,
      };

      if (regResult.rows.length === 0) {
        return res.json({
          success: true,
          data: { status: null, ...responsePayload },
        });
      }
      res.json({
        success: true,
        data: { ...regResult.rows[0], ...responsePayload },
      });
    } catch (error) {
      next(error);
    }
  },
);

// Mark UTBK tryout package as completed (free users: 1 attempt per package)
router.post("/complete-package", verifyToken, async (req, res, next) => {
  try {
    const { package_type, package_id } = req.body;
    if (!package_type || !package_id) {
      return res.status(400).json({
        success: false,
        error: "package_type dan package_id wajib diisi.",
      });
    }
    if (!["utbk", "um"].includes(package_type)) {
      return res
        .status(400)
        .json({ success: false, error: "Tipe paket tidak valid." });
    }

    await markPackageCompleted(pool, req.user.id, package_type, package_id);
    res.json({ success: true, message: "Paket tryout ditandai selesai." });
  } catch (error) {
    next(error);
  }
});

// Get package completion status
router.get(
  "/package-completion/:packageType/:packageId",
  verifyToken,
  async (req, res, next) => {
    try {
      const { packageType, packageId } = req.params;
      if (!["utbk", "um"].includes(packageType)) {
        return res
          .status(400)
          .json({ success: false, error: "Tipe paket tidak valid." });
      }
      const completed = await isPackageCompleted(
        pool,
        req.user.id,
        packageType,
        packageId,
      );
      res.json({ success: true, data: { completed } });
    } catch (error) {
      next(error);
    }
  },
);

// Get usage counts (tryouts & latihan)
router.get("/my-tryout-usage", verifyToken, async (req, res, next) => {
  try {
    const utbkCompleted = await pool.query(
      "SELECT COUNT(*) as count FROM tryout_sessions WHERE user_id = $1 AND submitted_at IS NOT NULL",
      [req.user.id],
    );
    const umCompleted = await pool.query(
      "SELECT COUNT(*) as count FROM um_tryout_sessions WHERE user_id = $1 AND submitted_at IS NOT NULL",
      [req.user.id],
    );
    const totalTryouts =
      parseInt(utbkCompleted.rows[0].count) +
      parseInt(umCompleted.rows[0].count);

    const latihanCompleted = await pool.query(
      "SELECT COUNT(*) as count FROM latihan_sessions WHERE user_id = $1",
      [req.user.id],
    );
    const totalLatihan = parseInt(latihanCompleted.rows[0].count);

    res.json({
      success: true,
      data: {
        tryoutCount: totalTryouts,
        latihanCount: totalLatihan,
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- Student Simulation Endpoints ---

// Start Tryout Session
router.post("/start", verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { package_id, selected_subjects, target_ptn, target_major, is_first_subtest } = req.body;

    // ── Resume existing active session if available (prevents duplicate quota deduction) ──
    const selectedArray =
      Array.isArray(selected_subjects) && selected_subjects.length > 0
        ? selected_subjects
        : null;

    let existingSession;
    if (selectedArray) {
      const lowerSubjects = selectedArray.map((s) => s.toLowerCase());
      existingSession = await client.query(
        `SELECT ts.id, ts.started_at, COUNT(ua.id) as total_questions
         FROM tryout_sessions ts
         JOIN user_answers ua ON ua.session_id = ts.id
         JOIN questions q ON ua.question_id = q.id
         JOIN subjects s ON q.subject_id = s.id
         WHERE ts.user_id = $1 
           AND ts.package_id = $2 
           AND ts.submitted_at IS NULL
           AND LOWER(s.name) = ANY($3)
         GROUP BY ts.id
         ORDER BY ts.started_at DESC LIMIT 1`,
        [req.user.id, package_id, lowerSubjects],
      );
    } else {
      existingSession = await client.query(
        `SELECT ts.id, ts.started_at, COUNT(ua.id) as total_questions
         FROM tryout_sessions ts
         LEFT JOIN user_answers ua ON ua.session_id = ts.id
         WHERE ts.user_id = $1 AND ts.package_id = $2 AND ts.submitted_at IS NULL
         GROUP BY ts.id
         ORDER BY ts.started_at DESC LIMIT 1`,
        [req.user.id, package_id],
      );
    }

    if (
      existingSession.rows.length > 0 &&
      parseInt(existingSession.rows[0].total_questions) > 0
    ) {
      await client.query("COMMIT");
      return res.json({
        success: true,
        data: {
          session_id: existingSession.rows[0].id,
          total_questions: parseInt(existingSession.rows[0].total_questions),
          resumed: true,
        },
        message: "Resumed existing session",
      });
    }

    let quotaDeducted = false;
    let newQuotaRemaining = null;
    const isStudent = !req.user.role || req.user.role === 'student';

    if (isStudent) {
      // Check maximum 2x attempt limit for UTBK tryout package (for all users)
      const attemptInfo = await getUtbkPackageAttemptInfo(client, req.user.id, package_id);
      if (attemptInfo.completedAttempts >= 2) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          error: "Anda telah mencapai batas maksimal pengerjaan (2x) untuk paket tryout UTBK ini.",
          code: "MAX_ATTEMPTS_REACHED",
        });
      }

      // Check if user has an active subscription/access plan for UTBK (unlimited access)
      const activeUtbkRes = await client.query(
        `SELECT 1 FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > NOW())
           AND (p.target_type = 'utbk' OR p.target_type = 'all') AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
         LIMIT 1`,
        [req.user.id],
      );
      const hasUtbkUnlimited = activeUtbkRes.rows.length > 0;

      if (!hasUtbkUnlimited) {
        // Check if user has active tryout quota for UTBK (eceran / retail packages: 5x, 8x, 10x, etc.)
        const quotaRes = await client.query(
          `SELECT s.id, s.quota_remaining FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
           WHERE s.user_id = $1 AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > NOW())
             AND p.plan_type = 'quota' AND (p.target_type = 'utbk' OR p.target_type = 'all') AND s.quota_remaining > 0
           ORDER BY s.expires_at ASC NULLS LAST LIMIT 1`,
          [req.user.id],
        );

        if (quotaRes.rows.length > 0) {
          let shouldDeduct = false;

          if (is_first_subtest === true) {
            shouldDeduct = true;
          } else if (is_first_subtest === false) {
            shouldDeduct = false;
          } else {
            // 1. Get the latest completion timestamp for this user & package (if any)
            const lastCompletionRes = await client.query(
              `SELECT MAX(completed_at) as last_completed
               FROM tryout_package_completions
               WHERE user_id = $1 AND package_id = $2 AND package_type = 'utbk'`,
              [req.user.id, package_id],
            );
            const lastCompleted = lastCompletionRes.rows[0]?.last_completed;

            // 2. Check if this attempt has already started any subtest
            let existingAttemptSessions;
            if (lastCompleted) {
              existingAttemptSessions = await client.query(
                `SELECT 1 FROM tryout_sessions
                 WHERE user_id = $1 AND package_id = $2 AND started_at > $3 LIMIT 1`,
                [req.user.id, package_id, lastCompleted],
              );
            } else {
              existingAttemptSessions = await client.query(
                `SELECT 1 FROM tryout_sessions
                 WHERE user_id = $1 AND package_id = $2 AND started_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
                [req.user.id, package_id],
              );
            }

            shouldDeduct = existingAttemptSessions.rows.length === 0;
          }

          if (shouldDeduct) {
            // Deduct 1 tryout quota credit ONLY on the FIRST subtest of a package attempt
            const quota = quotaRes.rows[0];
            const updateQuotaRes = await client.query(
              `UPDATE subscriptions SET quota_remaining = quota_remaining - 1 WHERE id = $1 RETURNING quota_remaining`,
              [quota.id],
            );
            quotaDeducted = true;
            newQuotaRemaining = updateQuotaRes.rows[0]?.quota_remaining ?? (quota.quota_remaining - 1);
          }
        } else {
          // Free user flow: Auto submit any expired sessions for free user first
          await autoSubmitExpiredSessionsForUser(client, req.user.id);

          // Check start date (scheduled_at) and end date (end_date) window for Free users
          const pkgDateCheck = await client.query(
            "SELECT scheduled_at, end_date, required_plan FROM tryout_packages WHERE id = $1",
            [package_id]
          );
          if (pkgDateCheck.rows.length > 0) {
            const { scheduled_at, end_date, required_plan } = pkgDateCheck.rows[0];
            const now = new Date();
            const startDate = parseLocalDate(scheduled_at);
            const endDate = parseLocalDate(end_date);

            let isFreeNow = false;
            if (startDate && endDate) {
              isFreeNow = now >= startDate && now <= endDate;
            } else if (required_plan === 'gratis') {
              isFreeNow = true;
            }

            if (!isFreeNow) {
              await client.query("ROLLBACK");
              if (startDate && now < startDate) {
                return res.status(403).json({
                  success: false,
                  error: "Tryout ini belum dibuka sebagai tryout gratis. Upgrade ke Premium untuk akses kapan saja.",
                  code: "NOT_STARTED",
                });
              }
              return res.status(403).json({
                success: false,
                error: "Tenggat waktu tryout gratis telah berakhir dan kembali berstatus Premium. Upgrade ke Premium untuk akses penuh.",
                code: "EXPIRED",
              });
            }
          }

          // Check if this specific package has already been completed (one attempt per package for free users)
          let packageDone = await isPackageCompleted(
            client,
            req.user.id,
            "utbk",
            package_id,
          );

          if (packageDone) {
            await client.query("ROLLBACK");
            return res.status(403).json({
              success: false,
              error:
                "Akun gratis hanya dapat mengerjakan setiap paket tryout sebanyak 1 kali. Upgrade ke Premium untuk akses tanpa batas.",
              code: "FREE_LIMIT_REACHED",
            });
          }

          // Check if registration exists and is approved for this package
          const regRes = await client.query(
            "SELECT status FROM tryout_registrations WHERE user_id = $1 AND utbk_package_id = $2 AND status = 'approved'",
            [req.user.id, package_id],
          );

          if (regRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(403).json({
              success: false,
              error: "Pendaftaran tryout belum diverifikasi admin.",
              code: "NOT_VERIFIED",
            });
          }
        }
      }
    }

    // Ambil package + config
    const pkgRes = await client.query(
      "SELECT id, title, subject_config FROM tryout_packages WHERE id = $1",
      [package_id],
    );
    if (pkgRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, error: "Paket tryout tidak ditemukan" });
    }
    const pkg = pkgRes.rows[0];

    // Parse subject_config
    let subjectConfig = pkg.subject_config;
    if (typeof subjectConfig === "string") {
      try {
        subjectConfig = JSON.parse(subjectConfig);
      } catch {
        subjectConfig = [];
      }
    }
    if (!Array.isArray(subjectConfig)) subjectConfig = [];

    // Filter and reorder by selected subjects if provided

    if (selectedArray) {
      // Create a map for quick lookup
      const configMap = new Map();
      subjectConfig.forEach((sub) => {
        configMap.set((sub.name || "").toLowerCase(), sub);
      });

      // Reorder based on selected_subjects array (preserves user's chosen order)
      subjectConfig = selectedArray
        .map((name) => configMap.get(name.toLowerCase()))
        .filter(Boolean); // Remove undefined entries
    }

    // Lookup existing target PTN and Major if not provided
    let finalPtn = target_ptn || null;
    let finalMajor = target_major || null;
    if (!finalPtn || !finalMajor) {
      const existingTargetRes = await client.query(
        "SELECT target_ptn, target_major FROM tryout_sessions WHERE user_id = $1 AND package_id = $2 AND target_ptn IS NOT NULL LIMIT 1",
        [req.user.id, package_id]
      );
      if (existingTargetRes.rows.length > 0) {
        finalPtn = existingTargetRes.rows[0].target_ptn;
        finalMajor = existingTargetRes.rows[0].target_major;
      }
    }

    // Create Session
    const sessionRes = await client.query(
      "INSERT INTO tryout_sessions (user_id, package_id, target_ptn, target_major) VALUES ($1, $2, $3, $4) RETURNING id, started_at",
      [req.user.id, package_id, finalPtn, finalMajor],
    );
    const sessionId = sessionRes.rows[0].id;

    // Ambil soal berdasarkan subject_config (per mata pelajaran) dengan urutan yang sudah ditentukan
    let allQuestionIds = [];

    if (subjectConfig.length > 0) {
      for (const subCfg of subjectConfig) {
        const subjectName = subCfg.name;
        const questionCount = subCfg.questionCount || 20;

        // Cari subject_id berdasarkan nama
        const subjectRes = await client.query(
          "SELECT id FROM subjects WHERE LOWER(name) = LOWER($1) LIMIT 1",
          [subjectName],
        );

        if (subjectRes.rows.length > 0) {
          const subjectId = subjectRes.rows[0].id;
          // Only pick questions linked to this specific tryout package (no fallback to latihan)
          const linkedRes = await client.query(
            "SELECT id FROM questions WHERE subject_id = $1 AND tryout_package_id = $2 AND workflow_status = 'approved' ORDER BY display_order ASC, created_at ASC, id ASC LIMIT $3",
            [subjectId, package_id, questionCount],
          );
          let subQuestionIds = linkedRes.rows.map((q) => q.id);
          // Append to allQuestionIds in order (maintains subject order)
          allQuestionIds = allQuestionIds.concat(subQuestionIds);
        }
      }
    }

    if (allQuestionIds.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error:
          "Belum ada soal tryout untuk paket ini. Admin perlu menambahkan soal tryout terlebih dahulu.",
      });
    }

    // Insert user_answers with order preserved (using position to maintain order)
    for (let i = 0; i < allQuestionIds.length; i++) {
      await client.query(
        "INSERT INTO user_answers (session_id, question_id, position) VALUES ($1, $2, $3)",
        [sessionId, allQuestionIds[i], i + 1],
      );
    }

    await client.query("COMMIT");
    res.json({
      success: true,
      data: {
        session_id: sessionId,
        total_questions: allQuestionIds.length,
        quota_deducted: quotaDeducted,
        quota_remaining: newQuotaRemaining,
      },
      message: "Session started",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// Get Questions for Session
router.get(
  "/session/:sessionId/questions",
  verifyToken,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;

      // Check if session exists and belongs to user
      const sessionCheck = await pool.query(
        "SELECT id, started_at FROM tryout_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, req.user.id],
      );

      if (sessionCheck.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Session not found or unauthorized" });
      }

      // Get subject_config from session to know the subject order
      const sessionData = await pool.query(
        `SELECT ts.package_id, ts.started_at, tp.subject_config
       FROM tryout_sessions ts
       JOIN tryout_packages tp ON ts.package_id = tp.id
       WHERE ts.id = $1`,
        [sessionId],
      );

      let subjectConfig = [];
      if (sessionData.rows.length > 0) {
        const config = sessionData.rows[0].subject_config;
        if (typeof config === "string") {
          try {
            subjectConfig = JSON.parse(config);
          } catch {
            subjectConfig = [];
          }
        } else if (Array.isArray(config)) {
          subjectConfig = config;
        }
      }

      // Get all questions for this session, ordered by position to preserve question order
      // Include saved user answers for state restoration (handles localStorage loss)
      const result = await pool.query(
        `
      SELECT q.id, q.content, q.image_url, q.image_position, q.difficulty, q.question_type, q.stimulus,
             s.name as subject_name, s.id as subject_id, ua.position,
             ua.chosen_choice_id, ua.is_flagged, ua.answer_text
      FROM user_answers ua
      JOIN questions q ON ua.question_id = q.id
      LEFT JOIN subjects s ON q.subject_id = s.id
      WHERE ua.session_id = $1
      ORDER BY ua.position ASC
    `,
        [sessionId],
      );

      // Get answer choices for each question (preserve original A, B, C, D, E order from admin)
      const enrichedResult = await pool.query(
        `
      SELECT ac.question_id, ac.id, ac.label, ac.content
      FROM answer_choices ac
      JOIN user_answers ua ON ac.question_id = ua.question_id
      WHERE ua.session_id = $1
      ORDER BY ac.label ASC
    `,
        [sessionId],
      );

      // Build choices map by question_id
      const choicesMap = {};
      enrichedResult.rows.forEach((row) => {
        if (!choicesMap[row.question_id]) choicesMap[row.question_id] = [];
        choicesMap[row.question_id].push(row);
      });

      // Attach choices in original order (no runtime shuffle)
      result.rows.forEach((q) => {
        const rawChoices = choicesMap[q.id] || [];
        q.choices = rawChoices; // keep original A, B, C, D, E order
      });

      // Group questions by subject_name to preserve subject boundaries
      const subjectGroups = {};
      result.rows.forEach((q) => {
        const key = q.subject_name || "Unknown";
        if (!subjectGroups[key]) subjectGroups[key] = [];
        subjectGroups[key].push(q);
      });

      // Build structured response with subject boundaries (case-insensitive match)
      const subjectsWithQuestions = subjectConfig
        .map((cfg) => {
          let questions = subjectGroups[cfg.name] || [];
          // Fallback: case-insensitive match if exact match fails
          if (questions.length === 0) {
            const lowerName = (cfg.name || "").toLowerCase().trim();
            for (const [k, v] of Object.entries(subjectGroups)) {
              if ((k || "").toLowerCase().trim() === lowerName) {
                questions = v;
                break;
              }
            }
          }
          return {
            name: cfg.name,
            questionCount: questions.length,
            duration: cfg.durationMin || 30,
            durationSec: cfg.durationSec || 0,
            questions: questions,
          };
        })
        .filter((sub) => sub.questions.length > 0);

      res.json({
        success: true,
        data: subjectsWithQuestions,
        started_at: sessionData.rows[0]?.started_at || null,
        server_time: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error getting questions:", error);
      next(error);
    }
  },
);

// Save Answer
router.post("/answer", verifyToken, async (req, res, next) => {
  try {
    const {
      session_id,
      question_id,
      chosen_choice_id,
      is_flagged,
      time_spent_sec,
      answer_text,
    } = req.body;

    if (!session_id || !question_id) {
      return res.status(400).json({ success: false, error: "session_id and question_id required" });
    }

    // Verify session belongs to user and is not submitted
    const sessionCheck = await pool.query(
      `SELECT id FROM tryout_sessions WHERE id = $1 AND user_id = $2 AND submitted_at IS NULL`,
      [session_id, req.user.id]
    );
    if (sessionCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: "Akses ditolak atau sesi tryout telah dikumpulkan." });
    }

    // Check if session time has expired (+ 5 minutes grace period for network latency)
    const durationInfo = await getSessionAllocatedDurationSec(pool, session_id);
    if (durationInfo) {
      const elapsedSec = (Date.now() - durationInfo.started_at.getTime()) / 1000;
      if (elapsedSec > durationInfo.totalAllocatedSec + 300) {
        return res.status(400).json({
          success: false,
          error: "Waktu pengerjaan tryout telah habis. Jawaban tidak dapat disimpan.",
          code: "SESSION_EXPIRED",
        });
      }
    }

    await pool.query(
      `UPDATE user_answers
       SET chosen_choice_id = $1,
           is_flagged = COALESCE($2, is_flagged),
           time_spent_sec = time_spent_sec + COALESCE($3, 0),
           answer_text = $6
       WHERE session_id = $4 AND question_id = $5`,
      [
        chosen_choice_id,
        is_flagged,
        time_spent_sec,
        session_id,
        question_id,
        answer_text || null,
      ],
    );
    res.json({ success: true, message: "Answer saved" });
  } catch (error) {
    next(error);
  }
});

// Save Answers in Batch (single request for all answers)
router.post("/answer-batch", verifyToken, async (req, res, next) => {
  const { session_id, answers } = req.body;
  if (!session_id || !Array.isArray(answers) || answers.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "session_id and answers array required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify session belongs to user and is not submitted
    const sessionCheck = await client.query(
      `SELECT id FROM tryout_sessions WHERE id = $1 AND user_id = $2 AND submitted_at IS NULL`,
      [session_id, req.user.id]
    );
    if (sessionCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, error: "Akses ditolak atau sesi tryout telah dikumpulkan." });
    }

    // Check if session time has expired (+ 5 minutes grace period for network latency)
    const durationInfo = await getSessionAllocatedDurationSec(client, session_id);
    if (durationInfo) {
      const elapsedSec = (Date.now() - durationInfo.started_at.getTime()) / 1000;
      if (elapsedSec > durationInfo.totalAllocatedSec + 300) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: "Waktu pengerjaan tryout telah habis. Jawaban tidak dapat disimpan.",
          code: "SESSION_EXPIRED",
        });
      }
    }

    for (const ans of answers) {
      const {
        question_id,
        chosen_choice_id,
        is_flagged,
        time_spent_sec,
        answer_text,
      } = ans;
      if (!question_id) continue;
      await client.query(
        `UPDATE user_answers
         SET chosen_choice_id = $1,
             is_flagged = COALESCE($2, is_flagged),
             time_spent_sec = time_spent_sec + COALESCE($3, 0),
             answer_text = $6
         WHERE session_id = $4 AND question_id = $5`,
        [
          chosen_choice_id ?? null,
          is_flagged ?? false,
          time_spent_sec || 0,
          session_id,
          question_id,
          answer_text ?? null,
        ],
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, message: `${answers.length} answers saved` });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// Get Tryout Result
router.get("/result/:sessionId", verifyToken, async (req, res, next) => {
  const { sessionId } = req.params;
  console.log("[GET RESULT] Starting for session:", sessionId);

  try {
    // Validate sessionId is a valid UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(sessionId)) {
      console.log("[GET RESULT] Invalid UUID format");
      return res
        .status(400)
        .json({ success: false, error: "Invalid session ID format" });
    }

    console.log("[GET RESULT] User ID from token:", req.user.id);

    // Get session with package info
    let session;
    try {
      console.log("[GET RESULT] Querying session...");
      const sessionRes = await pool.query(
        `
        SELECT ts.*, tp.title, tp.subject_config
        FROM tryout_sessions ts
        JOIN tryout_packages tp ON ts.package_id = tp.id
        WHERE ts.id = $1 AND ts.user_id = $2
      `,
        [sessionId, req.user.id],
      );

      console.log(
        "[GET RESULT] Session query returned:",
        sessionRes.rows.length,
        "rows",
      );

      if (sessionRes.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Session not found" });
      }

      session = sessionRes.rows[0];
      console.log(
        "[GET RESULT] Session found, submitted_at:",
        session.submitted_at,
      );
    } catch (dbError) {
      console.error("[GET RESULT] Database query error:", dbError);
      return res
        .status(500)
        .json({ success: false, error: "Gagal mengambil data hasil tryout." });
    }

    if (!session.submitted_at) {
      if (session.end_date && new Date(session.end_date) < new Date()) {
        const activeUtbkRes = await pool.query(
          `SELECT 1 FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
           WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
             AND (p.target_type = 'utbk' OR p.target_type = 'all') AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
           LIMIT 1`,
          [req.user.id]
        );
        if (activeUtbkRes.rows.length === 0) {
          await autoSubmitSession(pool, sessionId, req.user.id);
          const reFetchRes = await pool.query(
            `SELECT ts.*, tp.title, tp.subject_config
             FROM tryout_sessions ts
             JOIN tryout_packages tp ON ts.package_id = tp.id
             WHERE ts.id = $1 AND ts.user_id = $2`,
            [sessionId, req.user.id]
          );
          if (reFetchRes.rows.length > 0 && reFetchRes.rows[0].submitted_at) {
            session = reFetchRes.rows[0];
          }
        }
      }
    }

    if (!session.submitted_at) {
      return res
        .status(400)
        .json({ success: false, error: "Tryout belum disubmit" });
    }

    // Find all sessions belonging to the SAME ATTEMPT as this session
    let relatedSessionIds = [sessionId];
    try {
      const allPkgSessionsRes = await pool.query(
        `SELECT
           ts.id,
           ts.started_at,
           (
             SELECT s.name
             FROM user_answers ua
             JOIN questions q ON ua.question_id = q.id
             LEFT JOIN subjects s ON q.subject_id = s.id
             WHERE ua.session_id = ts.id AND s.name IS NOT NULL
             GROUP BY s.name
             ORDER BY COUNT(*) DESC
             LIMIT 1
           ) AS subtest_name
         FROM tryout_sessions ts
         WHERE ts.user_id = $1 AND ts.package_id = $2 AND ts.submitted_at IS NOT NULL
         ORDER BY ts.started_at ASC`,
        [req.user.id, session.package_id]
      );

      const groups = [];
      let currentGroup = null;

      allPkgSessionsRes.rows.forEach((row) => {
        const subtest = row.subtest_name || "Unknown";
        const startedAt = new Date(row.started_at);

        const timeSinceLast = currentGroup
          ? (startedAt - new Date(currentGroup.latestStartedAt)) / 3600000
          : Infinity;
        const subtestAlreadyUsed = currentGroup && currentGroup.subtestSet.has(subtest);

        if (!currentGroup || subtestAlreadyUsed || timeSinceLast > 12) {
          currentGroup = {
            subtestSet: new Set(),
            latestStartedAt: row.started_at,
            sessionIds: [],
          };
          groups.push(currentGroup);
        }

        currentGroup.sessionIds.push(row.id);
        currentGroup.subtestSet.add(subtest);
        currentGroup.latestStartedAt = row.started_at;
      });

      let subjectConfig = session.subject_config;
      if (typeof subjectConfig === "string") {
        try { subjectConfig = JSON.parse(subjectConfig); } catch { subjectConfig = []; }
      }
      const totalSubtests = Array.isArray(subjectConfig) && subjectConfig.length > 0 ? subjectConfig.length : 7;

      const matchingGroup = groups.find((g) => g.sessionIds.includes(sessionId));
      if (matchingGroup && matchingGroup.sessionIds.length >= totalSubtests) {
        relatedSessionIds = matchingGroup.sessionIds;
      } else {
        // If the requested session belongs to an incomplete attempt, use the completed attempt
        const completedGroup = groups.filter(g => g.sessionIds.length >= totalSubtests);
        if (completedGroup.length > 0) {
          relatedSessionIds = completedGroup[completedGroup.length - 1].sessionIds;
        } else if (matchingGroup) {
          relatedSessionIds = matchingGroup.sessionIds;
        }
      }
    } catch (e) {
      console.error("[GET RESULT] Error finding related sessions:", e);
    }

    // Parse score breakdown safely
    let scoreBreakdown = {};
    try {
      if (session.score_breakdown) {
        if (typeof session.score_breakdown === "string") {
          try {
            scoreBreakdown = JSON.parse(session.score_breakdown);
          } catch (e) {
            scoreBreakdown = {};
          }
        } else if (typeof session.score_breakdown === "object") {
          scoreBreakdown = session.score_breakdown;
        }
      }
    } catch (e) {
      console.error("Error parsing score_breakdown:", e);
      scoreBreakdown = {};
    }

    // Parse subject config safely
    let subjectConfig = [];
    try {
      if (session.subject_config) {
        if (typeof session.subject_config === "string") {
          try {
            subjectConfig = JSON.parse(session.subject_config);
          } catch (e) {
            subjectConfig = [];
          }
        } else if (Array.isArray(session.subject_config)) {
          subjectConfig = session.subject_config;
        }
      }
    } catch (e) {
      console.error("Error parsing subject_config:", e);
      subjectConfig = [];
    }

    // Get all questions with user's answers
    let questions = [];
    try {
      const questionsRes = await pool.query(
        `
        SELECT
          q.id,
          q.content,
          q.image_url,
          q.image_position,
          q.difficulty,
          q.question_type,
          q.stimulus,
          COALESCE(s.name, 'Unknown') as subject_name,
          ua.chosen_choice_id,
          ua.answer_text,
          COALESCE(ua.is_flagged, false) as is_flagged,
          COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
          (
            SELECT json_agg(json_build_object(
              'id', ac.id,
              'label', ac.label,
              'content', ac.content,
              'is_correct', COALESCE(ac.is_correct, false),
              'explanation', ac.explanation
            ) ORDER BY ac.label)
            FROM answer_choices ac
            WHERE ac.question_id = q.id
          ) as choices
        FROM user_answers ua
        JOIN questions q ON ua.question_id = q.id
        LEFT JOIN subjects s ON q.subject_id = s.id
        WHERE ua.session_id = ANY($1)
        ORDER BY ua.session_id, ua.position ASC
      `,
        [relatedSessionIds],
      );

      // Fetch empirical stats for these questions
      const questionIds = questionsRes.rows.map(q => q.id).filter(Boolean);
      const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);

      // Process questions and group by subject
      questions = questionsRes.rows.map((q) => {
        // Ensure choices is always an array
        let choices = q.choices;
        if (!Array.isArray(choices)) {
          choices = [];
        }

        const isShortAnswer = q.question_type === "short_answer";
        const isComplex = q.question_type === "complex_mc_tf";

        // Find user's answer label
        let userAnswerLabel = null;
        if (isShortAnswer || isComplex) {
          userAnswerLabel = q.answer_text || null;
        } else if (q.chosen_choice_id) {
          const chosenChoice = choices.find((c) => c.id === q.chosen_choice_id);
          if (chosenChoice) {
            userAnswerLabel = chosenChoice.label;
          }
        }

        // Find correct answer label and its explanation
        let correctAnswerLabel = null;
        let questionExplanation = null;
        if (isComplex) {
          const correctObj = {};
          choices.forEach((c) => {
            correctObj[c.label] = c.is_correct === true;
          });
          correctAnswerLabel = JSON.stringify(correctObj);
          questionExplanation = choices.find((c) => c.explanation)?.explanation || null;
        } else {
          const correctChoice = choices.find((c) => c.is_correct === true);
          if (correctChoice) {
            correctAnswerLabel = isShortAnswer
              ? correctChoice.content
              : correctChoice.label;
            questionExplanation = correctChoice.explanation;
          }
        }

        // Evaluate correctness
        let isCorrect = false;
        if (isShortAnswer) {
          const correctChoice = choices.find((c) => c.is_correct === true);
          isCorrect = !!(
            correctChoice &&
            q.answer_text &&
            correctChoice.content.trim().toLowerCase() ===
              q.answer_text.trim().toLowerCase()
          );
        } else if (isComplex) {
          let userAnswersObj = {};
          try {
            userAnswersObj = q.answer_text ? JSON.parse(q.answer_text) : {};
          } catch (e) {}
          isCorrect = choices.length > 0 && choices.every((c) => {
            const studentAns = userAnswersObj[c.label];
            return studentAns !== undefined && studentAns === c.is_correct;
          });
        } else {
          isCorrect = q.chosen_choice_id
            ? choices.find((c) => c.id === q.chosen_choice_id)?.is_correct ===
              true
            : false;
        }

        return {
          id: q.id,
          questionNumber: 0, // Will be set later
          content: q.content,
          imageUrl: q.image_url,
          image_position: q.image_position,
          difficulty: q.difficulty,
          question_type: q.question_type || "multiple_choice",
          subject: q.subject_name,
          isCorrect: isCorrect,
          isFlagged: q.is_flagged,
          userAnswer: userAnswerLabel,
          correctAnswer: correctAnswerLabel,
          explanation: questionExplanation,
          timeSpentSec: q.time_spent_sec || 0,
          choices: choices,
          stimulus: q.stimulus,
          irtStats: itemStatsMap[q.id] || null,
        };
      });
    } catch (qError) {
      console.error("Error fetching questions:", qError);
      // Continue with empty questions array
    }

    // Assign question numbers and group by subject
    let questionNumber = 1;
    const subjectMap = new Map();
    questions.forEach((q) => {
      q.questionNumber = questionNumber++;

      // Group by subject for breakdown
      const subjectKey = q.subject;
      if (!subjectMap.has(subjectKey)) {
        subjectMap.set(subjectKey, {
          name: subjectKey,
          correct: 0,
          total: 0,
          questions: [],
        });
      }
      const subjectData = subjectMap.get(subjectKey);
      subjectData.total++;
      if (q.isCorrect) subjectData.correct++;
      subjectData.questions.push(q);
    });

    // === STATIC / FIXED SCORING ===
    // Use stored score if already computed and saved in tryout_sessions (score never changes!)
    let liveIRT;
    if (session.total_score !== null && session.total_score !== undefined && session.score_breakdown) {
      try {
        let storedBreakdown = session.score_breakdown;
        if (typeof storedBreakdown === "string") {
          storedBreakdown = JSON.parse(storedBreakdown);
        }
        if (storedBreakdown && typeof storedBreakdown === "object" && storedBreakdown.totalScore !== undefined) {
          liveIRT = storedBreakdown;
        }
      } catch (e) {
        console.error("[GET RESULT] Failed to parse stored score_breakdown:", e);
      }
    }

    if (!liveIRT) {
      try {
        const rawAnswersRes = await pool.query(
          `
          SELECT
            ua.chosen_choice_id,
            ua.answer_text,
            COALESCE(ac.is_correct, false) as is_correct,
            ua.question_id,
            COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
            COALESCE(q.difficulty, 'medium') as difficulty,
            COALESCE(q.question_type, 'multiple_choice') as question_type,
            COALESCE(s.name, 'Unknown') as subject_name
          FROM user_answers ua
          LEFT JOIN answer_choices ac ON ua.chosen_choice_id = ac.id
          LEFT JOIN questions q ON ua.question_id = q.id
          LEFT JOIN subjects s ON q.subject_id = s.id
          WHERE ua.session_id = ANY($1)
        `,
          [relatedSessionIds],
        );

        for (const ans of rawAnswersRes.rows) {
          if (ans.question_type === "short_answer" && ans.answer_text) {
            const correctRes = await pool.query(
              `SELECT content FROM answer_choices WHERE question_id = $1 AND is_correct = true LIMIT 1`,
              [ans.question_id],
            );
            if (correctRes.rows.length > 0) {
              ans.is_correct =
                correctRes.rows[0].content.trim().toLowerCase() ===
                ans.answer_text.trim().toLowerCase();
            }
          } else if (ans.question_type === "complex_mc_tf") {
            const choicesRes = await pool.query(
              `SELECT label, is_correct FROM answer_choices WHERE question_id = $1`,
              [ans.question_id],
            );
            let userAnswersObj = {};
            try {
              userAnswersObj = ans.answer_text ? JSON.parse(ans.answer_text) : {};
            } catch (e) {}
            ans.is_correct = choicesRes.rows.length > 0 && choicesRes.rows.every((c) => {
              const studentAns = userAnswersObj[c.label];
              return studentAns !== undefined && studentAns === c.is_correct;
            });
          }
        }

        const irtAnswers = rawAnswersRes.rows.map((ans) => ({
          chosen_choice_id: ans.chosen_choice_id,
          is_correct: ans.is_correct === true,
          question_id: ans.question_id,
          difficulty: ans.difficulty || "medium",
          subject_name: ans.subject_name,
          time_spent_sec: ans.time_spent_sec || 0,
          question_type: ans.question_type,
          answer_text: ans.answer_text,
          irtParams: itemStatsMap[ans.question_id] || undefined,
        }));
        liveIRT = calculateIRTScore(irtAnswers);
        liveIRT.calibrationInfo = {
          totalCalibrated: questionIds.filter(id => itemStatsMap[id]?.calibrated).length,
          totalPartial: questionIds.filter(id => itemStatsMap[id]?.calibrated === 'partial').length,
          totalDefault: questionIds.filter(id => !itemStatsMap[id] || !itemStatsMap[id].calibrated).length,
        };
      } catch (irtErr) {
        console.error(
          "[GET RESULT] IRT recompute failed, using stored:",
          irtErr.message,
        );
        liveIRT = scoreBreakdown || {
          totalScore: session.total_score || 200,
          theta: 0,
          percentile: 0,
          subjectScores: {},
        };
      }
    }

    // Canonical UTBK subject order
    const UTBK_ORDER = [
      "penalaran umum",
      "pengetahuan dan pemahaman umum",
      "pemahaman bacaan dan tulisan",
      "pengetahuan kuantitatif",
      "literasi bahasa indonesia",
      "literasi bahasa inggris",
      "penalaran matematika",
    ];

    // Helper: find subjectConfig entry by case-insensitive name match
    const findConfig = (name) => {
      if (!subjectConfig.length) return {};
      const lower = (name || "").toLowerCase().trim();
      return (
        subjectConfig.find(
          (c) => (c.name || "").toLowerCase().trim() === lower,
        ) || {}
      );
    };

    // Helper: find IRT subject score by case-insensitive partial match
    const findIRTSubject = (name) => {
      if (!liveIRT.subjectScores) return null;
      // Exact match first
      if (liveIRT.subjectScores[name]) return liveIRT.subjectScores[name];
      // Case-insensitive match
      const lower = (name || "").toLowerCase().trim();
      for (const [k, v] of Object.entries(liveIRT.subjectScores)) {
        if ((k || "").toLowerCase().trim() === lower) return v;
      }
      // Partial match (e.g. "Penalaran Umum" matches key containing "penalaran umum")
      for (const [k, v] of Object.entries(liveIRT.subjectScores)) {
        const kl = (k || "").toLowerCase().trim();
        if (kl.includes(lower) || lower.includes(kl)) return v;
      }
      return null;
    };

    // Sort subject names in canonical UTBK order
    const subjectNames = Array.from(subjectMap.keys()).sort((a, b) => {
      const aLower = (a || "").toLowerCase().trim();
      const bLower = (b || "").toLowerCase().trim();
      let aIdx = UTBK_ORDER.findIndex(
        (o) => aLower.includes(o) || o.includes(aLower),
      );
      let bIdx = UTBK_ORDER.findIndex(
        (o) => bLower.includes(o) || o.includes(bLower),
      );
      if (aIdx === -1) aIdx = 999;
      if (bIdx === -1) bIdx = 999;
      return aIdx - bIdx;
    });

    // Build subject array
    const subjects = [];
    subjectNames.forEach((subjectName) => {
      const cfg = findConfig(subjectName);
      const data = subjectMap.get(subjectName) || {
        correct: 0,
        total: 0,
        questions: [],
      };

      const percentage =
        data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0;
      let totalTimeSpent = data.questions.reduce(
        (sum, q) => sum + (q.timeSpentSec || 0),
        0,
      );

      // Fallback if totalTimeSpent is 0 (e.g. older sessions or untracked questions)
      if (totalTimeSpent === 0) {
        if (session?.started_at && session?.submitted_at) {
          const sessionDur = Math.max(0, Math.round((new Date(session.submitted_at).getTime() - new Date(session.started_at).getTime()) / 1000));
          if (sessionDur > 0) totalTimeSpent = sessionDur;
        }
        if (totalTimeSpent === 0 && (cfg.duration || cfg.durationMin)) {
          totalTimeSpent = ((cfg.duration || cfg.durationMin) * 60) + (cfg.durationSec || 0);
        } else if (totalTimeSpent === 0 && data.total > 0) {
          totalTimeSpent = data.total * 75; // ~1.25 min per question standard pace
        }
      }

      const avgSpeed =
        data.questions.length > 0
          ? Math.round(totalTimeSpent / data.questions.length)
          : 0;

      const irtSubject = findIRTSubject(subjectName);
      const statusInfo = getStatusFromMastery(percentage, avgSpeed);

      subjects.push({
        name: subjectName,
        shortName: cfg.shortName || subjectName,
        score: irtSubject ? irtSubject.score : 0,
        percentage,
        correct: data.correct,
        total: data.total,
        avgSpeed,
        totalTimeSpent,
        status: irtSubject?.status || statusInfo.status,
        statusColor: irtSubject?.statusColor || statusInfo.statusColor,
        mastery: percentage,
        theta: irtSubject?.theta ? Math.round(irtSubject.theta * 100) / 100 : 0,
        description: irtSubject?.description || statusInfo.description,
      });
    });

    // Stats calculated directly from questions array — always accurate
    const totalCorrectFromQ = questions.filter((q) => q.isCorrect).length;
    const avgPercentage =
      questions.length > 0
        ? Math.round((totalCorrectFromQ / questions.length) * 100)
        : 0;

    // Real-time IRT outputs
    const totalScore = liveIRT.totalScore;
    const theta = liveIRT.theta;
    const percentile = liveIRT.percentile;

    // Persist only if not already saved in database (prevents score from changing over time)
    try {
      if ((session.total_score === null || session.total_score === undefined) && typeof totalScore === "number" && !isNaN(totalScore)) {
        await pool.query(
          `UPDATE tryout_sessions SET total_score = $1, score_breakdown = $2 WHERE id = $3`,
          [totalScore, JSON.stringify(liveIRT), sessionId],
        );
      }
    } catch (err) {
      console.error("[GET RESULT] Failed to persist IRT:", err.message);
    }

    // Compare against previous score (if any) for "scoreChange"
    let scoreChange = 0;
    try {
      const prevRes = await pool.query(
        `SELECT total_score FROM tryout_sessions
         WHERE user_id = $1 AND submitted_at IS NOT NULL AND id <> $2
         ORDER BY submitted_at DESC LIMIT 1`,
        [req.user.id, sessionId],
      );
      const prevScore = prevRes.rows[0]?.total_score;
      if (prevScore) {
        scoreChange = Math.round(((totalScore - prevScore) / prevScore) * 100);
      }
    } catch (e) {
      // ignore
    }

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        packageId: session.package_id,
        title: session.title || "Tryout",
        subtitle: session.started_at
          ? new Date(session.started_at).toLocaleDateString("id-ID", {
              year: "numeric",
              month: "long",
            })
          : "",
        totalScore,
        theta,
        percentile,
        scoreChange,
        targetPassingGrade: avgPercentage,
        scoreBreakdown: liveIRT,
        scoringMethod: "IRT-3PL (real-time)",
        computedAt: new Date().toISOString(),
        subjects: subjects.length > 0 ? subjects : [],
        questions: questions.length > 0 ? questions : [],
        stats: {
          correct: totalCorrectFromQ,
          incorrect: questions.filter(
            (q) => q.userAnswer !== null && !q.isCorrect,
          ).length,
          unanswered: questions.filter((q) => q.userAnswer === null).length,
          total: questions.length,
        },
      },
    });
  } catch (error) {
    console.error("Error in get result:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Get Combined Tryout Result (aggregates multiple per-subtest sessions)
router.post("/result/combined", verifyToken, async (req, res, next) => {
  const { session_ids, package_id } = req.body;

  let querySessionIds = Array.isArray(session_ids) && session_ids.length > 0 ? session_ids : [];

  if (package_id) {
    // Fetch all submitted sessions with subtest info and package subject_config for attempt grouping
    const userPkgSessions = await pool.query(
      `SELECT ts.id, ts.started_at, tp.subject_config,
         (SELECT s.name FROM user_answers ua
          JOIN questions q ON ua.question_id = q.id
          LEFT JOIN subjects s ON q.subject_id = s.id
          WHERE ua.session_id = ts.id AND s.name IS NOT NULL
          GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 1
         ) AS subtest_name
       FROM tryout_sessions ts
       JOIN tryout_packages tp ON ts.package_id = tp.id
       WHERE ts.package_id = $1 AND ts.user_id = $2 AND ts.submitted_at IS NOT NULL
       ORDER BY ts.started_at ASC`,
      [package_id, req.user.id]
    );

    if (userPkgSessions.rows.length > 0) {
      let subjectConfig = userPkgSessions.rows[0].subject_config;
      if (typeof subjectConfig === "string") {
        try {
          subjectConfig = JSON.parse(subjectConfig);
        } catch {
          subjectConfig = [];
        }
      }
      const totalSubtests = Array.isArray(subjectConfig) && subjectConfig.length > 0 ? subjectConfig.length : 7;

      const groups = [];
      let currentGroup = null;
      userPkgSessions.rows.forEach((row) => {
        const subtest = row.subtest_name || 'Unknown';
        const startedAt = new Date(row.started_at);
        const timeSinceLast = currentGroup
          ? (startedAt - new Date(currentGroup.latestStartedAt)) / 3600000
          : Infinity;
        const subtestAlreadyUsed = currentGroup && currentGroup.subtestSet.has(subtest);

        if (!currentGroup || subtestAlreadyUsed || timeSinceLast > 12) {
          currentGroup = {
            subtestSet: new Set(),
            latestStartedAt: row.started_at,
            sessionIds: [],
          };
          groups.push(currentGroup);
        }
        currentGroup.sessionIds.push(row.id);
        currentGroup.subtestSet.add(subtest);
        currentGroup.latestStartedAt = row.started_at;
      });

      if (querySessionIds.length === 0) {
        // Find latest COMPLETED attempt group (where all subtests are done)
        const completedGroups = groups.filter(g => g.sessionIds.length >= totalSubtests);
        if (completedGroups.length > 0) {
          querySessionIds = completedGroups[completedGroups.length - 1].sessionIds;
        } else {
          // If none completed, pick the group with the most subtests or the latest
          const sortedByCount = [...groups].sort((a, b) => b.sessionIds.length - a.sessionIds.length);
          querySessionIds = sortedByCount[0]?.sessionIds || groups[groups.length - 1].sessionIds;
        }
      } else if (querySessionIds.length === 1) {
        // If a single sessionId was passed, expand to its matching attempt group if it has multiple subtests
        const matchingGroup = groups.find(g => g.sessionIds.includes(querySessionIds[0]));
        if (matchingGroup && matchingGroup.sessionIds.length > 1) {
          querySessionIds = matchingGroup.sessionIds;
        }
      }
    }
  }

  if (querySessionIds.length === 0) {
    return res
      .status(404)
      .json({ success: false, error: "Belum ada sesi tryout yang diselesaikan untuk paket ini" });
  }

  try {
    // Verify all sessions belong to this user and are submitted
    const sessionsRes = await pool.query(
      `
      SELECT ts.id, ts.started_at, ts.submitted_at, ts.package_id, tp.title, tp.subject_config
      FROM tryout_sessions ts
      JOIN tryout_packages tp ON ts.package_id = tp.id
      WHERE ts.id = ANY($1) AND ts.user_id = $2
    `,
      [querySessionIds, req.user.id],
    );

    if (sessionsRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "No valid sessions found" });
    }

    // Get package info from first session or from package_id
    const pkgTitle = sessionsRes.rows[0].title || "Tryout";

    // Parse subject_config
    let subjectConfig = sessionsRes.rows[0].subject_config;
    if (typeof subjectConfig === "string") {
      try {
        subjectConfig = JSON.parse(subjectConfig);
      } catch {
        subjectConfig = [];
      }
    }
    if (!Array.isArray(subjectConfig)) subjectConfig = [];

    // Get ALL questions+answers across all sessions
    const validSessionIds = sessionsRes.rows.map((s) => s.id);
    const questionsRes = await pool.query(
      `
      SELECT
        q.id,
        q.content,
        q.image_url,
        q.image_position,
        q.difficulty,
        q.question_type,
        q.stimulus,
        COALESCE(s.name, 'Unknown') as subject_name,
        ua.chosen_choice_id,
        ua.answer_text,
        COALESCE(ua.is_flagged, false) as is_flagged,
        COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
        ua.session_id,
        (
          SELECT json_agg(json_build_object(
            'id', ac.id,
            'label', ac.label,
            'content', ac.content,
            'is_correct', COALESCE(ac.is_correct, false),
            'explanation', ac.explanation
          ) ORDER BY ac.label)
          FROM answer_choices ac
          WHERE ac.question_id = q.id
        ) as choices
      FROM user_answers ua
      JOIN questions q ON ua.question_id = q.id
      LEFT JOIN subjects s ON q.subject_id = s.id
      WHERE ua.session_id = ANY($1)
      ORDER BY ua.session_id, ua.position ASC
    `,
      [validSessionIds],
    );

    // Fetch empirical stats for these questions
    const questionIds = questionsRes.rows.map(q => q.id).filter(Boolean);
    const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);

    // Process all questions
    const questions = questionsRes.rows.map((q) => {
      let choices = q.choices;
      if (!Array.isArray(choices)) choices = [];

      const isShortAnswer = q.question_type === "short_answer";
      const isComplex = q.question_type === "complex_mc_tf";

      let userAnswerLabel = null;
      if (isShortAnswer || isComplex) {
        userAnswerLabel = q.answer_text || null;
      } else if (q.chosen_choice_id) {
        const chosenChoice = choices.find((c) => c.id === q.chosen_choice_id);
        if (chosenChoice) userAnswerLabel = chosenChoice.label;
      }

      let correctAnswerLabel = null;
      let questionExplanation = null;
      if (isComplex) {
        const correctObj = {};
        choices.forEach((c) => {
          correctObj[c.label] = c.is_correct === true;
        });
        correctAnswerLabel = JSON.stringify(correctObj);
        questionExplanation = choices.find((c) => c.explanation)?.explanation || null;
      } else {
        const correctChoice = choices.find((c) => c.is_correct === true);
        if (correctChoice) {
          correctAnswerLabel = isShortAnswer
            ? correctChoice.content
            : correctChoice.label;
          questionExplanation = correctChoice.explanation;
        }
      }

      let isCorrect = false;
      if (isShortAnswer) {
        const correctChoice = choices.find((c) => c.is_correct === true);
        isCorrect = !!(
          correctChoice &&
          q.answer_text &&
          correctChoice.content.trim().toLowerCase() ===
            q.answer_text.trim().toLowerCase()
        );
      } else if (isComplex) {
        let userAnswersObj = {};
        try {
          userAnswersObj = q.answer_text ? JSON.parse(q.answer_text) : {};
        } catch (e) {}
        isCorrect = choices.length > 0 && choices.every((c) => {
          const studentAns = userAnswersObj[c.label];
          return studentAns !== undefined && studentAns === c.is_correct;
        });
      } else {
        isCorrect = q.chosen_choice_id
          ? choices.find((c) => c.id === q.chosen_choice_id)?.is_correct ===
            true
          : false;
      }

      return {
        id: q.id,
        questionNumber: 0,
        content: q.content,
        imageUrl: q.image_url,
        image_position: q.image_position,
        difficulty: q.difficulty,
        question_type: q.question_type || "multiple_choice",
        subject: q.subject_name,
        isCorrect: isCorrect,
        isFlagged: q.is_flagged,
        userAnswer: userAnswerLabel,
        correctAnswer: correctAnswerLabel,
        explanation: questionExplanation,
        timeSpentSec: q.time_spent_sec || 0,
        sessionId: q.session_id,
        choices: choices,
        stimulus: q.stimulus,
        irtStats: itemStatsMap[q.id] || null,
      };
    });

    // Assign question numbers and group by subject
    let questionNumber = 1;
    const subjectMap = new Map();
    questions.forEach((q) => {
      q.questionNumber = questionNumber++;
      const subjectKey = q.subject;
      if (!subjectMap.has(subjectKey)) {
        subjectMap.set(subjectKey, {
          name: subjectKey,
          sessionId: q.sessionId,
          correct: 0,
          total: 0,
          questions: [],
        });
      }
      const subjectData = subjectMap.get(subjectKey);
      if (!subjectData.sessionId && q.sessionId) {
        subjectData.sessionId = q.sessionId;
      }
      subjectData.total++;
      if (q.isCorrect) subjectData.correct++;
      subjectData.questions.push(q);
    });

    // === STATIC / FIXED SCORING on combined data ===
    // Use stored score if already computed and saved in tryout_sessions (score never changes!)
    let liveIRT;
    const sessionWithScore = sessionsRes.rows.find(s => s.total_score !== null && s.total_score !== undefined && s.score_breakdown);
    if (sessionWithScore) {
      try {
        let storedBreakdown = sessionWithScore.score_breakdown;
        if (typeof storedBreakdown === "string") {
          storedBreakdown = JSON.parse(storedBreakdown);
        }
        if (storedBreakdown && typeof storedBreakdown === "object" && storedBreakdown.totalScore !== undefined) {
          liveIRT = storedBreakdown;
        }
      } catch (e) {
        console.error("[COMBINED RESULT] Failed to parse stored score_breakdown:", e);
      }
    }

    if (!liveIRT) {
      try {
        const rawAnswersRes = await pool.query(
          `
          SELECT
            ua.chosen_choice_id,
            ua.answer_text,
            COALESCE(ac.is_correct, false) as is_correct,
            ua.question_id,
            COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
            COALESCE(q.difficulty, 'medium') as difficulty,
            COALESCE(q.question_type, 'multiple_choice') as question_type,
            COALESCE(s.name, 'Unknown') as subject_name
          FROM user_answers ua
          LEFT JOIN answer_choices ac ON ua.chosen_choice_id = ac.id
          LEFT JOIN questions q ON ua.question_id = q.id
          LEFT JOIN subjects s ON q.subject_id = s.id
          WHERE ua.session_id = ANY($1)
        `,
          [validSessionIds],
        );

        for (const ans of rawAnswersRes.rows) {
          if (ans.question_type === "short_answer" && ans.answer_text) {
            const correctRes = await pool.query(
              `SELECT content FROM answer_choices WHERE question_id = $1 AND is_correct = true LIMIT 1`,
              [ans.question_id],
            );
            if (correctRes.rows.length > 0) {
              ans.is_correct =
                correctRes.rows[0].content.trim().toLowerCase() ===
                ans.answer_text.trim().toLowerCase();
            }
          } else if (ans.question_type === "complex_mc_tf") {
            const choicesRes = await pool.query(
              `SELECT label, is_correct FROM answer_choices WHERE question_id = $1`,
              [ans.question_id],
            );
            let userAnswersObj = {};
            try {
              userAnswersObj = ans.answer_text ? JSON.parse(ans.answer_text) : {};
            } catch (e) {}
            ans.is_correct = choicesRes.rows.length > 0 && choicesRes.rows.every((c) => {
              const studentAns = userAnswersObj[c.label];
              return studentAns !== undefined && studentAns === c.is_correct;
            });
          }
        }

        const irtAnswers = rawAnswersRes.rows.map((ans) => ({
          chosen_choice_id: ans.chosen_choice_id,
          is_correct: ans.is_correct === true,
          question_id: ans.question_id,
          difficulty: ans.difficulty || "medium",
          subject_name: ans.subject_name,
          time_spent_sec: ans.time_spent_sec || 0,
          question_type: ans.question_type,
          answer_text: ans.answer_text,
          irtParams: itemStatsMap[ans.question_id] || undefined,
        }));
        liveIRT = calculateIRTScore(irtAnswers);
        // Add calibration metadata
        liveIRT.calibrationInfo = {
          totalCalibrated: questionIds.filter(id => itemStatsMap[id]?.calibrated).length,
          totalPartial: questionIds.filter(id => itemStatsMap[id]?.calibrated === 'partial').length,
          totalDefault: questionIds.filter(id => !itemStatsMap[id] || !itemStatsMap[id].calibrated).length,
        };
      } catch (irtErr) {
        console.error("[COMBINED RESULT] IRT recompute failed:", irtErr.message);
        liveIRT = { totalScore: 200, theta: 0, percentile: 0, subjectScores: {} };
      }
    }

    // Canonical UTBK subject order
    const UTBK_ORDER = [
      "penalaran umum",
      "pengetahuan dan pemahaman umum",
      "pemahaman bacaan dan tulisan",
      "pengetahuan kuantitatif",
      "literasi bahasa indonesia",
      "literasi bahasa inggris",
      "penalaran matematika",
    ];

    const findConfig = (name) => {
      if (!subjectConfig.length) return {};
      const lower = (name || "").toLowerCase().trim();
      return (
        subjectConfig.find(
          (c) => (c.name || "").toLowerCase().trim() === lower,
        ) || {}
      );
    };

    const findIRTSubject = (name) => {
      if (!liveIRT.subjectScores) return null;
      if (liveIRT.subjectScores[name]) return liveIRT.subjectScores[name];
      const lower = (name || "").toLowerCase().trim();
      for (const [k, v] of Object.entries(liveIRT.subjectScores)) {
        if ((k || "").toLowerCase().trim() === lower) return v;
      }
      for (const [k, v] of Object.entries(liveIRT.subjectScores)) {
        const kl = (k || "").toLowerCase().trim();
        if (kl.includes(lower) || lower.includes(kl)) return v;
      }
      return null;
    };

    const subjectNames = Array.from(subjectMap.keys()).sort((a, b) => {
      const aLower = (a || "").toLowerCase().trim();
      const bLower = (b || "").toLowerCase().trim();
      let aIdx = UTBK_ORDER.findIndex(
        (o) => aLower.includes(o) || o.includes(aLower),
      );
      let bIdx = UTBK_ORDER.findIndex(
        (o) => bLower.includes(o) || o.includes(bLower),
      );
      if (aIdx === -1) aIdx = 999;
      if (bIdx === -1) bIdx = 999;
      return aIdx - bIdx;
    });

    const subjects = [];
    subjectNames.forEach((subjectName) => {
      const cfg = findConfig(subjectName);
      const data = subjectMap.get(subjectName) || {
        correct: 0,
        total: 0,
        questions: [],
      };

      const percentage =
        data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0;
      let totalTimeSpent = data.questions.reduce(
        (sum, q) => sum + (q.timeSpentSec || 0),
        0,
      );

      // Fallback if totalTimeSpent is 0
      if (totalTimeSpent === 0) {
        const matchSession = data.sessionId ? sessionsRes.rows.find(s => s.id === data.sessionId) : null;
        if (matchSession && matchSession.started_at && matchSession.submitted_at) {
          const dur = Math.max(0, Math.round((new Date(matchSession.submitted_at).getTime() - new Date(matchSession.started_at).getTime()) / 1000));
          if (dur > 0) totalTimeSpent = dur;
        }
        if (totalTimeSpent === 0 && (cfg.duration || cfg.durationMin)) {
          totalTimeSpent = ((cfg.duration || cfg.durationMin) * 60) + (cfg.durationSec || 0);
        } else if (totalTimeSpent === 0 && data.total > 0) {
          totalTimeSpent = data.total * 75; // ~1.25 min per question standard pace
        }
      }

      const avgSpeed =
        data.questions.length > 0
          ? Math.round(totalTimeSpent / data.questions.length)
          : 0;

      const irtSubject = findIRTSubject(subjectName);
      const statusInfo = getStatusFromMastery(percentage, avgSpeed);

      subjects.push({
        name: subjectName,
        shortName: cfg.shortName || subjectName,
        score: irtSubject ? irtSubject.score : 0,
        percentage,
        correct: data.correct,
        total: data.total,
        avgSpeed,
        totalTimeSpent,
        status: irtSubject?.status || statusInfo.status,
        statusColor: irtSubject?.statusColor || statusInfo.statusColor,
        mastery: percentage,
        theta: irtSubject?.theta ? Math.round(irtSubject.theta * 100) / 100 : 0,
        description: irtSubject?.description || statusInfo.description,
      });
    });

    // Stats directly from questions array — always accurate
    const totalCorrectFromQ = questions.filter((q) => q.isCorrect).length;
    const avgPercentage =
      questions.length > 0
        ? Math.round((totalCorrectFromQ / questions.length) * 100)
        : 0;
    const totalScore = liveIRT.totalScore;
    const theta = liveIRT.theta;
    const percentile = liveIRT.percentile;

    // Persist only if not already saved in database (prevents score from changing over time)
    try {
      if (!sessionWithScore && typeof totalScore === "number" && !isNaN(totalScore)) {
        await pool.query(
          `UPDATE tryout_sessions SET total_score = $1, score_breakdown = $2 WHERE id = ANY($3)`,
          [totalScore, JSON.stringify(liveIRT), validSessionIds],
        );
      }
    } catch (err) {
      console.error(
        "[COMBINED RESULT] Failed to persist IRT:",
        err.message,
      );
    }

    // Compare against previous score
    let scoreChange = 0;
    try {
      const prevRes = await pool.query(
        `SELECT total_score FROM tryout_sessions
         WHERE user_id = $1 AND submitted_at IS NOT NULL AND id != ALL($2)
         ORDER BY submitted_at DESC LIMIT 1`,
        [req.user.id, validSessionIds],
      );
      const prevScore = prevRes.rows[0]?.total_score;
      if (prevScore) {
        scoreChange = Math.round(((totalScore - prevScore) / prevScore) * 100);
      }
    } catch (e) {
      /* ignore */
    }

    res.json({
      success: true,
      data: {
        sessionId: validSessionIds[0],
        sessionIds: validSessionIds,
        packageId: package_id || sessionsRes.rows[0]?.package_id,
        title: pkgTitle,
        subtitle: new Date().toLocaleDateString("id-ID", {
          year: "numeric",
          month: "long",
        }),
        totalScore,
        theta,
        percentile,
        scoreChange,
        targetPassingGrade: avgPercentage,
        scoreBreakdown: liveIRT,
        scoringMethod: "IRT-3PL (real-time combined)",
        computedAt: new Date().toISOString(),
        subjects: subjects.length > 0 ? subjects : [],
        questions: questions.length > 0 ? questions : [],
        stats: {
          correct: totalCorrectFromQ,
          incorrect: questions.filter(
            (q) => q.userAnswer !== null && !q.isCorrect,
          ).length,
          unanswered: questions.filter((q) => q.userAnswer === null).length,
          total: questions.length,
        },
      },
    });
  } catch (error) {
    console.error("Error in combined result:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Helper to auto mark package completed when all subtests in attempt are done
async function checkAndMarkPackageCompletedIfFinished(dbOrPool, userId, sessionId) {
  try {
    const pkgConfigRes = await dbOrPool.query(
      `SELECT ts.package_id, tp.subject_config FROM tryout_sessions ts
       JOIN tryout_packages tp ON ts.package_id = tp.id
       WHERE ts.id = $1`,
      [sessionId]
    );
    if (pkgConfigRes.rows.length > 0) {
      const { package_id, subject_config } = pkgConfigRes.rows[0];
      let config = subject_config;
      if (typeof config === "string") {
        try { config = JSON.parse(config); } catch { config = []; }
      }
      const totalExpectedSubtests = Array.isArray(config) && config.length > 0 ? config.length : 7;

      const completedCountRes = await dbOrPool.query(
        `SELECT COUNT(DISTINCT s.name) as completed_subtests
         FROM tryout_sessions ts
         JOIN user_answers ua ON ua.session_id = ts.id
         JOIN questions q ON ua.question_id = q.id
         JOIN subjects s ON q.subject_id = s.id
         WHERE ts.user_id = $1 AND ts.package_id = $2 AND ts.submitted_at IS NOT NULL
           AND ts.started_at >= NOW() - INTERVAL '24 hours'`,
        [userId, package_id]
      );
      const completedCount = parseInt(completedCountRes.rows[0]?.completed_subtests || 0, 10);
      if (completedCount >= totalExpectedSubtests) {
        await markPackageCompleted(dbOrPool, userId, "utbk", package_id);
      }
    }
  } catch (e) {
    console.error("[AUTO-COMPLETE-PACKAGE] Error checking completion:", e.message);
  }
}

// Submit Tryout
router.post("/submit", verifyToken, async (req, res, next) => {
  try {
    const { session_id } = req.body;
    console.log("[SUBMIT] Starting submit for session:", session_id);

    if (!session_id) {
      return res.status(400).json({ success: false, error: 'Session ID diperlukan.' });
    }

    // Verify session ownership and check if already submitted
    const sessionCheck = await pool.query(
      'SELECT id, submitted_at FROM tryout_sessions WHERE id = $1 AND user_id = $2',
      [session_id, req.user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sesi tryout tidak ditemukan atau tidak diizinkan.' });
    }

    if (sessionCheck.rows[0].submitted_at) {
      return res.status(400).json({ success: false, error: 'Sesi tryout ini sudah disubmit sebelumnya.' });
    }

    // Get answers with correctness and difficulty info
    let answersRes;
    try {
      answersRes = await pool.query(
        `
        SELECT
          ua.chosen_choice_id,
          ua.answer_text,
          COALESCE(ac.is_correct, false) as is_correct,
          ua.question_id,
          COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
          COALESCE(q.difficulty, 'medium') as difficulty,
          COALESCE(q.question_type, 'multiple_choice') as question_type,
          COALESCE(s.name, 'Unknown') as subject_name
        FROM user_answers ua
        LEFT JOIN answer_choices ac ON ua.chosen_choice_id = ac.id
        LEFT JOIN questions q ON ua.question_id = q.id
        LEFT JOIN subjects s ON q.subject_id = s.id
        WHERE ua.session_id = $1
      `,
        [session_id],
      );
      console.log(
        "[SUBMIT] Answers query returned:",
        answersRes.rows.length,
        "rows",
      );
    } catch (qError) {
      console.error("[SUBMIT] Error querying answers:", qError);
      return res.status(500).json({
        success: false,
        error: "Error fetching answers: " + qError.message,
      });
    }

    // For short answer and complex true/false questions, evaluate correctness
    for (const ans of answersRes.rows) {
      if (ans.question_type === "short_answer" && ans.answer_text) {
        const correctRes = await pool.query(
          `SELECT content FROM answer_choices WHERE question_id = $1 AND is_correct = true LIMIT 1`,
          [ans.question_id],
        );
        if (correctRes.rows.length > 0) {
          ans.is_correct =
            correctRes.rows[0].content.trim().toLowerCase() ===
            ans.answer_text.trim().toLowerCase();
        }
      } else if (ans.question_type === "complex_mc_tf") {
        const choicesRes = await pool.query(
          `SELECT label, is_correct FROM answer_choices WHERE question_id = $1`,
          [ans.question_id],
        );
        let userAnswersObj = {};
        try {
          userAnswersObj = ans.answer_text ? JSON.parse(ans.answer_text) : {};
        } catch (e) {}
        ans.is_correct = choicesRes.rows.length > 0 && choicesRes.rows.every((c) => {
          const studentAns = userAnswersObj[c.label];
          return studentAns !== undefined && studentAns === c.is_correct;
        });
      }
    }

    // Fetch calibrated IRT parameters from empirical data
    const questionIds = answersRes.rows.map(a => a.question_id).filter(Boolean);
    const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);

    // Format answers for IRT scoring with calibrated params
    const formattedAnswers = answersRes.rows.map((ans) => ({
      chosen_choice_id: ans.chosen_choice_id,
      is_correct: ans.is_correct === true,
      question_id: ans.question_id,
      difficulty: ans.difficulty || "medium",
      subject_name: ans.subject_name,
      time_spent_sec: ans.time_spent_sec || 0,
      question_type: ans.question_type,
      answer_text: ans.answer_text,
      irtParams: itemStatsMap[ans.question_id] || undefined,
    }));

    // Calculate IRT score with calibrated parameters
    console.log("[SUBMIT] Calculating IRT score with calibrated params...");
    const irtResults = calculateIRTScore(formattedAnswers);
    // Add calibration metadata
    irtResults.calibrationInfo = {
      totalCalibrated: questionIds.filter(id => itemStatsMap[id]?.calibrated).length,
      totalPartial: questionIds.filter(id => itemStatsMap[id]?.calibrated === 'partial').length,
      totalDefault: questionIds.filter(id => !itemStatsMap[id] || !itemStatsMap[id].calibrated).length,
    };

    // Update item statistics (non-blocking)
    batchUpdateItemStats(pool, formattedAnswers).catch(err =>
      console.error('[SUBMIT] Error updating item stats:', err.message)
    );
    console.log(
      "[SUBMIT] IRT results:",
      JSON.stringify({
        ...irtResults,
        itemAnalysis: "[...]",
        subjectScores: "[...]",
      }),
    );

    // Also calculate classical score for comparison
    const classicalResults = calculateScore(
      answersRes.rows.map((ans) => ({
        chosen_choice_id: ans.chosen_choice_id,
        is_correct: ans.is_correct,
        question_id: ans.question_id,
      })),
    );

    // Merge results
    const finalResults = {
      ...irtResults,
      classical_score: classicalResults.total_score,
      scoringMethod: "IRT-3PL",
    };

    // Update session with results
    console.log(
      "[SUBMIT] Updating session with score:",
      finalResults.totalScore,
    );
    await pool.query(
      `UPDATE tryout_sessions
       SET submitted_at = NOW(), total_score = $1, score_breakdown = $2
       WHERE id = $3`,
      [finalResults.totalScore, JSON.stringify(finalResults), session_id],
    );

    // Check if entire package attempt is finished and mark completed
    await checkAndMarkPackageCompletedIfFinished(pool, req.user.id, session_id);

    console.log("[SUBMIT] Session updated successfully");
    res.json({
      success: true,
      data: finalResults,
      message: "Tryout submitted with IRT scoring",
    });
  } catch (error) {
    console.error("[SUBMIT] Error submitting tryout:", error);
    next(error);
  }
});

// ============================================================================
// Submit Bulk Answers (untuk useTryoutFetch Hook React)
// ============================================================================
// Endpoint ini menerima 160 jawaban sekaligus dari React client
// Format payload: { sessionId, answers: [...], stats, submittedAt }
router.post("/submit-bulk", verifyToken, async (req, res, next) => {
  try {
    const { sessionId, answers, stats, submittedAt } = req.body;
    const userId = req.user.id;

    console.log(`[SUBMIT-BULK] Starting bulk submit for session: ${sessionId}`);
    console.log(
      `[SUBMIT-BULK] User: ${userId}, Answers: ${answers?.length || 0}`,
    );

    // ===== VALIDATION =====
    if (!sessionId || !answers || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        error: "Invalid payload. Required: sessionId, answers[]",
      });
    }

    if (answers.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No answers provided",
      });
    }

    // ===== GET/CREATE SESSION =====
    let session;
    try {
      const sessionRes = await pool.query(
        "SELECT * FROM tryout_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, userId],
      );

      if (sessionRes.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Session not found or unauthorized",
        });
      }

      session = sessionRes.rows[0];

      // Check if already submitted
      if (session.submitted_at) {
        return res.status(400).json({
          success: false,
          error: "Session sudah disubmit sebelumnya",
        });
      }
    } catch (err) {
      console.error("[SUBMIT-BULK] Error fetching session:", err);
      return res
        .status(500)
        .json({ success: false, error: "Error fetching session" });
    }

    // ===== BULK UPDATE ANSWERS =====
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const answer of answers) {
        const { questionId, choiceId, flagged, timeSpent, answerText } = answer;
        if (!questionId) continue;
        await client.query(
          `UPDATE user_answers
           SET chosen_choice_id = $1,
               is_flagged = $2,
               time_spent_sec = COALESCE($3, time_spent_sec),
               answer_text = $4
           WHERE session_id = $5 AND question_id = $6`,
          [
            choiceId || null,
            flagged || false,
            timeSpent || 0,
            answerText || null,
            sessionId,
            questionId,
          ],
        );
      }
      await client.query("COMMIT");
      console.log(
        `[SUBMIT-BULK] Updated ${answers.length} answers in database`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[SUBMIT-BULK] Error updating answers:", err);
      return res.status(500).json({
        success: false,
        error: "Error saving answers: " + err.message,
      });
    } finally {
      client.release();
    }

    // ===== CALCULATE SCORES =====
    try {
      // Get answers with correctness and difficulty info
      const answersRes = await pool.query(
        `
        SELECT
          ua.chosen_choice_id,
          ua.answer_text,
          COALESCE(ac.is_correct, false) as is_correct,
          ua.question_id,
          COALESCE(ua.time_spent_sec, 0) as time_spent_sec,
          COALESCE(q.difficulty, 'medium') as difficulty,
          COALESCE(q.question_type, 'multiple_choice') as question_type,
          COALESCE(s.name, 'Unknown') as subject_name
        FROM user_answers ua
        LEFT JOIN answer_choices ac ON ua.chosen_choice_id = ac.id
        LEFT JOIN questions q ON ua.question_id = q.id
        LEFT JOIN subjects s ON q.subject_id = s.id
        WHERE ua.session_id = $1
      `,
        [sessionId],
      );

      // For short answer and complex true/false questions, evaluate correctness
      for (const ans of answersRes.rows) {
        if (ans.question_type === "short_answer" && ans.answer_text) {
          const correctRes = await pool.query(
            `SELECT content FROM answer_choices WHERE question_id = $1 AND is_correct = true LIMIT 1`,
            [ans.question_id],
          );
          if (correctRes.rows.length > 0) {
            ans.is_correct =
              correctRes.rows[0].content.trim().toLowerCase() ===
              ans.answer_text.trim().toLowerCase();
          }
        } else if (ans.question_type === "complex_mc_tf") {
          const choicesRes = await pool.query(
            `SELECT label, is_correct FROM answer_choices WHERE question_id = $1`,
            [ans.question_id],
          );
          let userAnswersObj = {};
          try {
            userAnswersObj = ans.answer_text ? JSON.parse(ans.answer_text) : {};
          } catch (e) {}
          ans.is_correct = choicesRes.rows.length > 0 && choicesRes.rows.every((c) => {
            const studentAns = userAnswersObj[c.label];
            return studentAns !== undefined && studentAns === c.is_correct;
          });
        }
      }

      // Fetch calibrated IRT parameters from empirical data
      const questionIds = answersRes.rows.map(a => a.question_id).filter(Boolean);
      const itemStatsMap = await getItemStatsForQuestions(pool, questionIds);

      // Format for IRT scoring with calibrated params
      const formattedAnswers = answersRes.rows.map((ans) => ({
        chosen_choice_id: ans.chosen_choice_id,
        is_correct: ans.is_correct === true,
        question_id: ans.question_id,
        difficulty: ans.difficulty || "medium",
        subject_name: ans.subject_name,
        time_spent_sec: ans.time_spent_sec || 0,
        question_type: ans.question_type,
        answer_text: ans.answer_text,
        irtParams: itemStatsMap[ans.question_id] || undefined,
      }));

      // Calculate IRT score with calibrated params
      console.log("[SUBMIT-BULK] Calculating IRT score with calibrated params...");
      const irtResults = calculateIRTScore(formattedAnswers);
      // Add calibration metadata
      irtResults.calibrationInfo = {
        totalCalibrated: questionIds.filter(id => itemStatsMap[id]?.calibrated).length,
        totalPartial: questionIds.filter(id => itemStatsMap[id]?.calibrated === 'partial').length,
        totalDefault: questionIds.filter(id => !itemStatsMap[id] || !itemStatsMap[id].calibrated).length,
      };

      // Update item statistics (non-blocking)
      batchUpdateItemStats(pool, formattedAnswers).catch(err =>
        console.error('[SUBMIT-BULK] Error updating item stats:', err.message)
      );

      // Also calculate classical score
      const classicalResults = calculateScore(
        answersRes.rows.map((ans) => ({
          chosen_choice_id: ans.chosen_choice_id,
          is_correct: ans.is_correct,
          question_id: ans.question_id,
        })),
      );

      // Merge results
      const finalResults = {
        ...irtResults,
        classical_score: classicalResults.total_score,
        scoringMethod: "IRT-3PL",
        answerCount: answers.length,
        clientStats: stats,
        processedAt: new Date().toISOString(),
      };

      console.log(
        `[SUBMIT-BULK] Calculated score: ${finalResults.totalScore} (Classical: ${classicalResults.total_score})`,
      );

      // ===== UPDATE SESSION WITH RESULTS =====
      await pool.query(
        `UPDATE tryout_sessions
         SET submitted_at = NOW(), total_score = $1, score_breakdown = $2
         WHERE id = $3`,
        [finalResults.totalScore, JSON.stringify(finalResults), sessionId],
      );

      // Check if entire package attempt is finished and mark completed
      await checkAndMarkPackageCompletedIfFinished(pool, userId, sessionId);

      console.log(`[SUBMIT-BULK] Session ${sessionId} submitted successfully`);

      res.json({
        success: true,
        data: {
          sessionId,
          totalScore: finalResults.totalScore,
          scoreBreakdown: finalResults,
          message: "✅ Jawaban berhasil disubmit dengan scoring IRT",
        },
      });
    } catch (err) {
      console.error("[SUBMIT-BULK] Error calculating scores:", err);
      return res.status(500).json({
        success: false,
        error: "Error calculating scores: " + err.message,
      });
    }
  } catch (error) {
    console.error("[SUBMIT-BULK] Unexpected error:", error);
    next(error);
  }
});

// Leaderboard for a specific tryout package
router.get("/leaderboard/:packageId", verifyToken, async (req, res, next) => {
  const { packageId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  try {
    // 1. Get current user's target PTN & Major if any
    const targetRes = await pool.query(
      `SELECT target_ptn, target_major 
       FROM tryout_sessions 
       WHERE user_id = $1 AND package_id = $2 AND target_ptn IS NOT NULL 
       ORDER BY started_at DESC LIMIT 1`,
      [req.user.id, packageId]
    );
    const userPtn = targetRes.rows[0]?.target_ptn || null;
    const userMajor = targetRes.rows[0]?.target_major || null;

    // 2. Query general leaderboard
    const leaderboardRes = await pool.query(
      `
      SELECT
        ts.user_id,
        u.name,
        COALESCE(
          (SELECT ts_curr.total_score FROM tryout_sessions ts_curr
           WHERE ts_curr.user_id = ts.user_id AND ts_curr.package_id = $1
             AND ts_curr.submitted_at IS NOT NULL AND ts_curr.total_score IS NOT NULL
           ORDER BY ts_curr.submitted_at DESC, ts_curr.started_at DESC LIMIT 1),
          MAX(ts.total_score)
        ) as total_score,
        MAX(ts.submitted_at) as submitted_at,
        (SELECT ts_t.target_ptn FROM tryout_sessions ts_t WHERE ts_t.user_id = ts.user_id AND ts_t.package_id = $1 AND ts_t.target_ptn IS NOT NULL ORDER BY ts_t.started_at DESC LIMIT 1) as target_ptn,
        (SELECT ts_t.target_major FROM tryout_sessions ts_t WHERE ts_t.user_id = ts.user_id AND ts_t.package_id = $1 AND ts_t.target_major IS NOT NULL ORDER BY ts_t.started_at DESC LIMIT 1) as target_major
      FROM tryout_sessions ts
      JOIN users u ON u.id = ts.user_id
      WHERE ts.package_id = $1
        AND ts.submitted_at IS NOT NULL
        AND ts.total_score IS NOT NULL
        AND u.role = 'student'
      GROUP BY ts.user_id, u.name
    `,
      [packageId],
    );

    const allSorted = leaderboardRes.rows
      .filter((r) => r.total_score !== null && r.total_score !== undefined)
      .sort((a, b) => (Number(b.total_score) || 0) - (Number(a.total_score) || 0));
    
    const sorted = allSorted.slice(0, limit).map((row, idx) => ({
      rank: idx + 1,
      user_id: row.user_id,
      name: row.name,
      score: Math.round(Number(row.total_score) || 0),
      submitted_at: row.submitted_at,
      target_ptn: row.target_ptn,
      target_major: row.target_major,
    }));

    const userIdx = allSorted.findIndex((r) => r.user_id === req.user.id);
    const userRank =
      userIdx >= 0
        ? {
            rank: userIdx + 1,
            score: Math.round(Number(allSorted[userIdx].total_score) || 0),
            total_participants: allSorted.length,
          }
        : null;

    // 3. Query major-specific leaderboard if user has selections
    let majorSorted = [];
    let userMajorRank = null;
    
    if (userPtn && userMajor) {
      const majorRes = await pool.query(
        `
        SELECT
          ts.user_id,
          u.name,
          COALESCE(
            (SELECT ts_curr.total_score FROM tryout_sessions ts_curr
             WHERE ts_curr.user_id = ts.user_id AND ts_curr.package_id = $1 AND ts_curr.target_ptn = $2 AND ts_curr.target_major = $3
               AND ts_curr.submitted_at IS NOT NULL AND ts_curr.total_score IS NOT NULL
             ORDER BY ts_curr.submitted_at DESC, ts_curr.started_at DESC LIMIT 1),
            MAX(ts.total_score)
          ) as total_score,
          MAX(ts.submitted_at) as submitted_at,
          $2 as target_ptn,
          $3 as target_major
        FROM tryout_sessions ts
        JOIN users u ON u.id = ts.user_id
        WHERE ts.package_id = $1
          AND ts.target_ptn = $2
          AND ts.target_major = $3
          AND ts.submitted_at IS NOT NULL
          AND ts.total_score IS NOT NULL
          AND u.role = 'student'
        GROUP BY ts.user_id, u.name
      `,
        [packageId, userPtn, userMajor],
      );

      const allMajorSorted = majorRes.rows
        .filter((r) => r.total_score !== null && r.total_score !== undefined)
        .sort((a, b) => (Number(b.total_score) || 0) - (Number(a.total_score) || 0));

      majorSorted = allMajorSorted.slice(0, limit).map((row, idx) => ({
        rank: idx + 1,
        user_id: row.user_id,
        name: row.name,
        score: Math.round(Number(row.total_score) || 0),
        submitted_at: row.submitted_at,
        target_ptn: row.target_ptn,
        target_major: row.target_major,
      }));

      const userMajorIdx = allMajorSorted.findIndex((r) => r.user_id === req.user.id);
      if (userMajorIdx >= 0) {
        userMajorRank = {
          rank: userMajorIdx + 1,
          score: Math.round(Number(allMajorSorted[userMajorIdx].total_score) || 0),
          total_participants: allMajorSorted.length,
        };
      }
    }

    res.json({
      success: true,
      data: {
        leaderboard: sorted,
        user_rank: userRank,
        total_participants: allSorted.length,
        targetPtn: userPtn,
        targetMajor: userMajor,
        majorLeaderboard: majorSorted,
        userMajorRank: userMajorRank,
      },
    });
  } catch (error) {
    console.error("Leaderboard error:", error);
    next(error);
  }
});

// Leaderboard for UTBK Latihan (by subject and optionally topic)
router.get(
  "/leaderboard/latihan/:subjectId",
  verifyToken,
  async (req, res, next) => {
    const { subjectId } = req.params;
    const { topic_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    try {
      let query = `
      SELECT DISTINCT ON (ls.user_id)
        ls.user_id,
        u.name,
        ls.irt_score,
        ls.submitted_at
      FROM latihan_sessions ls
      JOIN users u ON u.id = ls.user_id
      WHERE ls.subject_id = $1
        AND ls.submitted_at IS NOT NULL
        AND ls.irt_score IS NOT NULL
        AND u.role = 'student'
    `;
      const params = [subjectId];

      if (topic_id) {
        query += ` AND ls.topic_id = $2`;
        params.push(topic_id);
      }

      query += ` ORDER BY ls.user_id, ls.submitted_at DESC`;

      const leaderboardRes = await pool.query(query, params);

      // Sort by irt_score descending and assign ranks
      const sorted = leaderboardRes.rows
        .sort((a, b) => (b.irt_score || 0) - (a.irt_score || 0))
        .slice(0, limit)
        .map((row, idx) => ({
          rank: idx + 1,
          user_id: row.user_id,
          name: row.name,
          score: Math.round(row.irt_score || 0),
          submitted_at: row.submitted_at,
        }));

      // Find current user's rank
      const allSorted = leaderboardRes.rows.sort(
        (a, b) => (b.irt_score || 0) - (a.irt_score || 0),
      );
      const userIdx = allSorted.findIndex((r) => r.user_id === req.user.id);
      const userRank =
        userIdx >= 0
          ? {
              rank: userIdx + 1,
              score: Math.round(allSorted[userIdx].irt_score || 0),
              total_participants: allSorted.length,
            }
          : null;

      res.json({
        success: true,
        data: {
          leaderboard: sorted,
          user_rank: userRank,
          total_participants: allSorted.length,
        },
      });
    } catch (error) {
      console.error("Latihan Leaderboard error:", error);
      next(error);
    }
  },
);

module.exports = router;
