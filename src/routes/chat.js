const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { chatLimiter } = require('../middleware/rateLimiter');
const { chatWithStu, chatKonsultasi } = require('../services/nineRouterService');
const { chatDiscussQuestionWithDeepSeek } = require('../services/deepseekService');

const MONTHLY_AI_MESSAGE_LIMIT = 600; // 600 messages per user per month

const getMonthYearString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

// GET /quota - Check remaining monthly AI quota for current user
router.get('/quota', verifyToken, async (req, res, next) => {
  try {
    const monthYear = getMonthYearString();
    const usageRes = await pool.query(
      `SELECT message_count FROM user_ai_usage WHERE user_id = $1 AND month_year = $2`,
      [req.user.id, monthYear]
    );

    const usedCount = usageRes.rows[0]?.message_count || 0;
    const remaining = Math.max(0, MONTHLY_AI_MESSAGE_LIMIT - usedCount);

    res.json({
      success: true,
      data: {
        used: usedCount,
        limit: MONTHLY_AI_MESSAGE_LIMIT,
        remaining,
        monthYear
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', verifyToken, chatLimiter, async (req, res, next) => {
  try {
    const { message, history } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    const reply = await chatWithStu(message, history || []);
    
    res.json({ 
      success: true, 
      data: {
        reply
      }
    });
  } catch (error) {
    next(error);
  }
});

// Discuss a specific question with Bia (Requires Premium & DeepSeek AI with 600 monthly limit)
router.post('/discuss', verifyToken, chatLimiter, async (req, res, next) => {
  try {
    const { message, questionContext, history } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    if (!questionContext) {
      return res.status(400).json({ success: false, error: 'Question context is required' });
    }

    // Verify user plan access for AI discussion
    const userRes = await pool.query("SELECT role, current_plan FROM users WHERE id = $1", [req.user.id]);
    const user = userRes.rows[0];

    const isAdmin = user && user.role === 'admin';
    let hasAccess = user && (isAdmin || user.current_plan === 'premium' || user.current_plan?.startsWith('utbk_'));

    if (!hasAccess && user) {
      const subRes = await pool.query(
        `SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
         AND (p.target_type = 'utbk' OR p.target_type = 'all')
         LIMIT 1`,
        [req.user.id]
      );
      if (subRes.rows.length > 0) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        requires_premium: true,
        error: 'Fitur Tutor AI (Bia) memerlukan Paket Premium UTBK. Silakan upgrade paket belajar Anda.'
      });
    }

    // Check monthly quota (except for admins)
    const monthYear = getMonthYearString();
    let currentUsage = 0;

    if (!isAdmin) {
      const usageRes = await pool.query(
        `SELECT message_count FROM user_ai_usage WHERE user_id = $1 AND month_year = $2`,
        [req.user.id, monthYear]
      );
      currentUsage = usageRes.rows[0]?.message_count || 0;

      if (currentUsage >= MONTHLY_AI_MESSAGE_LIMIT) {
        return res.status(429).json({
          success: false,
          quota_exceeded: true,
          error: `Kuota diskusi AI kamu bulan ini telah habis (${MONTHLY_AI_MESSAGE_LIMIT}/${MONTHLY_AI_MESSAGE_LIMIT} pesan). Kuota akan diperbarui pada tanggal 1 bulan depan!`,
          data: {
            used: currentUsage,
            limit: MONTHLY_AI_MESSAGE_LIMIT,
            remaining: 0
          }
        });
      }
    }

    // Generate response via DeepSeek (with automatic 9Router fallback)
    const reply = await chatDiscussQuestionWithDeepSeek(message, questionContext, history || []);

    // Increment monthly usage count for non-admin users
    let remainingQuota = MONTHLY_AI_MESSAGE_LIMIT;
    if (!isAdmin) {
      const updatedUsageRes = await pool.query(
        `INSERT INTO user_ai_usage (user_id, month_year, message_count, last_used_at)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (user_id, month_year)
         DO UPDATE SET message_count = user_ai_usage.message_count + 1, last_used_at = NOW()
         RETURNING message_count`,
        [req.user.id, monthYear]
      );
      const newUsedCount = updatedUsageRes.rows[0]?.message_count || (currentUsage + 1);
      remainingQuota = Math.max(0, MONTHLY_AI_MESSAGE_LIMIT - newUsedCount);
    }
    
    res.json({ 
      success: true, 
      data: {
        reply,
        quota: {
          limit: MONTHLY_AI_MESSAGE_LIMIT,
          remaining: isAdmin ? 9999 : remainingQuota
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// Konsultasi belajar & PTN with Stu
router.post('/konsultasi', verifyToken, chatLimiter, async (req, res, next) => {
  try {
    const { message, history } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    const reply = await chatKonsultasi(message, history || []);
    
    res.json({ 
      success: true, 
      data: { reply }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
