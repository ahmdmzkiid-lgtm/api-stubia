const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { getApiKeyManager } = require('../services/apiKeyManager');
const { getJwtSecret } = require('../config/jwt');

const decodeTokenFromRequest = (req) => {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query.token) {
      token = req.query.token;
    }
    if (!token) return null;
    return jwt.verify(token, getJwtSecret());
  } catch (err) {
    return null;
  }
};

const ensureAdminFromAny = (req, res, next) => {
  const decoded = decodeTokenFromRequest(req);
  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
  }
  if (decoded.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Access denied. Admin role required.' });
  }
  req.user = decoded;
  next();
};

const fetchRecentActivities = async (limit = 50, offset = 0) => {
  const safeLimit = Math.max(parseInt(limit, 10) || 50, 1);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const fetchLimit = Math.min(safeLimit + safeOffset + 20, 500); // grab a bit extra to cover pagination window

  const [tryoutRes, umTryoutRes, latihanRes, userRes, counts] = await Promise.all([
    pool.query(
      `SELECT ts.id as ref_id, u.id as user_id, u.name, u.email, 'tryout_submit' as action, 'utbk_tryout' as source,
              COALESCE(ts.submitted_at, ts.started_at, NOW()) as timestamp,
              ts.package_id, ts.total_score,
              tp.title as package_title
       FROM tryout_sessions ts
       JOIN users u ON u.id = ts.user_id
       LEFT JOIN tryout_packages tp ON tp.id = ts.package_id
       ORDER BY timestamp DESC
       LIMIT $1`,
      [fetchLimit]
    ),
    pool.query(
      `SELECT ts.id as ref_id, u.id as user_id, u.name, u.email, 'um_tryout_submit' as action, 'um_tryout' as source,
              COALESCE(ts.submitted_at, ts.started_at, NOW()) as timestamp,
              ts.package_id, ts.total_score,
              tp.title as package_title
       FROM um_tryout_sessions ts
       JOIN users u ON u.id = ts.user_id
       LEFT JOIN um_tryout_packages tp ON tp.id = ts.package_id
       ORDER BY timestamp DESC
       LIMIT $1`,
      [fetchLimit]
    ),
    pool.query(
      `SELECT ls.id as ref_id, u.id as user_id, u.name, u.email, 'latihan_submit' as action, 'latihan' as source,
              COALESCE(ls.submitted_at, ls.started_at, NOW()) as timestamp,
              ls.latihan_id, ls.subject_name, ls.correct_count, ls.incorrect_count, ls.unanswered_count,
              t.title as topic_title
       FROM latihan_sessions ls
       JOIN users u ON u.id = ls.user_id
       LEFT JOIN topics t ON t.id = ls.topic_id
       ORDER BY timestamp DESC
       LIMIT $1`,
      [fetchLimit]
    ),
    pool.query(
      `SELECT u.id as ref_id, u.id as user_id, u.name, u.email, 'user_registered' as action, 'user' as source,
              COALESCE(u.created_at, NOW()) as timestamp
       FROM users u
       ORDER BY timestamp DESC
       LIMIT $1`,
      [fetchLimit]
    ),
    pool.query(
      `SELECT 
         (SELECT COUNT(*) FROM tryout_sessions) as tryout_count,
         (SELECT COUNT(*) FROM um_tryout_sessions) as um_tryout_count,
         (SELECT COUNT(*) FROM latihan_sessions) as latihan_count,
         (SELECT COUNT(*) FROM users) as user_count`
    ),
  ]);

  const merged = [
    ...tryoutRes.rows.map(r => ({
      id: `tryout-${r.ref_id}`,
      ...r,
      severity: 'info',
      meta: {
        package_id: r.package_id,
        package_title: r.package_title,
        score: r.total_score
      },
    })),
    ...umTryoutRes.rows.map(r => ({
      id: `umtryout-${r.ref_id}`,
      ...r,
      severity: 'info',
      meta: {
        package_id: r.package_id,
        package_title: r.package_title,
        score: r.total_score
      },
    })),
    ...latihanRes.rows.map(r => ({
      id: `latihan-${r.ref_id}`,
      ...r,
      severity: 'info',
      meta: {
        latihan_id: r.latihan_id,
        subject_name: r.subject_name,
        topic_title: r.topic_title,
        correct: r.correct_count,
        incorrect: r.incorrect_count,
        unanswered: r.unanswered_count,
      },
    })),
    ...userRes.rows.map(r => ({
      id: `user-${r.ref_id}`,
      ...r,
      severity: 'info',
      meta: {},
    })),
  ];

  const sorted = merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const items = sorted.slice(safeOffset, safeOffset + safeLimit);

  const totalRaw = counts.rows?.[0] || {};
  const total = ['tryout_count', 'um_tryout_count', 'latihan_count', 'user_count']
    .map((k) => parseInt(totalRaw[k] || 0, 10) || 0)
    .reduce((a, b) => a + b, 0);

  return { items, total };
};

// GET /api/admin/stats - Comprehensive Dashboard & Operational statistics
router.get('/stats', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    // Run all queries in parallel for high performance
    const [
      usersResult,
      usersGrowthResult,
      revenueResult,
      activeSubsResult,
      questionsResult,
      sessionsSummaryResult,
      liveSessionsResult,
      pendingActionsResult,
      subjectStatsResult,
      difficultyResult,
      recentUsersResult,
      recentTxResult,
      regTrendResult,
      sessionTrendResult,
      revenueTrendResult,
    ] = await Promise.all([
      // 1. Total users by role & plan
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE role = 'student') as students,
          COUNT(*) FILTER (WHERE role = 'admin') as admins,
          COUNT(*) FILTER (WHERE role = 'mitra') as mitra,
          COUNT(*) FILTER (WHERE role = 'student' AND (current_plan = 'gratis' OR current_plan IS NULL)) as free_students,
          COUNT(*) FILTER (WHERE role = 'student' AND (current_plan IN ('premium', 'sultan') OR current_plan LIKE 'utbk_%')) as premium_utbk,
          COUNT(*) FILTER (WHERE role = 'student' AND (current_plan IN ('premium_um', 'sultan') OR current_plan LIKE 'um_%')) as premium_um,
          COUNT(*) FILTER (WHERE role = 'student' AND (current_plan IN ('premium_tka', 'sultan') OR current_plan LIKE 'tka_%')) as premium_tka,
          COUNT(*) FILTER (WHERE role = 'student' AND (current_plan IN ('premium_skd', 'sultan') OR current_plan LIKE 'cpns_%' OR current_plan LIKE 'skd_%')) as premium_skd
        FROM users
      `),

      // 2. User growth (today, 7 days, 30 days)
      pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as new_today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_this_week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as new_this_month
        FROM users
      `),

      // 3. Transactions & Revenue
      pool.query(`
        SELECT 
          COUNT(*) as total_tx,
          COUNT(*) FILTER (WHERE status IN ('settlement', 'capture', 'success')) as success_tx,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_tx,
          COUNT(*) FILTER (WHERE status IN ('expire', 'cancel', 'deny', 'failure')) as failed_tx,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('settlement', 'capture', 'success')), 0) as total_revenue,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('settlement', 'capture', 'success') AND created_at >= NOW() - INTERVAL '30 days'), 0) as month_revenue,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('settlement', 'capture', 'success') AND created_at >= NOW() - INTERVAL '24 hours'), 0) as today_revenue
        FROM payment_transactions
      `),

      // 4. Active Subscriptions
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())) as active_subs
        FROM subscriptions
      `),

      // 5. Total Questions across all tables
      pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM questions) as utbk,
          (SELECT COUNT(*) FROM um_questions) as um,
          (SELECT COUNT(*) FROM skd_questions) as skd,
          (SELECT COUNT(*) FROM tka_questions) as tka,
          (SELECT COUNT(*) FROM fundamental_quizzes) as fundamental_quizzes,
          (SELECT COUNT(*) FROM fundamental_materials) as fundamental_materials,
          (
            (SELECT COUNT(*) FROM questions) + 
            (SELECT COUNT(*) FROM um_questions) + 
            (SELECT COUNT(*) FROM skd_questions) + 
            (SELECT COUNT(*) FROM tka_questions) +
            (SELECT COUNT(*) FROM fundamental_quizzes)
          ) as total_questions
      `),

      // 6. Total Completed Sessions across all modules
      pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM tryout_sessions WHERE submitted_at IS NOT NULL) as utbk_tryouts,
          (SELECT COUNT(*) FROM um_tryout_sessions WHERE submitted_at IS NOT NULL) as um_tryouts,
          (SELECT COUNT(*) FROM skd_tryout_sessions WHERE submitted_at IS NOT NULL) as skd_tryouts,
          (SELECT COUNT(*) FROM tka_tryout_sessions WHERE submitted_at IS NOT NULL) as tka_tryouts,
          (SELECT COUNT(*) FROM latihan_sessions WHERE submitted_at IS NOT NULL) as utbk_latihan,
          (SELECT COUNT(*) FROM skd_latihan_sessions WHERE submitted_at IS NOT NULL) as skd_latihan,
          (SELECT COUNT(*) FROM tka_latihan_sessions WHERE submitted_at IS NOT NULL) as tka_latihan,
          (SELECT COUNT(*) FROM fundamental_quiz_sessions) as fundamental_quizzes,
          (SELECT COUNT(*) FROM battle_matches WHERE status = 'completed') as battle_matches
      `),

      // 7. Live Ongoing Sessions (active in last 3 hours without submitted_at)
      pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM tryout_sessions WHERE submitted_at IS NULL AND started_at >= NOW() - INTERVAL '3 hours') as live_utbk_tryout,
          (SELECT COUNT(*) FROM um_tryout_sessions WHERE submitted_at IS NULL AND started_at >= NOW() - INTERVAL '3 hours') as live_um_tryout,
          (SELECT COUNT(*) FROM tka_tryout_sessions WHERE submitted_at IS NULL AND started_at >= NOW() - INTERVAL '3 hours') as live_tka_tryout,
          (SELECT COUNT(*) FROM skd_tryout_sessions WHERE submitted_at IS NULL AND started_at >= NOW() - INTERVAL '3 hours') as live_skd_tryout,
          (SELECT COUNT(*) FROM latihan_sessions WHERE submitted_at IS NULL AND started_at >= NOW() - INTERVAL '2 hours') as live_latihan,
          (SELECT COUNT(*) FROM battle_matches WHERE status IN ('waiting', 'matched', 'ongoing')) as live_battles
      `),

      // 8. Pending Actions
      pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM tryout_registrations WHERE status = 'pending') as pending_tryout_registrations,
          (SELECT COUNT(*) FROM user_social_verifications WHERE status = 'pending') as pending_social_verifications,
          (SELECT COUNT(*) FROM mitra_withdrawals WHERE status = 'pending') as pending_mitra_withdrawals
      `),

      // 9. Subject stats (UTBK)
      pool.query(`
        SELECT s.name, s.category, COUNT(q.id) as question_count 
        FROM subjects s 
        LEFT JOIN questions q ON q.subject_id = s.id 
        GROUP BY s.id, s.name, s.category 
        ORDER BY question_count DESC
      `),

      // 10. Difficulty distribution (UTBK)
      pool.query(`SELECT difficulty, COUNT(*) as count FROM questions GROUP BY difficulty`),

      // 11. Recent users (last 8)
      pool.query(`
        SELECT id, name, email, role, current_plan, created_at 
        FROM users 
        ORDER BY created_at DESC 
        LIMIT 8
      `),

      // 12. Recent payment transactions (last 8)
      pool.query(`
        SELECT pt.*,
               u.name as user_name, u.email as user_email
        FROM payment_transactions pt
        LEFT JOIN users u ON u.id = pt.user_id
        ORDER BY pt.created_at DESC
        LIMIT 8
      `),

      // 13. Registration trend (14 days)
      pool.query(`
        SELECT 
          TO_CHAR(d.day, 'YYYY-MM-DD') as date,
          COUNT(u.id) as count
        FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
        LEFT JOIN users u ON DATE(u.created_at) = DATE(d.day)
        GROUP BY d.day
        ORDER BY d.day ASC
      `),

      // 14. Session trend (14 days - aggregate latihan + tryouts)
      pool.query(`
        SELECT 
          TO_CHAR(d.day, 'YYYY-MM-DD') as date,
          (
            COALESCE((SELECT COUNT(*) FROM latihan_sessions ls WHERE DATE(ls.started_at) = DATE(d.day)), 0) +
            COALESCE((SELECT COUNT(*) FROM tryout_sessions ts WHERE DATE(ts.started_at) = DATE(d.day)), 0) +
            COALESCE((SELECT COUNT(*) FROM um_tryout_sessions ums WHERE DATE(ums.started_at) = DATE(d.day)), 0)
          ) as count
        FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
        GROUP BY d.day
        ORDER BY d.day ASC
      `),

      // 15. Revenue trend (14 days)
      pool.query(`
        SELECT 
          TO_CHAR(d.day, 'YYYY-MM-DD') as date,
          COALESCE(SUM(pt.amount) FILTER (WHERE pt.status IN ('settlement', 'capture', 'success')), 0) as amount
        FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
        LEFT JOIN payment_transactions pt ON DATE(pt.created_at) = DATE(d.day)
        GROUP BY d.day
        ORDER BY d.day ASC
      `),
    ]);

    let aiKeyStatus = null;
    try {
      aiKeyStatus = getApiKeyManager().getKeyStatus();
    } catch (e) {
      aiKeyStatus = { error: e.message };
    }

    const usersData = usersResult.rows[0] || {};
    const growthData = usersGrowthResult.rows[0] || {};
    const revData = revenueResult.rows[0] || {};
    const subsData = activeSubsResult.rows[0] || {};
    const qData = questionsResult.rows[0] || {};
    const sessData = sessionsSummaryResult.rows[0] || {};
    const liveData = liveSessionsResult.rows[0] || {};
    const pendingData = pendingActionsResult.rows[0] || {};

    res.json({
      success: true,
      data: {
        users: {
          total: parseInt(usersData.total || 0),
          students: parseInt(usersData.students || 0),
          admins: parseInt(usersData.admins || 0),
          mitra: parseInt(usersData.mitra || 0),
          freeStudents: parseInt(usersData.free_students || 0),
          premiumUtbk: parseInt(usersData.premium_utbk || 0),
          premiumUm: parseInt(usersData.premium_um || 0),
          premiumTka: parseInt(usersData.premium_tka || 0),
          premiumSkd: parseInt(usersData.premium_skd || 0),
          premiumStudents: parseInt(usersData.premium_utbk || 0),
          premiumUmStudents: parseInt(usersData.premium_um || 0),
          premiumTkaStudents: parseInt(usersData.premium_tka || 0),
          premiumSkdStudents: parseInt(usersData.premium_skd || 0),
          growth: {
            today: parseInt(growthData.new_today || 0),
            thisWeek: parseInt(growthData.new_this_week || 0),
            thisMonth: parseInt(growthData.new_this_month || 0),
          }
        },
        financials: {
          totalRevenue: parseInt(revData.total_revenue || 0),
          monthRevenue: parseInt(revData.month_revenue || 0),
          todayRevenue: parseInt(revData.today_revenue || 0),
          totalTx: parseInt(revData.total_tx || 0),
          successTx: parseInt(revData.success_tx || 0),
          pendingTx: parseInt(revData.pending_tx || 0),
          failedTx: parseInt(revData.failed_tx || 0),
          activeSubscriptions: parseInt(subsData.active_subs || 0),
          totalSubscriptions: parseInt(subsData.total || 0),
        },
        questions: {
          total: parseInt(qData.total_questions || 0),
          utbk: parseInt(qData.utbk || 0),
          um: parseInt(qData.um || 0),
          skd: parseInt(qData.skd || 0),
          tka: parseInt(qData.tka || 0),
          fundamentalQuizzes: parseInt(qData.fundamental_quizzes || 0),
          fundamentalMaterials: parseInt(qData.fundamental_materials || 0),
        },
        sessions: {
          total: parseInt(sessData.utbk_tryouts || 0) + parseInt(sessData.um_tryouts || 0) + parseInt(sessData.skd_tryouts || 0) + parseInt(sessData.tka_tryouts || 0) + parseInt(sessData.utbk_latihan || 0) + parseInt(sessData.skd_latihan || 0) + parseInt(sessData.tka_latihan || 0) + parseInt(sessData.fundamental_quizzes || 0) + parseInt(sessData.battle_matches || 0),
          utbkTryouts: parseInt(sessData.utbk_tryouts || 0),
          umTryouts: parseInt(sessData.um_tryouts || 0),
          skdTryouts: parseInt(sessData.skd_tryouts || 0),
          tkaTryouts: parseInt(sessData.tka_tryouts || 0),
          utbkLatihan: parseInt(sessData.utbk_latihan || 0),
          skdLatihan: parseInt(sessData.skd_latihan || 0),
          tkaLatihan: parseInt(sessData.tka_latihan || 0),
          fundamentalQuizzes: parseInt(sessData.fundamental_quizzes || 0),
          battleMatches: parseInt(sessData.battle_matches || 0),
        },
        liveSessions: {
          total: parseInt(liveData.live_utbk_tryout || 0) + parseInt(liveData.live_um_tryout || 0) + parseInt(liveData.live_tka_tryout || 0) + parseInt(liveData.live_skd_tryout || 0) + parseInt(liveData.live_latihan || 0) + parseInt(liveData.live_battles || 0),
          utbkTryout: parseInt(liveData.live_utbk_tryout || 0),
          umTryout: parseInt(liveData.live_um_tryout || 0),
          tkaTryout: parseInt(liveData.live_tka_tryout || 0),
          skdTryout: parseInt(liveData.live_skd_tryout || 0),
          latihan: parseInt(liveData.live_latihan || 0),
          battles: parseInt(liveData.live_battles || 0),
        },
        pendingActions: {
          total: parseInt(pendingData.pending_tryout_registrations || 0) + parseInt(pendingData.pending_social_verifications || 0) + parseInt(pendingData.pending_mitra_withdrawals || 0),
          tryoutRegistrations: parseInt(pendingData.pending_tryout_registrations || 0),
          socialVerifications: parseInt(pendingData.pending_social_verifications || 0),
          mitraWithdrawals: parseInt(pendingData.pending_mitra_withdrawals || 0),
        },
        aiKeyStatus,
        subjectStats: subjectStatsResult.rows,
        difficultyDistribution: difficultyResult.rows,
        recentUsers: recentUsersResult.rows,
        recentTransactions: recentTxResult.rows,
        trends: {
          registrations: regTrendResult.rows,
          sessions: sessionTrendResult.rows,
          revenue: revenueTrendResult.rows,
        },
        serverHealth: {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          nodeEnv: process.env.NODE_ENV || 'development',
        }
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/users - Paginated user list
router.get('/users', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const role = req.query.role; // 'student', 'admin', or undefined for all
    const plan = req.query.plan; // 'gratis', 'premium', 'premium_um', or undefined for all
    const search = req.query.search || '';

    let whereClause = '';
    const params = [];
    const conditions = [];

    if (role) {
      params.push(role);
      conditions.push(`role = $${params.length}`);
    }
    if (plan) {
      if (plan === 'premium' || plan === 'utbk') {
        conditions.push(`(current_plan IN ('premium', 'sultan') OR current_plan LIKE 'utbk_%')`);
      } else if (plan === 'premium_um' || plan === 'um') {
        conditions.push(`(current_plan IN ('premium_um', 'sultan') OR current_plan LIKE 'um_%')`);
      } else if (plan === 'premium_tka' || plan === 'tka') {
        conditions.push(`(current_plan IN ('premium_tka', 'sultan') OR current_plan LIKE 'tka_%')`);
      } else if (plan === 'premium_skd' || plan === 'cpns' || plan === 'skd') {
        conditions.push(`(current_plan IN ('premium_skd', 'sultan') OR current_plan LIKE 'cpns_%' OR current_plan LIKE 'skd_%')`);
      } else if (plan === 'gratis' || plan === 'free') {
        conditions.push(`(current_plan = 'gratis' OR current_plan IS NULL)`);
      } else {
        params.push(plan);
        conditions.push(`current_plan = $${params.length}`);
      }
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM users ${whereClause}`,
      params
    );

    const usersResult = await pool.query(
      `SELECT id, name, email, role, current_plan, created_at FROM users ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: {
        users: usersResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/users/:id/role - Update user role
router.patch('/users/:id/role', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const allowedRoles = ['student', 'admin', 'question_writer', 'quality_assurance', 'article_writer'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }
    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role',
      [role, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: result.rows[0], message: 'Role updated successfully' });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/tryout-registrations - Paginated registrations
router.get('/tryout-registrations', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const statusFilter = req.query.status;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [];

    if (statusFilter) {
      params.push(statusFilter);
      whereClause = `WHERE tr.status = $${params.length}`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM tryout_registrations tr ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].total);

    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    params.push(limit, offset);

    const query = `
      SELECT tr.*, 
             u.name as user_name, u.email as user_email, u.current_plan as user_plan,
             COALESCE(tp.title, utp.title) as package_title
      FROM tryout_registrations tr
      JOIN users u ON u.id = tr.user_id
      LEFT JOIN tryout_packages tp ON tp.id = tr.utbk_package_id
      LEFT JOIN um_tryout_packages utp ON utp.id = tr.um_package_id
      ${whereClause}
      ORDER BY tr.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: {
        registrations: result.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/tryout-registrations/:id - Approve or reject registration
router.patch('/tryout-registrations/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status tidak valid.' });
    }

    const check = await pool.query('SELECT * FROM tryout_registrations WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pendaftaran tidak ditemukan.' });
    }

    const result = await pool.query(
      `UPDATE tryout_registrations 
       SET status = $1, rejection_reason = $2, updated_at = NOW() 
       WHERE id = $3 RETURNING *`,
      [status, status === 'rejected' ? rejection_reason : null, id]
    );

    const reg = result.rows[0];
    
    // Retrieve user and package details to send notification email
    const detailRes = await pool.query(`
      SELECT u.name, u.email, COALESCE(tp.title, utp.title) as package_title
      FROM users u
      LEFT JOIN tryout_packages tp ON tp.id = $2
      LEFT JOIN um_tryout_packages utp ON utp.id = $3
      WHERE u.id = $1
    `, [reg.user_id, reg.utbk_package_id, reg.um_package_id]);

    if (detailRes.rows.length > 0) {
      const detail = detailRes.rows[0];
      const { sendTryoutRegistrationApprovedEmail, sendTryoutRegistrationRejectedEmail } = require('../services/emailService');
      if (status === 'approved') {
        sendTryoutRegistrationApprovedEmail(detail.email, detail.name, detail.package_title, reg.package_type)
          .catch(err => console.error('Tryout approved email error:', err));
      } else if (status === 'rejected') {
        sendTryoutRegistrationRejectedEmail(detail.email, detail.name, detail.package_title, rejection_reason)
          .catch(err => console.error('Tryout rejected email error:', err));
      }
    }

    res.json({
      success: true,
      data: reg,
      message: `Pendaftaran berhasil ${status === 'approved' ? 'disetujui' : 'ditolak'}.`
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/tryout-registrations/:id - Delete approved/rejected registration
router.delete('/tryout-registrations/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    const check = await pool.query('SELECT id, status FROM tryout_registrations WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pendaftaran tidak ditemukan.' });
    }

    if (check.rows[0].status === 'pending') {
      return res.status(400).json({ success: false, error: 'Tidak bisa menghapus pendaftaran yang masih pending. Setujui atau tolak terlebih dahulu.' });
    }

    await pool.query('DELETE FROM tryout_registrations WHERE id = $1', [id]);

    res.json({ success: true, message: 'Pendaftaran berhasil dihapus.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/activity - preload latest activities
router.get('/activity', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const page = parseInt(req.query.page, 10) || 1;
    const offset = (page - 1) * limit;
    const { items, total } = await fetchRecentActivities(limit, offset);
    res.json({
      success: true,
      data: {
        items,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1,
        limit,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/activity/stream - SSE live feed
router.get('/activity/stream', ensureAdminFromAny, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  let alive = true;

  const sendSnapshot = async () => {
    try {
      const { items } = await fetchRecentActivities(50, 0);
      res.write(`event: snapshot\n`);
      res.write(`data: ${JSON.stringify(items)}\n\n`);
    } catch (err) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: 'failed_to_fetch' })}\n\n`);
    }
  };

  const sendHeartbeat = () => {
    res.write(`event: ping\n`);
    res.write(`data: ${Date.now()}\n\n`);
  };

  // Initial snapshot
  await sendSnapshot();
  sendHeartbeat();

  const interval = setInterval(async () => {
    if (!alive) return;
    await sendSnapshot();
    sendHeartbeat();
  }, 5000);

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    res.end();
  });
});

// ──────────────────────────────────
// Tim Stubia CRUD (Admin)
// ──────────────────────────────────

// GET /api/admin/team - List all team members
router.get('/team', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM team_members ORDER BY display_order ASC, created_at ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/team - Create team member
router.post('/team', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { name, role, photo_url, bio, instagram_url, linkedin_url } = req.body;
    if (!name || !role) {
      return res.status(400).json({ success: false, error: 'Nama dan role wajib diisi.' });
    }
    // Get next display_order
    const maxOrder = await pool.query('SELECT COALESCE(MAX(display_order), 0) + 1 as next_order FROM team_members');
    const display_order = maxOrder.rows[0].next_order;

    const result = await pool.query(
      'INSERT INTO team_members (name, role, photo_url, bio, instagram_url, linkedin_url, display_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, role, photo_url || null, bio || null, instagram_url || null, linkedin_url || null, display_order]
    );
    res.status(201).json({ success: true, data: result.rows[0], message: 'Anggota tim berhasil ditambahkan.' });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/team/:id - Update team member
router.patch('/team/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, role, photo_url, bio, instagram_url, linkedin_url, display_order } = req.body;

    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) { fields.push(`name = $${paramIndex++}`); values.push(name); }
    if (role !== undefined) { fields.push(`role = $${paramIndex++}`); values.push(role); }
    if (photo_url !== undefined) { fields.push(`photo_url = $${paramIndex++}`); values.push(photo_url); }
    if (bio !== undefined) { fields.push(`bio = $${paramIndex++}`); values.push(bio); }
    if (instagram_url !== undefined) { fields.push(`instagram_url = $${paramIndex++}`); values.push(instagram_url); }
    if (linkedin_url !== undefined) { fields.push(`linkedin_url = $${paramIndex++}`); values.push(linkedin_url); }
    if (display_order !== undefined) { fields.push(`display_order = $${paramIndex++}`); values.push(display_order); }
    fields.push(`updated_at = NOW()`);

    if (fields.length === 1) {
      return res.status(400).json({ success: false, error: 'Tidak ada field yang diupdate.' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE team_members SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Anggota tim tidak ditemukan.' });
    }

    res.json({ success: true, data: result.rows[0], message: 'Anggota tim berhasil diupdate.' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/team/:id - Delete team member
router.delete('/team/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM team_members WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Anggota tim tidak ditemukan.' });
    }
    res.json({ success: true, message: 'Anggota tim berhasil dihapus.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/api-keys-status - Monitor Gemini API keys health
router.get('/api-keys-status', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const manager = getApiKeyManager();
    const status = manager.getKeyStatus();

    res.json({
      success: true,
      data: status,
      message: 'API Keys status retrieved successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get API keys status'
    });
  }
});

// POST /api/admin/api-keys-reset - Admin reset all API keys (clear cooldown)
router.post('/api-keys-reset', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const manager = getApiKeyManager();
    manager.resetAllKeys();

    res.json({
      success: true,
      message: 'All API keys reset to available status'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset API keys'
    });
  }
});

// GET /api/admin/questions/duplicates - Find all duplicate questions in both UTBK and UM
router.get('/questions/duplicates', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const utbkDuplicates = await pool.query(`
      SELECT q.content_hash, COUNT(*) as duplicate_count, 
             json_agg(
               json_build_object(
                 'id', q.id,
                 'content', q.content,
                 'difficulty', q.difficulty,
                 'subject_id', q.subject_id,
                 'subject_name', s.name,
                 'tryout_package_id', q.tryout_package_id,
                 'package_title', tp.title,
                 'topic_id', q.topic_id,
                 'topic_title', t.title
               )
             ) as questions_list
      FROM questions q
      LEFT JOIN subjects s ON q.subject_id = s.id
      LEFT JOIN tryout_packages tp ON q.tryout_package_id = tp.id
      LEFT JOIN topics t ON q.topic_id = t.id
      WHERE q.content_hash IS NOT NULL
      GROUP BY q.content_hash
      HAVING COUNT(*) > 1
      ORDER BY duplicate_count DESC
    `);

    const umDuplicates = await pool.query(`
      SELECT q.content_hash, COUNT(*) as duplicate_count, 
             json_agg(
               json_build_object(
                 'id', q.id,
                 'content', q.content,
                 'difficulty', q.difficulty,
                 'tryout_package_id', q.tryout_package_id,
                 'latihan_id', q.latihan_id,
                 'package_title', tp.title,
                 'latihan_title', ls.title
               )
             ) as questions_list
      FROM um_questions q
      LEFT JOIN um_tryout_packages tp ON q.tryout_package_id = tp.id
      LEFT JOIN um_latihan_soal ls ON q.latihan_id = ls.id
      WHERE q.content_hash IS NOT NULL
      GROUP BY q.content_hash
      HAVING COUNT(*) > 1
      ORDER BY duplicate_count DESC
    `);

    const skdDuplicates = await pool.query(`
      SELECT q.content_hash, COUNT(*) as duplicate_count, 
             json_agg(
               json_build_object(
                 'id', q.id,
                 'content', q.content,
                 'difficulty', q.difficulty,
                 'subject_id', q.subject_id,
                 'subject_name', s.name,
                 'tryout_package_id', q.tryout_package_id,
                 'package_title', tp.title,
                 'topic_id', q.topic_id,
                 'topic_title', t.title
               )
             ) as questions_list
      FROM skd_questions q
      LEFT JOIN skd_subjects s ON q.subject_id = s.id
      LEFT JOIN skd_tryout_packages tp ON q.tryout_package_id = tp.id
      LEFT JOIN skd_topics t ON q.topic_id = t.id
      WHERE q.content_hash IS NOT NULL
      GROUP BY q.content_hash
      HAVING COUNT(*) > 1
      ORDER BY duplicate_count DESC
    `);

    res.json({
      success: true,
      data: {
        utbk: utbkDuplicates.rows,
        um: umDuplicates.rows,
        skd: skdDuplicates.rows
      }
    });
  } catch (error) {
    next(error);
  }
});



// GET /api/admin/activity-logs - Admin only: Get paginated admin activity logs
router.get('/activity-logs', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 30;
    const page = parseInt(req.query.page, 10) || 1;
    const offset = (page - 1) * limit;

    const countRes = await pool.query('SELECT COUNT(*) FROM admin_activity_logs');
    const total = parseInt(countRes.rows[0].count, 10) || 0;

    const logsRes = await pool.query(
      `SELECT id, admin_id, admin_name, admin_email, action, target_type, target_name, details, created_at
       FROM admin_activity_logs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      success: true,
      data: {
        items: logsRes.rows,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1,
        limit
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/activity-logs/clear - Admin only: Clear all admin activity logs
router.delete('/activity-logs/clear', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM admin_activity_logs');
    res.json({ success: true, message: 'Semua log aktivitas admin berhasil dihapus.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/tryout-dashboard-stats - Get UTBK Tryout dashboard summary & analytics
router.get('/tryout-dashboard-stats', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { package_id } = req.query;
    
    // 1. Total users (students registered for or taking tryouts, filtered to student role)
    let totalStudentsQuery = '';
    let totalStudentsParams = [];
    if (package_id && package_id !== 'all') {
      totalStudentsQuery = `
        SELECT COUNT(DISTINCT r.user_id) as total
        FROM (
          SELECT tr.user_id 
          FROM tryout_registrations tr
          JOIN users u ON tr.user_id = u.id
          WHERE tr.package_type = 'utbk' AND tr.utbk_package_id = $1 AND u.role = 'student'
          UNION
          SELECT ts.user_id 
          FROM tryout_sessions ts
          JOIN users u ON ts.user_id = u.id
          WHERE ts.package_id = $1 AND u.role = 'student'
        ) as r
      `;
      totalStudentsParams.push(package_id);
    } else {
      totalStudentsQuery = `
        SELECT COUNT(DISTINCT r.user_id) as total
        FROM (
          SELECT tr.user_id 
          FROM tryout_registrations tr
          JOIN users u ON tr.user_id = u.id
          WHERE tr.package_type = 'utbk' AND u.role = 'student'
          UNION
          SELECT ts.user_id 
          FROM tryout_sessions ts
          JOIN users u ON ts.user_id = u.id
          WHERE u.role = 'student'
        ) as r
      `;
    }
    const totalStudentsRes = await pool.query(totalStudentsQuery, totalStudentsParams);
    const totalStudents = parseInt(totalStudentsRes.rows[0].total, 10) || 0;
    
    // 2. Active students today (started/submitted tryout today, filtered to student role)
    let activeTodayQuery = `
      SELECT COUNT(DISTINCT ts.user_id) as count
      FROM tryout_sessions ts
      JOIN users u ON ts.user_id = u.id
      WHERE (ts.started_at >= CURRENT_DATE OR ts.submitted_at >= CURRENT_DATE) AND u.role = 'student'
    `;
    let activeTodayParams = [];
    if (package_id && package_id !== 'all') {
      activeTodayQuery += " AND ts.package_id = $1";
      activeTodayParams.push(package_id);
    }
    const activeTodayRes = await pool.query(activeTodayQuery, activeTodayParams);
    const activeStudentsToday = parseInt(activeTodayRes.rows[0].count, 10) || 0;

    // 3. Running tryouts (started but not submitted, filtered to student role)
    let runningQuery = `
      SELECT COUNT(*) as count
      FROM tryout_sessions ts
      JOIN users u ON ts.user_id = u.id
      WHERE ts.submitted_at IS NULL AND u.role = 'student'
    `;
    let runningParams = [];
    if (package_id && package_id !== 'all') {
      runningQuery += " AND ts.package_id = $1";
      runningParams.push(package_id);
    }
    const runningRes = await pool.query(runningQuery, runningParams);
    const runningTryouts = parseInt(runningRes.rows[0].count, 10) || 0;

    // 4. Completed tryouts (submitted, filtered to student role)
    let completedQuery = `
      SELECT COUNT(*) as count
      FROM tryout_sessions ts
      JOIN users u ON ts.user_id = u.id
      WHERE ts.submitted_at IS NOT NULL AND u.role = 'student'
    `;
    let completedParams = [];
    if (package_id && package_id !== 'all') {
      completedQuery += " AND ts.package_id = $1";
      completedParams.push(package_id);
    }
    const completedRes = await pool.query(completedQuery, completedParams);
    const completedTryouts = parseInt(completedRes.rows[0].count, 10) || 0;

    // 5. Average score (filtered to student role)
    let avgScoreQuery = `
      SELECT ROUND(AVG(ts.total_score)::numeric, 1) as avg 
      FROM tryout_sessions ts
      JOIN users u ON ts.user_id = u.id
      WHERE ts.submitted_at IS NOT NULL AND u.role = 'student'
    `;
    let avgScoreParams = [];
    if (package_id && package_id !== 'all') {
      avgScoreQuery += " AND ts.package_id = $1";
      avgScoreParams.push(package_id);
    }
    const avgScoreRes = await pool.query(avgScoreQuery, avgScoreParams);
    const averageScore = parseFloat(avgScoreRes.rows[0]?.avg) || 0;

    // 6. Tryout Packages list for dropdown filter
    const packagesRes = await pool.query("SELECT id, title FROM tryout_packages ORDER BY created_at DESC");
    const packagesList = packagesRes.rows;

    // 7. Participation Trend (last 7 days, filtered to student role)
    let trendQuery = `
      SELECT DATE_TRUNC('day', COALESCE(ts.submitted_at, ts.started_at))::date as date, COUNT(*) as count
      FROM tryout_sessions ts
      JOIN users u ON ts.user_id = u.id
      WHERE COALESCE(ts.submitted_at, ts.started_at) >= NOW() - INTERVAL '7 days' AND u.role = 'student'
    `;
    let trendParams = [];
    if (package_id && package_id !== 'all') {
      trendQuery += " AND ts.package_id = $1";
      trendParams.push(package_id);
    }
    trendQuery += " GROUP BY date ORDER BY date";
    const trendRes = await pool.query(trendQuery, trendParams);
    const trendData = trendRes.rows.map(r => ({
      date: new Date(r.date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
      count: parseInt(r.count, 10) || 0
    }));

    // 8. Classical & IRT Subtest Averages (Parse JSON on node level, filtered to student role)
    let sessionsQuery = `
      SELECT ts.score_breakdown
      FROM tryout_sessions ts
      JOIN users u ON ts.user_id = u.id
      WHERE ts.submitted_at IS NOT NULL AND u.role = 'student'
    `;
    let sessionsParams = [];
    if (package_id && package_id !== 'all') {
      sessionsQuery += " AND ts.package_id = $1";
      sessionsParams.push(package_id);
    }
    const sessionsRes = await pool.query(sessionsQuery, sessionsParams);
    
    const subtestScores = {}; // subject_name -> { sum: 0, count: 0 }
    const distribution = {
      '0-400': 0,
      '401-500': 0,
      '501-600': 0,
      '601-700': 0,
      '701-800': 0,
      '801-1000': 0
    };

    sessionsRes.rows.forEach(r => {
      let breakdown = r.score_breakdown;
      if (typeof breakdown === 'string') {
        try { breakdown = JSON.parse(breakdown); } catch (e) { return; }
      }
      
      // Calculate subtest averages
      const subScores = breakdown?.subjectScores || {};
      Object.keys(subScores).forEach(subName => {
        const score = subScores[subName]?.score || 0;
        if (!subtestScores[subName]) {
          subtestScores[subName] = { sum: 0, count: 0 };
        }
        subtestScores[subName].sum += score;
        subtestScores[subName].count++;
      });

      // Calculate score distribution
      const score = breakdown?.totalScore || 0;
      if (score <= 400) distribution['0-400']++;
      else if (score <= 500) distribution['401-500']++;
      else if (score <= 600) distribution['501-600']++;
      else if (score <= 700) distribution['601-700']++;
      else if (score <= 800) distribution['701-800']++;
      else distribution['801-1000']++;
    });

    const subtestAverages = Object.keys(subtestScores).map(subName => ({
      name: subName,
      avg: Math.round(subtestScores[subName].sum / subtestScores[subName].count) || 0
    }));

    let leaderboard = [];
    if (package_id && package_id !== 'all') {
      const leaderboardRes = await pool.query(`
        SELECT DISTINCT ON (ts.user_id)
          ts.user_id,
          u.name,
          u.email,
          ts.total_score,
          ts.submitted_at
        FROM tryout_sessions ts
        JOIN users u ON u.id = ts.user_id
        WHERE ts.package_id = $1
          AND ts.submitted_at IS NOT NULL
          AND ts.total_score IS NOT NULL
          AND u.role = 'student'
        ORDER BY ts.user_id, ts.submitted_at DESC
      `, [package_id]);
      
      leaderboard = leaderboardRes.rows
        .map((r) => ({
          user_id: r.user_id,
          name: r.name,
          email: r.email,
          score: Math.round(r.total_score || 0),
          submitted_at: r.submitted_at
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((item, idx) => ({
          rank: idx + 1,
          ...item
        }));
    }

    res.json({
      success: true,
      data: {
        summary: {
          totalStudents,
          activeStudentsToday,
          runningTryouts,
          completedTryouts,
          averageScore
        },
        packages: packagesList,
        trend: trendData,
        subtests: subtestAverages,
        distribution: Object.keys(distribution).map(range => ({
          range,
          count: distribution[range]
        })),
        leaderboard
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /admin/question-review — Workflow review dashboard for Admin, QA, and Question Writer
router.get('/question-review', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const {
      workflow_status,
      subject_id,
      tryout_package_id,
      topic_id,
      search,
      page = 1,
      limit = 30,
    } = req.query;

    const safeLimit = Math.min(parseInt(limit, 10) || 30, 100);
    const safeOffset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * safeLimit;

    const values = [];
    let where = 'WHERE 1=1';

    if (workflow_status) {
      values.push(workflow_status);
      where += ` AND q.workflow_status = $${values.length}`;
    }
    if (subject_id) {
      values.push(subject_id);
      where += ` AND q.subject_id = $${values.length}`;
    }
    if (tryout_package_id) {
      values.push(tryout_package_id);
      where += ` AND q.tryout_package_id = $${values.length}`;
    }
    if (topic_id) {
      values.push(topic_id);
      where += ` AND q.topic_id = $${values.length}`;
    }
    if (search) {
      values.push(`%${search}%`);
      where += ` AND q.content ILIKE $${values.length}`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int as total FROM questions q ${where}`,
      values
    );
    const total = countRes.rows[0]?.total || 0;

    values.push(safeLimit);
    values.push(safeOffset);

    const dataRes = await pool.query(
      `SELECT q.id, q.content, q.difficulty, q.question_type, q.workflow_status,
              q.created_at, q.tryout_package_id, q.topic_id, q.stimulus,
              q.image_url, q.image_position, q.review_note,
              s.name as subject_name,
              tp.title as package_title,
              t.title as topic_title,
              u.name as creator_name,
              (SELECT COUNT(*) FROM answer_choices ac WHERE ac.question_id = q.id)::int as choices_count
       FROM questions q
       LEFT JOIN subjects s ON s.id = q.subject_id
       LEFT JOIN tryout_packages tp ON tp.id = q.tryout_package_id
       LEFT JOIN topics t ON t.id = q.topic_id
       LEFT JOIN users u ON u.id = q.created_by
       ${where}
       ORDER BY
         CASE q.workflow_status
           WHEN 'under_review' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'approved' THEN 3
         END,
         q.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    // Fetch choices for these questions
    if (dataRes.rows.length > 0) {
      const questionIds = dataRes.rows.map((q) => q.id);
      const placeholders = questionIds.map((_, i) => `$${i + 1}`).join(",");

      const choicesResult = await pool.query(
        `SELECT * FROM answer_choices WHERE question_id IN (${placeholders}) ORDER BY label ASC`,
        questionIds
      );

      for (const question of dataRes.rows) {
        question.choices = choicesResult.rows.filter(
          (c) => c.question_id === question.id
        );
      }
    }

    // Status summary counts
    const summaryRes = await pool.query(
      `SELECT workflow_status, COUNT(*)::int as count
       FROM questions
       GROUP BY workflow_status`
    );
    const summary = { draft: 0, under_review: 0, approved: 0 };
    summaryRes.rows.forEach(r => { summary[r.workflow_status] = r.count; });

    res.json({
      success: true,
      data: dataRes.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / safeLimit),
      summary,
    });
  } catch (error) {
    next(error);
  }
});

// ─── ADMIN TRANSACTIONS & INVOICE LOGS ──────────────────────────────────────────

const { activateUserPlans, recalculateUserCurrentPlan } = require('./subscription');

// GET /admin/transactions — List all payment transactions & invoices with analytics
router.get('/transactions', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const {
      status,
      search,
      target_type,
      start_date,
      end_date,
      page = 1,
      limit = 20,
    } = req.query;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    // Auto-expire pending transactions created more than 24 hours ago (Midtrans default max)
    await pool.query(
      `UPDATE payment_transactions
       SET status = 'expire', updated_at = NOW()
       WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'`
    );

    const safeOffset = (safePage - 1) * safeLimit;

    const values = [];
    let where = 'WHERE 1=1';

    if (status && status !== 'all') {
      values.push(status);
      where += ` AND pt.status = $${values.length}`;
    }
    if (search && search.trim()) {
      values.push(`%${search.trim()}%`);
      where += ` AND (pt.order_id ILIKE $${values.length} OR u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`;
    }
    if (target_type && target_type !== 'all') {
      values.push(target_type);
      where += ` AND p.target_type = $${values.length}`;
    }
    if (start_date) {
      values.push(start_date);
      where += ` AND pt.created_at >= $${values.length}`;
    }
    if (end_date) {
      values.push(end_date);
      where += ` AND pt.created_at <= $${values.length}::date + INTERVAL '1 day'`;
    }

    // 1. Total matching count
    const countRes = await pool.query(
      `SELECT COUNT(*)::int as total
       FROM payment_transactions pt
       JOIN users u ON u.id = pt.user_id
       LEFT JOIN plans p ON p.id = pt.plan_id
       ${where}`,
      values
    );
    const total = countRes.rows[0]?.total || 0;

    // 2. Fetch paginated list
    const txDataValues = [...values, safeLimit, safeOffset];
    const txLimitPlaceholder = `$${values.length + 1}`;
    const txOffsetPlaceholder = `$${values.length + 2}`;

    const txRes = await pool.query(
      `SELECT pt.id, pt.user_id, pt.plan_id, pt.order_id, pt.amount, pt.status,
              pt.payment_type, pt.snap_token, pt.snap_redirect_url, pt.voucher_id,
              pt.created_at, pt.updated_at,
              u.name as user_name, u.email as user_email, NULL as user_avatar,
              p.name as plan_name, p.display_name as plan_display_name, p.target_type,
              p.plan_type, p.duration_days, p.price as plan_price,
              v.code as voucher_code, v.discount_type, v.discount_value
       FROM payment_transactions pt
       JOIN users u ON u.id = pt.user_id
       LEFT JOIN plans p ON p.id = pt.plan_id
       LEFT JOIN vouchers v ON v.id = pt.voucher_id
       ${where}
       ORDER BY pt.created_at DESC
       LIMIT ${txLimitPlaceholder} OFFSET ${txOffsetPlaceholder}`,
      txDataValues
    );

    // 3. Aggregate order items for bundle transactions
    const transactionIds = txRes.rows.map(r => r.id);
    if (transactionIds.length > 0) {
      const itemsRes = await pool.query(
        `SELECT oi.transaction_id, oi.price, p.name, p.display_name, p.target_type, p.duration_days
         FROM order_items oi
         JOIN plans p ON p.id = oi.plan_id
         WHERE oi.transaction_id = ANY($1)`,
        [transactionIds]
      );
      const itemsMap = {};
      itemsRes.rows.forEach(item => {
        if (!itemsMap[item.transaction_id]) itemsMap[item.transaction_id] = [];
        itemsMap[item.transaction_id].push(item);
      });
      txRes.rows.forEach(tx => {
        tx.items = itemsMap[tx.id] || [];
      });
    }

    // 4. Overall Analytics Summary
    const statsRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'settlement' THEN amount ELSE 0 END), 0)::numeric as total_revenue,
        COUNT(CASE WHEN status = 'settlement' THEN 1 END)::int as settlement_count,
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int as pending_count,
        COUNT(CASE WHEN status IN ('expire', 'cancel', 'deny') THEN 1 END)::int as failed_count,
        COALESCE(SUM(CASE WHEN status = 'settlement' AND created_at >= CURRENT_DATE THEN amount ELSE 0 END), 0)::numeric as today_revenue,
        COALESCE(SUM(CASE WHEN status = 'settlement' AND created_at >= date_trunc('month', CURRENT_DATE) THEN amount ELSE 0 END), 0)::numeric as monthly_revenue
      FROM payment_transactions
    `);
    const summary = statsRes.rows[0] || {
      total_revenue: 0,
      settlement_count: 0,
      pending_count: 0,
      failed_count: 0,
      today_revenue: 0,
      monthly_revenue: 0,
    };

    res.json({
      success: true,
      data: txRes.rows,
      total,
      page: safePage,
      totalPages: Math.ceil(total / safeLimit),
      summary,
    });
  } catch (error) {
    next(error);
  }
});

// GET /admin/transactions/:id — Get full invoice breakdown & details
router.get('/transactions/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const txRes = await pool.query(
      `SELECT pt.*,
              u.name as user_name, u.email as user_email, NULL as user_avatar, u.created_at as user_registered_at,
              p.name as plan_name, p.display_name as plan_display_name, p.target_type,
              p.plan_type, p.duration_days, p.price as plan_price, p.features,
              v.code as voucher_code, v.discount_type, v.discount_value
       FROM payment_transactions pt
       JOIN users u ON u.id = pt.user_id
       LEFT JOIN plans p ON p.id = pt.plan_id
       LEFT JOIN vouchers v ON v.id = pt.voucher_id
       WHERE pt.id::text = $1 OR pt.order_id = $1`,
      [id]
    );

    if (txRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan.' });
    }

    const tx = txRes.rows[0];

    // Fetch order items
    const itemsRes = await pool.query(
      `SELECT oi.*, p.name, p.display_name, p.target_type, p.duration_days, p.price as list_price
       FROM order_items oi
       JOIN plans p ON p.id = oi.plan_id
       WHERE oi.transaction_id::text = $1 OR oi.transaction_id = $2`,
      [tx.id, tx.id]
    );
    tx.items = itemsRes.rows;

    res.json({ success: true, data: tx });
  } catch (error) {
    next(error);
  }
});

// POST /admin/transactions/:id/confirm-manual — Manually confirm pending payment & activate subscription
router.post('/transactions/:id/confirm-manual', verifyToken, verifyAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT * FROM payment_transactions WHERE id::text = $1 OR order_id = $1 FOR UPDATE`,
      [id]
    );

    if (txRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan.' });
    }

    const tx = txRes.rows[0];

    // Update status to settlement
    await client.query(
      `UPDATE payment_transactions
       SET status = 'settlement', updated_at = NOW()
       WHERE id = $1`,
      [tx.id]
    );

    // Call activation helper with duration stacking
    await activateUserPlans(client, tx);

    await client.query('COMMIT');

    // Trigger email notification
    try {
      const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [tx.user_id]);
      if (userRes.rows.length > 0) {
        const u = userRes.rows[0];
        const { sendPremiumPlanActivatedEmail } = require('../services/emailService');
        sendPremiumPlanActivatedEmail(u.email, u.name, tx.order_id, tx.amount, tx.order_id)
          .catch(e => console.error('Manual confirm email error:', e));
      }
    } catch {}

    res.json({ success: true, message: 'Transaksi berhasil dikonfirmasi dan paket user telah diaktifkan!' });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// ─── ADMIN PREMIUM USER & SUBSCRIPTION MANAGEMENT ──────────────────────────────

// GET /admin/subscriptions/plans — List active plans for grant modal
router.get('/subscriptions/plans', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, display_name, target_type, plan_type, duration_days, price, quota_limit
       FROM plans
       WHERE is_active = true
       ORDER BY target_type, duration_days`
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// GET /admin/subscriptions — List all user subscriptions with real-time remaining time
router.get('/subscriptions', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const {
      status, // 'all' | 'active' | 'expiring_soon' | 'expired'
      target_type, // 'all' | 'utbk' | 'um' | 'cpns'
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeOffset = (safePage - 1) * safeLimit;

    const values = [];
    let where = 'WHERE 1=1';

    if (status === 'active') {
      where += ` AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > NOW())`;
    } else if (status === 'expiring_soon') {
      where += ` AND s.status = 'active' AND s.expires_at > NOW() AND s.expires_at <= (NOW() + INTERVAL '7 days')`;
    } else if (status === 'expired') {
      where += ` AND (s.status = 'cancelled' OR (s.status = 'active' AND s.expires_at <= NOW()))`;
    }

    if (target_type && target_type !== 'all') {
      values.push(target_type);
      where += ` AND p.target_type = $${values.length}`;
    }

    if (search && search.trim()) {
      values.push(`%${search.trim()}%`);
      where += ` AND (u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`;
    }

    // 1. Total count
    const countRes = await pool.query(
      `SELECT COUNT(*)::int as total
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN plans p ON p.id = s.plan_id
       ${where}`,
      values
    );
    const total = countRes.rows[0]?.total || 0;

    // 2. Fetch subscriptions list
    const subDataValues = [...values, safeLimit, safeOffset];
    const subLimitPlaceholder = `$${values.length + 1}`;
    const subOffsetPlaceholder = `$${values.length + 2}`;

    const subsRes = await pool.query(
      `SELECT s.id, s.user_id, s.plan_id, s.status,
              COALESCE(s.started_at, s.created_at) as starts_at, s.expires_at,
              s.quota_remaining, s.created_at,
              (SELECT pt.order_id FROM payment_transactions pt WHERE pt.user_id = s.user_id AND pt.status = 'settlement' ORDER BY pt.created_at DESC LIMIT 1) as order_id,
              u.name as user_name, u.email as user_email, NULL as user_avatar,
              u.current_plan as user_current_plan, u.role as user_role,
              p.name as plan_name, p.display_name as plan_display_name, p.target_type,
              p.plan_type, p.duration_days, p.price as plan_price,
              ROUND(EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 86400, 1) as days_remaining,
              ROUND(EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 3600, 1) as hours_remaining,
              CASE
                WHEN s.status != 'active' THEN s.status
                WHEN s.expires_at <= NOW() THEN 'expired'
                WHEN s.expires_at <= (NOW() + INTERVAL '7 days') THEN 'expiring_soon'
                ELSE 'active'
              END as computed_status
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN plans p ON p.id = s.plan_id
       ${where}
       ORDER BY
         CASE WHEN s.status = 'active' AND s.expires_at > NOW() THEN 1 ELSE 2 END,
         s.expires_at ASC NULLS LAST,
         s.created_at DESC
       LIMIT ${subLimitPlaceholder} OFFSET ${subOffsetPlaceholder}`,
      subDataValues
    );

    // 3. Summary Analytics
    const summaryRes = await pool.query(`
      SELECT
        COUNT(CASE WHEN s.status = 'active' AND s.expires_at > NOW() THEN 1 END)::int as total_active,
        COUNT(CASE WHEN s.status = 'active' AND s.expires_at > NOW() AND p.target_type = 'utbk' THEN 1 END)::int as utbk_active,
        COUNT(CASE WHEN s.status = 'active' AND s.expires_at > NOW() AND p.target_type = 'um' THEN 1 END)::int as um_active,
        COUNT(CASE WHEN s.status = 'active' AND s.expires_at > NOW() AND p.target_type = 'cpns' THEN 1 END)::int as cpns_active,
        COUNT(CASE WHEN s.status = 'active' AND s.expires_at > NOW() AND s.expires_at <= (NOW() + INTERVAL '7 days') THEN 1 END)::int as expiring_soon,
        COUNT(CASE WHEN s.status = 'cancelled' OR (s.status = 'active' AND s.expires_at <= NOW()) THEN 1 END)::int as expired_count
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
    `);

    const summary = summaryRes.rows[0] || {
      total_active: 0,
      utbk_active: 0,
      um_active: 0,
      cpns_active: 0,
      expiring_soon: 0,
      expired_count: 0,
    };

    res.json({
      success: true,
      data: subsRes.rows,
      total,
      page: safePage,
      totalPages: Math.ceil(total / safeLimit),
      summary,
    });
  } catch (error) {
    next(error);
  }
});

// POST /admin/subscriptions/grant — Manually grant / activate a plan for a user
router.post('/subscriptions/grant', verifyToken, verifyAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { user_id, plan_id, duration_days, note } = req.body;
    if (!user_id || !plan_id) {
      return res.status(400).json({ success: false, error: 'User ID dan Plan ID wajib diisi.' });
    }

    await client.query('BEGIN');

    // Fetch plan details
    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
    if (planRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Paket langganan tidak ditemukan.' });
    }
    const plan = planRes.rows[0];
    const daysToAdd = parseInt(duration_days, 10) || plan.duration_days || 30;

    // Check if user already has an active subscription of this plan
    const activeSubRes = await client.query(
      `SELECT id, expires_at FROM subscriptions
       WHERE user_id = $1 AND plan_id = $2 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [user_id, plan_id]
    );

    let expiresAt = new Date();
    if (activeSubRes.rows.length > 0) {
      expiresAt = new Date(activeSubRes.rows[0].expires_at);
    }
    expiresAt.setDate(expiresAt.getDate() + daysToAdd);

    // Deactivate old active subscriptions of same plan
    await client.query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1 AND plan_id = $2 AND status = 'active'`,
      [user_id, plan_id]
    );

    // Insert new subscription
    const insertSubRes = await client.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, started_at, expires_at)
       VALUES ($1, $2, 'active', NOW(), $3)
       RETURNING *`,
      [user_id, plan_id, expiresAt]
    );

    // Recalculate user current_plan
    const newPlan = await recalculateUserCurrentPlan(client, user_id);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Berhasil memberikan paket ${plan.display_name} (${daysToAdd} hari) kepada user!`,
      data: insertSubRes.rows[0],
      current_plan: newPlan,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// PUT /admin/subscriptions/:id/extend — Extend active subscription by days or set new date
router.put('/subscriptions/:id/extend', verifyToken, verifyAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { additional_days, new_expires_at, note } = req.body;

    await client.query('BEGIN');

    const subRes = await client.query(
      `SELECT s.*, p.display_name as plan_display_name
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.id = $1 FOR UPDATE`,
      [id]
    );

    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Langganan tidak ditemukan.' });
    }

    const sub = subRes.rows[0];
    let updatedExpiresAt;

    if (new_expires_at) {
      updatedExpiresAt = new Date(new_expires_at);
    } else {
      const days = parseInt(additional_days, 10) || 30;
      let baseDate = new Date();
      if (sub.expires_at && new Date(sub.expires_at) > new Date()) {
        baseDate = new Date(sub.expires_at);
      }
      baseDate.setDate(baseDate.getDate() + days);
      updatedExpiresAt = baseDate;
    }

    await client.query(
      `UPDATE subscriptions
       SET expires_at = $1, status = 'active'
       WHERE id = $2`,
      [updatedExpiresAt, sub.id]
    );

    // Recalculate user current_plan
    const newPlan = await recalculateUserCurrentPlan(client, sub.user_id);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Masa aktif langganan ${sub.plan_display_name} berhasil diperpanjang hingga ${updatedExpiresAt.toLocaleDateString('id-ID')}!`,
      expires_at: updatedExpiresAt,
      current_plan: newPlan,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// POST /admin/subscriptions/:id/revoke — Revoke / cancel a user subscription
router.post('/subscriptions/:id/revoke', verifyToken, verifyAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const subRes = await client.query(
      `SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Langganan tidak ditemukan.' });
    }

    const sub = subRes.rows[0];

    await client.query(
      `UPDATE subscriptions
       SET status = 'cancelled', expires_at = NOW()
       WHERE id = $1`,
      [sub.id]
    );

    const newPlan = await recalculateUserCurrentPlan(client, sub.user_id);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Langganan berhasil dinonaktifkan (dicabut).',
      current_plan: newPlan,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
