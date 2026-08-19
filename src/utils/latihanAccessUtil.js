const { pool } = require("../config/db");

const SOCIAL_VERIFY_MSG =
  "Akun gratis perlu verifikasi follow/tag 3 sebelum melanjutkan latihan.";

/**
 * Cek apakah user adalah admin.
 * Fast-path: langsung true jika JWT sudah bilang admin.
 * Slow-path: cek DB jika JWT stale (misal baru dipromosikan tanpa re-login).
 */
async function isAdminUser(userId, jwtRole) {
  const staffRoles = ["admin", "question_writer", "quality_assurance"];
  if (staffRoles.includes(jwtRole)) return true;
  const res = await pool.query("SELECT role FROM users WHERE id = $1", [
    userId,
  ]);
  return staffRoles.includes(res.rows[0]?.role);
}

function isGratisPlan(plan) {
  const p = (plan || "gratis").toLowerCase();
  return p === "gratis";
}

async function checkLatihanAccess(userId) {
  const countRes = await pool.query(
    "SELECT COUNT(*) AS count FROM latihan_sessions WHERE user_id = $1 AND submitted_at IS NOT NULL",
    [userId],
  );
  const totalSessions = parseInt(countRes.rows[0]?.count || 0, 10);

  const verRes = await pool.query(
    `SELECT status FROM user_social_verifications
     WHERE user_id = $1 AND context = 'latihan'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const verified = verRes.rows[0]?.status === "approved";

  if (verified) return { allowed: true, totalSessions, verified: true };
  if (totalSessions >= 2) {
    return {
      allowed: false,
      totalSessions,
      verified: false,
      code: "FREE_LIMIT_REQUIRE_SOCIAL",
    };
  }
  return { allowed: true, totalSessions, verified: false };
}

async function assertUtbkGratisContentAccess(subjectId, topicId) {
  let requiredPlan = "gratis";
  if (topicId) {
    const res = await pool.query(
      `SELECT COALESCE(s.required_plan, 'gratis') AS required_plan
       FROM topics t
       JOIN subjects s ON s.id = t.subject_id
       WHERE t.id = $1`,
      [topicId],
    );
    if (res.rows.length === 0) return null;
    requiredPlan = res.rows[0].required_plan;
  } else if (subjectId) {
    const res = await pool.query(
      "SELECT required_plan FROM subjects WHERE id = $1",
      [subjectId],
    );
    if (res.rows.length === 0) return null;
    requiredPlan = res.rows[0].required_plan;
  } else {
    return null;
  }

  if (!isGratisPlan(requiredPlan)) {
    return {
      error:
        "Latihan ini khusus paket Premium. Upgrade paket untuk mengakses.",
      code: "PLAN_REQUIRED",
    };
  }
  return null;
}

async function assertUmGratisContentAccess(latihanId) {
  if (!latihanId) return null;
  const res = await pool.query(
    `SELECT required_plan FROM um_latihan_soal
     WHERE id = $1 AND (category IS NULL OR category != 'package_placeholder')`,
    [latihanId],
  );
  if (res.rows.length === 0) return null;
  if (!isGratisPlan(res.rows[0].required_plan)) {
    return {
      error:
        "Latihan ini khusus paket Premium. Upgrade paket untuk mengakses.",
      code: "PLAN_REQUIRED",
    };
  }
  return null;
}

async function hasActiveUtbkSubscription(userId) {
  const res = await pool.query(
    `SELECT 1 FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
       AND (p.target_type = 'utbk' OR p.target_type = 'all') AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

async function hasActiveUmSubscription(userId) {
  const res = await pool.query(
    `SELECT 1 FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
       AND (p.target_type = 'um' OR p.target_type = 'all') AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

async function hasActiveTkaSubscription(userId, level = 'SMA') {
  const targetTypes = ['tka', 'all'];
  if (level) {
    targetTypes.push(`tka_${level.toLowerCase()}`);
  }
  const res = await pool.query(
    `SELECT 1 FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
       AND (p.target_type = ANY($2::text[])) AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
     LIMIT 1`,
    [userId, targetTypes],
  );
  return res.rows.length > 0;
}

async function hasActiveFundamentalUtbkSubscription(userId) {
  const res = await pool.query(
    `SELECT 1 FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 
       AND s.status = 'active' 
       AND s.expires_at > NOW()
       AND p.name IN ('utbk_3m', 'utbk_6m', 'utbk_9m', 'utbk_12m', 'premium')
       AND (p.plan_type = 'subscription' OR p.plan_type = 'access')
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

module.exports = {
  SOCIAL_VERIFY_MSG,
  isAdminUser,
  isGratisPlan,
  checkLatihanAccess,
  assertUtbkGratisContentAccess,
  assertUmGratisContentAccess,
  hasActiveUtbkSubscription,
  hasActiveFundamentalUtbkSubscription,
  hasActiveUmSubscription,
  hasActiveTkaSubscription,
};
