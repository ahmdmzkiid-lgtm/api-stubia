const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { isAdminUser, hasActiveFundamentalUtbkSubscription } = require('../utils/latihanAccessUtil');
const { logAdminActivity } = require('../utils/activityLogger');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware: Require UTBK Premium (3m, 6m, 9m, 12m) or staff/admin
const requireFundamentalAccess = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const isStaff = await isAdminUser(userId, req.user.role);
    if (isStaff) {
      return next();
    }

    const hasAccess = await hasActiveFundamentalUtbkSubscription(userId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Fitur Fundamental UTBK hanya khusus untuk pengguna Paket Premium UTBK (3 Bulan, 6 Bulan, 9 Bulan, atau 12 Bulan). Silakan berlangganan untuk membuka akses materi, kuis, dan drilling soal.',
        code: 'PREMIUM_UTBK_REQUIRED'
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Canonical UTBK Subject ordering
const SUBTEST_ORDER = [
  'penalaran umum',
  'pemahaman dan pengetahuan umum',
  'pengetahuan dan pemahaman umum',
  'pemahaman bacaan dan tulisan',
  'penalaran kuantitatif',
  'pengetahuan kuantitatif',
  'literasi bahasa indonesia',
  'literasi bahasa inggris',
  'penalaran matematika',
];

function getSubtestIdx(title) {
  const lower = (title || '').toLowerCase().trim();
  const idx = SUBTEST_ORDER.findIndex((s) => lower.includes(s) || s.includes(lower));
  return idx === -1 ? 999 : idx;
}

// ============================================================================
// STUDENT ENDPOINTS
// ============================================================================

/**
 * GET /api/fundamental/subjects
 * Get all UTBK subjects with student's fundamental progress
 */
router.get('/subjects', verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const isStaff = await isAdminUser(userId, req.user.role);
    const hasAccess = isStaff || (await hasActiveFundamentalUtbkSubscription(userId));

    // 1. Get all active subjects
    const subjectsRes = await pool.query(`
      SELECT 
        s.id, s.name, s.title, s.description, s.icon, s.bg_color, s.icon_color, s.category, s.required_plan,
        COALESCE(m.total_materials, 0)::int AS total_materials,
        COALESCE(p.completed_materials, 0)::int AS completed_materials,
        COALESCE(d.drilling_questions_count, 0)::int AS drilling_questions_count,
        COALESCE(ds.user_drilling_attempts, 0)::int AS user_drilling_attempts,
        COALESCE(ds.best_drilling_score, 0)::float AS best_drilling_score
      FROM subjects s
      LEFT JOIN (
        SELECT subject_id, COUNT(*) AS total_materials
        FROM fundamental_materials
        WHERE is_active = TRUE
        GROUP BY subject_id
      ) m ON m.subject_id = s.id
      LEFT JOIN (
        SELECT fm.subject_id, COUNT(DISTINCT fup.material_id) AS completed_materials
        FROM fundamental_user_progress fup
        JOIN fundamental_materials fm ON fm.id = fup.material_id
        WHERE fup.user_id = $1 AND fup.is_quiz_passed = TRUE AND fm.is_active = TRUE
        GROUP BY fm.subject_id
      ) p ON p.subject_id = s.id
      LEFT JOIN (
        SELECT subject_id, COUNT(*) AS drilling_questions_count
        FROM fundamental_drilling_questions
        WHERE is_active = TRUE
        GROUP BY subject_id
      ) d ON d.subject_id = s.id
      LEFT JOIN (
        SELECT subject_id, COUNT(*) AS user_drilling_attempts, MAX(score) AS best_drilling_score
        FROM fundamental_drilling_sessions
        WHERE user_id = $1
        GROUP BY subject_id
      ) ds ON ds.subject_id = s.id
      WHERE s.is_active = TRUE
      ORDER BY s.name ASC
    `, [userId]);

    // Filter out subjects with numbered suffixes (e.g. 'Penalaran Umum 1', 'Penalaran Matematika 2')
    const filtered = subjectsRes.rows.filter(s => {
      const name = (s.title || s.name || '').trim();
      return !/\s+\d+$/.test(name);
    });

    const sorted = [...filtered].sort((a, b) => {
      const idxA = getSubtestIdx(a.title || a.name);
      const idxB = getSubtestIdx(b.title || b.name);
      return idxA - idxB;
    });

    const mapped = sorted.map((s) => ({
      ...s,
      is_drilling_unlocked: s.total_materials > 0 && s.completed_materials >= s.total_materials,
      progress_percentage: s.total_materials > 0 ? Math.round((s.completed_materials / s.total_materials) * 100) : 0
    }));

    res.json({ success: true, data: mapped, has_access: hasAccess });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/fundamental/subjects/:subjectId/materials
 * Get list of materials for a subject with unlock status & user scores
 */
router.get('/subjects/:subjectId/materials', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const userId = req.user.id;

    // 1. Get subject details
    const subjectRes = await pool.query('SELECT * FROM subjects WHERE id = $1', [subjectId]);
    if (subjectRes.rows.length === 0) {
      return res.status(404).json({ error: 'Subtes tidak ditemukan' });
    }
    const subject = subjectRes.rows[0];

    // 2. Get materials with user progress
    const materialsRes = await pool.query(`
      SELECT 
        fm.id, fm.subject_id, fm.title, fm.description, fm.image_url, fm.image_position, fm.order_index, fm.estimated_read_minutes,
        fm.passing_score, fm.is_active, fm.created_at,
        COALESCE(qc.total_quizzes, 0)::int AS total_quizzes,
        fup.is_material_read,
        COALESCE(fup.is_quiz_passed, FALSE) AS is_quiz_passed,
        COALESCE(fup.best_quiz_score, 0)::int AS best_quiz_score,
        COALESCE(fup.attempts_count, 0)::int AS attempts_count,
        fup.completed_at
      FROM fundamental_materials fm
      LEFT JOIN (
        SELECT material_id, COUNT(*) AS total_quizzes
        FROM fundamental_quizzes
        GROUP BY material_id
      ) qc ON qc.material_id = fm.id
      LEFT JOIN fundamental_user_progress fup 
        ON fup.material_id = fm.id AND fup.user_id = $2
      WHERE fm.subject_id = $1 AND fm.is_active = TRUE
      ORDER BY fm.order_index ASC, fm.created_at ASC
    `, [subjectId, userId]);

    const materials = materialsRes.rows;

    // 3. Compute unlock status sequentially
    // The 1st material is always unlocked.
    // Material (i) is unlocked if Material (i-1) is_quiz_passed is TRUE.
    let allCompleted = true;
    let unlockedMaterialsCount = 0;

    const materialsWithUnlock = materials.map((m, index) => {
      let is_unlocked = false;
      if (index === 0) {
        is_unlocked = true;
      } else {
        const prevMaterial = materials[index - 1];
        is_unlocked = !!prevMaterial.is_quiz_passed;
      }

      if (is_unlocked) unlockedMaterialsCount++;
      if (!m.is_quiz_passed) allCompleted = false;

      return {
        ...m,
        is_unlocked,
      };
    });

    // 4. Check drilling questions count
    const drillingCountRes = await pool.query(`
      SELECT COUNT(*)::int AS drilling_count 
      FROM fundamental_drilling_questions 
      WHERE subject_id = $1 AND is_active = TRUE
    `, [subjectId]);

    const drillingSessionsRes = await pool.query(`
      SELECT COUNT(*)::int AS attempts_count, COALESCE(MAX(score), 0)::float AS best_score
      FROM fundamental_drilling_sessions
      WHERE subject_id = $1 AND user_id = $2
    `, [subjectId, userId]);

    const isDrillingUnlocked = materials.length > 0 && allCompleted;

    res.json({
      success: true,
      data: {
        subject,
        materials: materialsWithUnlock,
        total_materials: materials.length,
        completed_materials: materials.filter(m => m.is_quiz_passed).length,
        is_drilling_unlocked: isDrillingUnlocked,
        drilling_questions_count: drillingCountRes.rows[0]?.drilling_count || 0,
        drilling_attempts_count: drillingSessionsRes.rows[0]?.attempts_count || 0,
        drilling_best_score: drillingSessionsRes.rows[0]?.best_score || 0,
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/fundamental/materials/:materialId
 * Get single material detail with reading content and adjacent material IDs
 */
router.get('/materials/:materialId', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { materialId } = req.params;
    const userId = req.user.id;

    // 1. Get material
    const materialRes = await pool.query(`
      SELECT fm.*, s.title AS subject_title, s.name AS subject_name, s.icon AS subject_icon, s.bg_color, s.icon_color
      FROM fundamental_materials fm
      JOIN subjects s ON s.id = fm.subject_id
      WHERE fm.id = $1
    `, [materialId]);

    if (materialRes.rows.length === 0) {
      return res.status(404).json({ error: 'Materi tidak ditemukan' });
    }
    const material = materialRes.rows[0];

    // 2. Check unlock permission by inspecting all sibling materials
    const siblingMaterialsRes = await pool.query(`
      SELECT fm.id, fm.order_index, COALESCE(fup.is_quiz_passed, FALSE) AS is_quiz_passed
      FROM fundamental_materials fm
      LEFT JOIN fundamental_user_progress fup ON fup.material_id = fm.id AND fup.user_id = $2
      WHERE fm.subject_id = $1 AND fm.is_active = TRUE
      ORDER BY fm.order_index ASC, fm.created_at ASC
    `, [material.subject_id, userId]);

    const siblings = siblingMaterialsRes.rows;
    const currentIndex = siblings.findIndex(s => s.id === materialId);

    if (currentIndex === -1) {
      return res.status(404).json({ error: 'Materi tidak aktif atau tidak ditemukan' });
    }

    const isUnlocked = currentIndex === 0 || !!siblings[currentIndex - 1].is_quiz_passed;
    if (!isUnlocked && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Materi ini masih terkunci. Selesaikan materi dan kuis sebelumnya terlebih dahulu!' });
    }

    const prevMaterialId = currentIndex > 0 ? siblings[currentIndex - 1].id : null;
    const nextMaterialId = currentIndex < siblings.length - 1 ? siblings[currentIndex + 1].id : null;

    // 3. User progress on this material
    const progressRes = await pool.query(`
      SELECT is_material_read, is_quiz_passed, best_quiz_score, attempts_count
      FROM fundamental_user_progress
      WHERE user_id = $1 AND material_id = $2
    `, [userId, materialId]);

    const userProgress = progressRes.rows[0] || {
      is_material_read: false,
      is_quiz_passed: false,
      best_quiz_score: 0,
      attempts_count: 0
    };

    // 4. Quiz questions count
    const quizCountRes = await pool.query(`
      SELECT COUNT(*)::int AS quiz_count
      FROM fundamental_quizzes
      WHERE material_id = $1
    `, [materialId]);

    res.json({
      success: true,
      data: {
        material,
        userProgress,
        quizCount: quizCountRes.rows[0]?.quiz_count || 0,
        prevMaterialId,
        nextMaterialId,
        isUnlocked: true,
        materialIndex: currentIndex + 1,
        totalMaterials: siblings.length
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/materials/:materialId/read
 * Mark material as read
 */
router.post('/materials/:materialId/read', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { materialId } = req.params;
    const userId = req.user.id;

    await pool.query(`
      INSERT INTO fundamental_user_progress (user_id, material_id, is_material_read, updated_at)
      VALUES ($1, $2, TRUE, NOW())
      ON CONFLICT (user_id, material_id)
      DO UPDATE SET is_material_read = TRUE, updated_at = NOW()
    `, [userId, materialId]);

    res.json({ success: true, message: 'Materi ditandai telah dibaca' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/fundamental/materials/:materialId/quiz
 * Get 10 quiz questions for this material (without exposing answers/explanations)
 */
router.get('/materials/:materialId/quiz', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { materialId } = req.params;
    const userId = req.user.id;

    // 1. Check material & access
    const materialRes = await pool.query(`
      SELECT fm.*, s.title AS subject_title, s.name AS subject_name 
      FROM fundamental_materials fm
      JOIN subjects s ON s.id = fm.subject_id
      WHERE fm.id = $1
    `, [materialId]);

    if (materialRes.rows.length === 0) {
      return res.status(404).json({ error: 'Materi tidak ditemukan' });
    }
    const material = materialRes.rows[0];

    // 2. Fetch quiz questions and options
    const questionsRes = await pool.query(`
      SELECT q.id, q.material_id, q.question_text, q.stimulus, q.image_url, q.image_position, q.difficulty, q.display_order
      FROM fundamental_quizzes q
      WHERE q.material_id = $1
      ORDER BY q.display_order ASC, q.created_at ASC
      LIMIT 10
    `, [materialId]);

    if (questionsRes.rows.length === 0) {
      return res.status(404).json({ error: 'Kuis untuk materi ini belum tersedia. Silakan hubungi admin.' });
    }

    const questionIds = questionsRes.rows.map(q => q.id);

    const optionsRes = await pool.query(`
      SELECT id, quiz_id, label, content
      FROM fundamental_quiz_options
      WHERE quiz_id = ANY($1)
      ORDER BY label ASC
    `, [questionIds]);

    const optionsMap = {};
    optionsRes.rows.forEach(opt => {
      if (!optionsMap[opt.quiz_id]) optionsMap[opt.quiz_id] = [];
      optionsMap[opt.quiz_id].push(opt);
    });

    const questions = questionsRes.rows.map((q, idx) => ({
      ...q,
      number: idx + 1,
      options: optionsMap[q.id] || []
    }));

    res.json({
      success: true,
      data: {
        material: {
          id: material.id,
          title: material.title,
          subject_id: material.subject_id,
          subject_title: material.subject_title || material.subject_name
        },
        totalQuestions: questions.length,
        questions
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/quiz/submit
 * Submit answers for 10-question quiz, compute score, unlock next material
 */
router.post('/quiz/submit', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const { material_id, answers = [], time_spent_seconds = 0 } = req.body;

    if (!material_id) {
      return res.status(400).json({ error: 'material_id is required' });
    }

    await client.query('BEGIN');

    // 1. Fetch material info
    const matRes = await client.query('SELECT * FROM fundamental_materials WHERE id = $1', [material_id]);
    if (matRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Materi tidak ditemukan' });
    }
    const material = matRes.rows[0];

    // 2. Fetch all quizzes and correct choices for this material
    const quizzesRes = await client.query(`
      SELECT q.id AS quiz_id, q.question_text, q.display_order,
             qo.id AS correct_choice_id, qo.label AS correct_label, qo.explanation
      FROM fundamental_quizzes q
      LEFT JOIN fundamental_quiz_options qo ON qo.quiz_id = q.id AND qo.is_correct = TRUE
      WHERE q.material_id = $1
      ORDER BY q.display_order ASC
    `, [material_id]);

    const totalQuestions = quizzesRes.rows.length;
    if (totalQuestions === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tidak ada soal kuis untuk materi ini' });
    }

    const answersMap = {};
    answers.forEach(a => {
      answersMap[a.quiz_id] = a;
    });

    let correctCount = 0;
    let incorrectCount = 0;
    let unansweredCount = 0;
    const answersPayload = [];

    for (const q of quizzesRes.rows) {
      const userAns = answersMap[q.quiz_id];
      const chosenChoiceId = userAns ? userAns.chosen_option_id : null;
      const chosenLabel = userAns ? userAns.label : null;

      let isCorrect = false;
      if (!chosenChoiceId) {
        unansweredCount++;
      } else if (chosenChoiceId === q.correct_choice_id) {
        correctCount++;
        isCorrect = true;
      } else {
        incorrectCount++;
      }

      answersPayload.push({
        quiz_id: q.quiz_id,
        chosen_choice_id: chosenChoiceId,
        chosen_label: chosenLabel,
        correct_choice_id: q.correct_choice_id,
        correct_label: q.correct_label,
        is_correct: isCorrect,
        time_spent_sec: userAns?.time_spent_sec || 0
      });
    }

    const score = Math.round((correctCount / totalQuestions) * 100);
    const passingScore = material.passing_score !== undefined && material.passing_score !== null ? material.passing_score : 70;
    const isPassed = score >= passingScore;

    // 3. Insert quiz session record
    const sessionRes = await client.query(`
      INSERT INTO fundamental_quiz_sessions (
        user_id, material_id, total_questions, correct_count, incorrect_count, unanswered_count,
        score, is_passed, answers_payload, time_spent_seconds, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id
    `, [
      userId, material_id, totalQuestions, correctCount, incorrectCount, unansweredCount,
      score, isPassed, JSON.stringify(answersPayload), time_spent_seconds
    ]);

    const sessionId = sessionRes.rows[0].id;

    // 4. Update / Upsert user progress
    await client.query(`
      INSERT INTO fundamental_user_progress (
        user_id, material_id, is_material_read, is_quiz_passed, best_quiz_score, attempts_count, completed_at, updated_at
      ) VALUES ($1, $2, TRUE, $3, $4, 1, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
      ON CONFLICT (user_id, material_id)
      DO UPDATE SET
        is_material_read = TRUE,
        is_quiz_passed = CASE WHEN $3 THEN TRUE ELSE fundamental_user_progress.is_quiz_passed END,
        best_quiz_score = GREATEST(fundamental_user_progress.best_quiz_score, $4),
        attempts_count = fundamental_user_progress.attempts_count + 1,
        completed_at = CASE WHEN $3 AND fundamental_user_progress.completed_at IS NULL THEN NOW() ELSE fundamental_user_progress.completed_at END,
        updated_at = NOW()
    `, [userId, material_id, isPassed, score]);

    // 5. Determine next material in this subtest
    const siblingsRes = await client.query(`
      SELECT id, order_index FROM fundamental_materials
      WHERE subject_id = $1 AND is_active = TRUE
      ORDER BY order_index ASC, created_at ASC
    `, [material.subject_id]);

    const siblings = siblingsRes.rows;
    const currentIdx = siblings.findIndex(s => s.id === material_id);
    const nextMaterialId = currentIdx !== -1 && currentIdx < siblings.length - 1 ? siblings[currentIdx + 1].id : null;

    // 6. Check if all materials in subtest are now completed
    const completedCheckRes = await client.query(`
      SELECT COUNT(*)::int AS completed_count
      FROM fundamental_user_progress fup
      JOIN fundamental_materials fm ON fm.id = fup.material_id
      WHERE fup.user_id = $1 AND fup.is_quiz_passed = TRUE AND fm.subject_id = $2 AND fm.is_active = TRUE
    `, [userId, material.subject_id]);

    const isDrillingUnlocked = completedCheckRes.rows[0]?.completed_count >= siblings.length;

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        sessionId,
        score,
        passingScore,
        totalQuestions,
        correctCount,
        incorrectCount,
        unansweredCount,
        isPassed,
        nextMaterialId,
        nextMaterialId,
        isDrillingUnlocked,
        subjectId: material.subject_id
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * GET /api/fundamental/quiz/result/:sessionId
 * Get quiz result review with full questions, choices, user's answers, and explanations
 */
router.get('/quiz/result/:sessionId', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    // 1. Get session
    const sessionRes = await pool.query(`
      SELECT s.*, fm.title AS material_title, fm.subject_id, fm.passing_score, sub.title AS subject_title, sub.name AS subject_name
      FROM fundamental_quiz_sessions s
      JOIN fundamental_materials fm ON fm.id = s.material_id
      JOIN subjects sub ON sub.id = fm.subject_id
      WHERE s.id = $1 AND s.user_id = $2
    `, [sessionId, userId]);

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Hasil kuis tidak ditemukan' });
    }
    const session = sessionRes.rows[0];

    // 2. Fetch full question details for all quizzes in this material
    const questionsRes = await pool.query(`
      SELECT q.id, q.question_text, q.stimulus, q.image_url, q.image_position, q.difficulty, q.display_order
      FROM fundamental_quizzes q
      WHERE q.material_id = $1
      ORDER BY q.display_order ASC
    `, [session.material_id]);

    const questionIds = questionsRes.rows.map(q => q.id);

    // 3. Fetch options with explanation
    const optionsRes = await pool.query(`
      SELECT id, quiz_id, label, content, is_correct, explanation
      FROM fundamental_quiz_options
      WHERE quiz_id = ANY($1)
      ORDER BY label ASC
    `, [questionIds]);

    const optionsMap = {};
    optionsRes.rows.forEach(opt => {
      if (!optionsMap[opt.quiz_id]) optionsMap[opt.quiz_id] = [];
      optionsMap[opt.quiz_id].push(opt);
    });

    const userAnswersMap = {};
    const answersPayload = Array.isArray(session.answers_payload) ? session.answers_payload : [];
    answersPayload.forEach(a => {
      userAnswersMap[a.quiz_id] = a;
    });

    const reviewQuestions = questionsRes.rows.map((q, idx) => {
      const uAns = userAnswersMap[q.id];
      return {
        ...q,
        number: idx + 1,
        options: optionsMap[q.id] || [],
        userAnswer: uAns || null,
        isCorrect: !!uAns?.is_correct
      };
    });

    // 4. Adjacent materials
    const siblingsRes = await pool.query(`
      SELECT id, title, order_index FROM fundamental_materials
      WHERE subject_id = $1 AND is_active = TRUE
      ORDER BY order_index ASC
    `, [session.subject_id]);

    const siblings = siblingsRes.rows;
    const currentIdx = siblings.findIndex(s => s.id === session.material_id);
    const nextMaterial = currentIdx !== -1 && currentIdx < siblings.length - 1 ? siblings[currentIdx + 1] : null;

    res.json({
      success: true,
      data: {
        session,
        questions: reviewQuestions,
        nextMaterial,
        subjectId: session.subject_id
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/fundamental/drilling/:subjectId/questions
 * Get drilling questions for subtest (only unlocked when all materials completed)
 */
router.get('/drilling/:subjectId/questions', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const userId = req.user.id;

    // 1. Verify that all materials in this subtest are completed (unless admin)
    if (req.user.role !== 'admin') {
      const checkMaterialsRes = await pool.query(`
        SELECT 
          COUNT(fm.id)::int AS total_materials,
          COUNT(fup.material_id)::int AS completed_materials
        FROM fundamental_materials fm
        LEFT JOIN fundamental_user_progress fup 
          ON fup.material_id = fm.id AND fup.user_id = $2 AND fup.is_quiz_passed = TRUE
        WHERE fm.subject_id = $1 AND fm.is_active = TRUE
      `, [subjectId, userId]);

      const { total_materials, completed_materials } = checkMaterialsRes.rows[0] || {};
      if (!total_materials || completed_materials < total_materials) {
        return res.status(403).json({ 
          error: 'Drilling soal masih terkunci! Anda harus menyelesaikan semua materi dan kuis pada subtes ini terlebih dahulu.' 
        });
      }
    }

    // 2. Subject Info
    const subjectRes = await pool.query('SELECT * FROM subjects WHERE id = $1', [subjectId]);
    if (subjectRes.rows.length === 0) {
      return res.status(404).json({ error: 'Subtes tidak ditemukan' });
    }
    const subject = subjectRes.rows[0];

    // 3. Fetch drilling questions
    const questionsRes = await pool.query(`
      SELECT id, subject_id, question_text, stimulus, image_url, image_position, difficulty, display_order
      FROM fundamental_drilling_questions
      WHERE subject_id = $1 AND is_active = TRUE
      ORDER BY display_order ASC, created_at ASC
    `, [subjectId]);

    if (questionsRes.rows.length === 0) {
      return res.status(404).json({ error: 'Soal drilling untuk subtes ini belum tersedia. Silakan hubungi admin.' });
    }

    const questionIds = questionsRes.rows.map(q => q.id);

    const optionsRes = await pool.query(`
      SELECT id, drilling_question_id, label, content
      FROM fundamental_drilling_options
      WHERE drilling_question_id = ANY($1)
      ORDER BY label ASC
    `, [questionIds]);

    const optionsMap = {};
    optionsRes.rows.forEach(opt => {
      if (!optionsMap[opt.drilling_question_id]) optionsMap[opt.drilling_question_id] = [];
      optionsMap[opt.drilling_question_id].push(opt);
    });

    const questions = questionsRes.rows.map((q, idx) => ({
      ...q,
      number: idx + 1,
      options: optionsMap[q.id] || []
    }));

    res.json({
      success: true,
      data: {
        subject,
        totalQuestions: questions.length,
        questions
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/drilling/submit
 * Submit answers for drilling questions
 */
router.post('/drilling/submit', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const { subject_id, answers = [], time_spent_seconds = 0 } = req.body;

    if (!subject_id) {
      return res.status(400).json({ error: 'subject_id is required' });
    }

    await client.query('BEGIN');

    // 1. Fetch questions and correct options
    const questionsRes = await client.query(`
      SELECT q.id AS question_id, q.question_text, q.display_order,
             qo.id AS correct_choice_id, qo.label AS correct_label, qo.explanation
      FROM fundamental_drilling_questions q
      LEFT JOIN fundamental_drilling_options qo ON qo.drilling_question_id = q.id AND qo.is_correct = TRUE
      WHERE q.subject_id = $1 AND q.is_active = TRUE
      ORDER BY q.display_order ASC
    `, [subject_id]);

    const totalQuestions = questionsRes.rows.length;
    if (totalQuestions === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tidak ada butir soal drilling untuk subtes ini' });
    }

    const answersMap = {};
    answers.forEach(a => {
      answersMap[a.question_id] = a;
    });

    let correctCount = 0;
    let incorrectCount = 0;
    let unansweredCount = 0;
    const answersPayload = [];

    for (const q of questionsRes.rows) {
      const userAns = answersMap[q.question_id];
      const chosenChoiceId = userAns ? userAns.chosen_option_id : null;
      const chosenLabel = userAns ? userAns.label : null;

      let isCorrect = false;
      if (!chosenChoiceId) {
        unansweredCount++;
      } else if (chosenChoiceId === q.correct_choice_id) {
        correctCount++;
        isCorrect = true;
      } else {
        incorrectCount++;
      }

      answersPayload.push({
        question_id: q.question_id,
        chosen_choice_id: chosenChoiceId,
        chosen_label: chosenLabel,
        correct_choice_id: q.correct_choice_id,
        correct_label: q.correct_label,
        is_correct: isCorrect,
        time_spent_sec: userAns?.time_spent_sec || 0
      });
    }

    const score = Math.round((correctCount / totalQuestions) * 100);

    // 2. Insert drilling session
    const sessionRes = await client.query(`
      INSERT INTO fundamental_drilling_sessions (
        user_id, subject_id, total_questions, correct_count, incorrect_count, unanswered_count,
        score, answers_payload, time_spent_seconds, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id
    `, [
      userId, subject_id, totalQuestions, correctCount, incorrectCount, unansweredCount,
      score, JSON.stringify(answersPayload), time_spent_seconds
    ]);

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        sessionId: sessionRes.rows[0].id,
        score,
        totalQuestions,
        correctCount,
        incorrectCount,
        unansweredCount,
        subjectId: subject_id
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * GET /api/fundamental/drilling/result/:sessionId
 * Get detailed drilling session result with review & explanations
 */
router.get('/drilling/result/:sessionId', [verifyToken, requireFundamentalAccess], async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const sessionRes = await pool.query(`
      SELECT s.*, sub.title AS subject_title, sub.name AS subject_name, sub.icon AS subject_icon, sub.bg_color, sub.icon_color
      FROM fundamental_drilling_sessions s
      JOIN subjects sub ON sub.id = s.subject_id
      WHERE s.id = $1 AND s.user_id = $2
    `, [sessionId, userId]);

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Hasil drilling tidak ditemukan' });
    }
    const session = sessionRes.rows[0];

    const questionsRes = await pool.query(`
      SELECT q.id, q.question_text, q.stimulus, q.image_url, q.image_position, q.difficulty, q.display_order
      FROM fundamental_drilling_questions q
      WHERE q.subject_id = $1 AND q.is_active = TRUE
      ORDER BY q.display_order ASC
    `, [session.subject_id]);

    const questionIds = questionsRes.rows.map(q => q.id);

    const optionsRes = await pool.query(`
      SELECT id, drilling_question_id, label, content, is_correct, explanation
      FROM fundamental_drilling_options
      WHERE drilling_question_id = ANY($1)
      ORDER BY label ASC
    `, [questionIds]);

    const optionsMap = {};
    optionsRes.rows.forEach(opt => {
      if (!optionsMap[opt.drilling_question_id]) optionsMap[opt.drilling_question_id] = [];
      optionsMap[opt.drilling_question_id].push(opt);
    });

    const userAnswersMap = {};
    const answersPayload = Array.isArray(session.answers_payload) ? session.answers_payload : [];
    answersPayload.forEach(a => {
      userAnswersMap[a.question_id] = a;
    });

    const reviewQuestions = questionsRes.rows.map((q, idx) => {
      const uAns = userAnswersMap[q.id];
      return {
        ...q,
        number: idx + 1,
        options: optionsMap[q.id] || [],
        userAnswer: uAns || null,
        isCorrect: !!uAns?.is_correct
      };
    });

    res.json({
      success: true,
      data: {
        session,
        questions: reviewQuestions
      }
    });
  } catch (error) {
    next(error);
  }
});


// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

// --- 1. ADMIN: MATERIALS ---

/**
 * GET /api/fundamental/admin/materials
 * List materials for admin (optionally filter by subject_id)
 */
router.get('/admin/materials', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { subject_id } = req.query;
    let query = `
      SELECT fm.*, s.title AS subject_title, s.name AS subject_name,
             COALESCE(qc.quiz_count, 0)::int AS quiz_count
      FROM fundamental_materials fm
      JOIN subjects s ON s.id = fm.subject_id
      LEFT JOIN (
        SELECT material_id, COUNT(*) AS quiz_count
        FROM fundamental_quizzes
        GROUP BY material_id
      ) qc ON qc.material_id = fm.id
    `;
    const params = [];
    if (subject_id) {
      query += ` WHERE fm.subject_id = $1`;
      params.push(subject_id);
    }
    query += `
      ORDER BY fm.order_index ASC, fm.created_at ASC
    `;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/admin/materials
 * Create new fundamental material
 */
router.post('/admin/materials', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { subject_id, title, description, content, image_url, image_position, order_index, estimated_read_minutes, passing_score, is_active } = req.body;
    if (!subject_id || !title || !content) {
      return res.status(400).json({ error: 'subject_id, title, dan content wajib diisi' });
    }

    // Auto compute order_index if not provided
    let finalOrderIndex = order_index;
    if (!finalOrderIndex) {
      const maxOrderRes = await pool.query(
        'SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM fundamental_materials WHERE subject_id = $1',
        [subject_id]
      );
      finalOrderIndex = maxOrderRes.rows[0].next_order;
    }

    const result = await pool.query(`
      INSERT INTO fundamental_materials (
        subject_id, title, description, content, image_url, image_position, order_index, estimated_read_minutes, passing_score, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      subject_id, title, description || '', content,
      image_url || null, image_position || 'before',
      finalOrderIndex, estimated_read_minutes || 10, passing_score || 70, is_active ?? true
    ]);

    logAdminActivity(req, 'CREATE', 'FUNDAMENTAL_MATERIAL', title, `Menambahkan materi fundamental: "${title}"`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/fundamental/admin/materials/:id
 * Update fundamental material
 */
router.patch('/admin/materials/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    const { subject_id, title, description, content, image_url, image_position, order_index, estimated_read_minutes, passing_score, is_active } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (subject_id !== undefined) {
      fields.push(`subject_id = $${idx++}`);
      values.push(subject_id);
    }
    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }
    if (description !== undefined) {
      fields.push(`description = $${idx++}`);
      values.push(description);
    }
    if (content !== undefined) {
      fields.push(`content = $${idx++}`);
      values.push(content);
    }
    if (image_url !== undefined) {
      fields.push(`image_url = $${idx++}`);
      values.push(image_url || null);
    }
    if (image_position !== undefined) {
      fields.push(`image_position = $${idx++}`);
      values.push(image_position);
    }
    if (order_index !== undefined) {
      fields.push(`order_index = $${idx++}`);
      values.push(order_index);
    }
    if (estimated_read_minutes !== undefined) {
      fields.push(`estimated_read_minutes = $${idx++}`);
      values.push(estimated_read_minutes);
    }
    if (passing_score !== undefined) {
      fields.push(`passing_score = $${idx++}`);
      values.push(passing_score);
    }
    if (is_active !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(is_active);
    }

    if (fields.length === 0) {
      const current = await pool.query('SELECT * FROM fundamental_materials WHERE id = $1', [id]);
      if (current.rows.length === 0) return res.status(404).json({ error: 'Materi tidak ditemukan' });
      return res.json({ success: true, data: current.rows[0] });
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE fundamental_materials
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Materi tidak ditemukan' });
    }

    logAdminActivity(req, 'UPDATE', 'FUNDAMENTAL_MATERIAL', result.rows[0].title, `Mengubah materi fundamental: "${result.rows[0].title}"`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/fundamental/admin/materials/:id
 * Delete fundamental material
 */
router.delete('/admin/materials/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM fundamental_materials WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Materi tidak ditemukan' });
    }

    logAdminActivity(req, 'DELETE', 'FUNDAMENTAL_MATERIAL', result.rows[0].title, `Menghapus materi fundamental: "${result.rows[0].title}"`);
    res.json({ success: true, message: 'Materi berhasil dihapus' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/admin/materials/reorder
 * Reorder materials
 */
router.post('/admin/materials/reorder', [verifyToken, verifyAdmin], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { material_ids = [] } = req.body;
    await client.query('BEGIN');

    for (let idx = 0; idx < material_ids.length; idx++) {
      await client.query(
        'UPDATE fundamental_materials SET order_index = $1, updated_at = NOW() WHERE id = $2',
        [idx + 1, material_ids[idx]]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Urutan materi berhasil diperbarui' });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});


// --- 2. ADMIN: QUIZZES ---

/**
 * GET /api/fundamental/admin/quizzes
 * List quiz questions for a material with options and answer keys
 */
router.get('/admin/quizzes', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { material_id } = req.query;
    if (!material_id) {
      return res.status(400).json({ error: 'material_id query parameter is required' });
    }

    const quizzesRes = await pool.query(`
      SELECT q.*, fm.title AS material_title
      FROM fundamental_quizzes q
      JOIN fundamental_materials fm ON fm.id = q.material_id
      WHERE q.material_id = $1
      ORDER BY q.display_order ASC, q.created_at ASC
    `, [material_id]);

    const quizIds = quizzesRes.rows.map(q => q.id);
    let options = [];
    if (quizIds.length > 0) {
      const optionsRes = await pool.query(`
        SELECT * FROM fundamental_quiz_options
        WHERE quiz_id = ANY($1)
        ORDER BY label ASC
      `, [quizIds]);
      options = optionsRes.rows;
    }

    const optionsMap = {};
    options.forEach(opt => {
      if (!optionsMap[opt.quiz_id]) optionsMap[opt.quiz_id] = [];
      optionsMap[opt.quiz_id].push(opt);
    });

    const data = quizzesRes.rows.map(q => ({
      ...q,
      options: optionsMap[q.id] || []
    }));

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/admin/quizzes
 * Create a new quiz question with options
 */
router.post('/admin/quizzes', [verifyToken, verifyAdmin], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      material_id, question_text, stimulus, image_url, image_position,
      difficulty, display_order, options = []
    } = req.body;

    if (!material_id || !question_text) {
      return res.status(400).json({ error: 'material_id dan question_text wajib diisi' });
    }

    await client.query('BEGIN');

    let finalOrder = display_order;
    if (!finalOrder) {
      const maxOrderRes = await client.query(
        'SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM fundamental_quizzes WHERE material_id = $1',
        [material_id]
      );
      finalOrder = maxOrderRes.rows[0].next_order;
    }

    const quizRes = await client.query(`
      INSERT INTO fundamental_quizzes (
        material_id, question_text, stimulus, image_url, image_position, difficulty, display_order
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      material_id, question_text, stimulus || null, image_url || null,
      image_position || 'after', difficulty || 'medium', finalOrder
    ]);

    const quiz = quizRes.rows[0];

    // Insert options
    const createdOptions = [];
    for (const opt of options) {
      const optRes = await client.query(`
        INSERT INTO fundamental_quiz_options (
          quiz_id, label, content, is_correct, explanation
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [quiz.id, opt.label, opt.content, opt.is_correct ?? false, opt.explanation || '']);
      createdOptions.push(optRes.rows[0]);
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'CREATE', 'FUNDAMENTAL_QUIZ', `Quiz ID: ${quiz.id}`, `Menambahkan soal kuis fundamental materi`);

    res.status(201).json({
      success: true,
      data: {
        ...quiz,
        options: createdOptions
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/fundamental/admin/quizzes/:id
 * Update quiz question & options
 */
router.patch('/admin/quizzes/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      question_text, stimulus, image_url, image_position, difficulty,
      display_order, options
    } = req.body;

    await client.query('BEGIN');

    const fields = [];
    const values = [];
    let idx = 1;

    if (question_text !== undefined) {
      fields.push(`question_text = $${idx++}`);
      values.push(question_text);
    }
    if (stimulus !== undefined) {
      fields.push(`stimulus = $${idx++}`);
      values.push(stimulus || null);
    }
    if (image_url !== undefined) {
      fields.push(`image_url = $${idx++}`);
      values.push(image_url || null);
    }
    if (image_position !== undefined) {
      fields.push(`image_position = $${idx++}`);
      values.push(image_position);
    }
    if (difficulty !== undefined) {
      fields.push(`difficulty = $${idx++}`);
      values.push(difficulty);
    }
    if (display_order !== undefined) {
      fields.push(`display_order = $${idx++}`);
      values.push(display_order);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const quizRes = await client.query(`
      UPDATE fundamental_quizzes
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `, values);

    if (quizRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Soal kuis tidak ditemukan' });
    }

    const quiz = quizRes.rows[0];

    // If options provided, replace them
    let updatedOptions = [];
    if (Array.isArray(options) && options.length > 0) {
      await client.query('DELETE FROM fundamental_quiz_options WHERE quiz_id = $1', [id]);
      for (const opt of options) {
        const optRes = await client.query(`
          INSERT INTO fundamental_quiz_options (
            quiz_id, label, content, is_correct, explanation
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [id, opt.label, opt.content, opt.is_correct ?? false, opt.explanation || '']);
        updatedOptions.push(optRes.rows[0]);
      }
    } else {
      const currentOpts = await client.query('SELECT * FROM fundamental_quiz_options WHERE quiz_id = $1 ORDER BY label ASC', [id]);
      updatedOptions = currentOpts.rows;
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'UPDATE', 'FUNDAMENTAL_QUIZ', `Quiz ID: ${id}`, `Mengubah soal kuis fundamental materi`);

    res.json({
      success: true,
      data: {
        ...quiz,
        options: updatedOptions
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/fundamental/admin/quizzes/:id
 * Delete quiz question
 */
router.delete('/admin/quizzes/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM fundamental_quizzes WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Soal kuis tidak ditemukan atau sudah dihapus' });
    }

    logAdminActivity(req, 'DELETE', 'FUNDAMENTAL_QUIZ', `Quiz ID: ${id}`, `Menghapus soal kuis fundamental`);
    res.json({ success: true, message: 'Soal kuis berhasil dihapus' });
  } catch (error) {
    next(error);
  }
});

// Excel header aliases resolver
const EXCEL_ALIASES = {
  stimulus:      ['stimulus', 'wacana', 'bacaan', 'stimulus/wacana', 'stimulus/wacana (opsional)', 'bacaan/stimulus'],
  soal:          ['soal', 'content', 'question', 'pertanyaan', 'isi soal', 'teks soal', 'text'],
  opsi_a:        ['opsi a', 'opsia', 'choice_a', 'pilihan a', 'pilihan_a', 'option a', 'option_a', 'a', 'jawaban a'],
  opsi_b:        ['opsi b', 'opsib', 'choice_b', 'pilihan b', 'pilihan_b', 'option b', 'option_b', 'b', 'jawaban b'],
  opsi_c:        ['opsi c', 'opsic', 'choice_c', 'pilihan c', 'pilihan_c', 'option c', 'option_c', 'c', 'jawaban c'],
  opsi_d:        ['opsi d', 'opsid', 'choice_d', 'pilihan d', 'pilihan_d', 'option d', 'option_d', 'd', 'jawaban d'],
  opsi_e:        ['opsi e', 'opsie', 'choice_e', 'pilihan e', 'pilihan_e', 'option e', 'option_e', 'e', 'jawaban e'],
  kunci:         ['kunci jawaban', 'kunci', 'correct_label', 'answer', 'jawaban', 'kunci_jawaban', 'correct_answer', 'kunci (a/b/c/d/e)', 'kunci benar'],
  pembahasan:    ['pembahasan', 'explanation', 'penjelasan', 'pembahasan soal', 'solusi'],
  image_url:     ['gambar', 'image', 'image_url', 'url gambar', 'foto', 'link gambar'],
  difficulty:    ['tingkat kesulitan', 'kesulitan', 'difficulty', 'level', 'tingkat'],
  image_position:['posisi gambar', 'posisi_gambar', 'image_position', 'image position']
};

const resolveExcelRow = (row, key) => {
  const aliases = EXCEL_ALIASES[key] || [key];
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

/**
 * POST /api/fundamental/admin/quizzes/import
 * Bulk import quiz questions from Excel
 */
router.post('/admin/quizzes/import', [verifyToken, verifyAdmin, upload.single('file')], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { material_id } = req.body;
    if (!material_id) {
      return res.status(400).json({ error: 'material_id is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'File Excel (.xlsx) wajib diunggah' });
    }

    const matCheck = await pool.query('SELECT id FROM fundamental_materials WHERE id = $1', [material_id]);
    if (matCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Materi tujuan tidak ditemukan' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'File Excel kosong atau format tidak sesuai' });
    }

    await client.query('BEGIN');

    // Get current max display_order
    const maxOrderRes = await client.query(
      'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM fundamental_quizzes WHERE material_id = $1',
      [material_id]
    );
    let nextOrder = (maxOrderRes.rows[0]?.max_order || 0) + 1;

    let importedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const soal = resolveExcelRow(row, 'soal');
      if (!soal) continue;

      const stimulus = resolveExcelRow(row, 'stimulus') || null;
      const imageUrl = resolveExcelRow(row, 'image_url') || null;
      const rawDifficulty = resolveExcelRow(row, 'difficulty').toLowerCase();
      const difficulty = ['easy', 'mudah'].includes(rawDifficulty) ? 'easy' :
                         ['hard', 'sulit', 'hots'].includes(rawDifficulty) ? 'hard' : 'medium';
      const rawKey = resolveExcelRow(row, 'kunci').toUpperCase().trim();
      const correctKey = ['A', 'B', 'C', 'D', 'E'].includes(rawKey) ? rawKey : 'A';
      const explanation = resolveExcelRow(row, 'pembahasan') || '';

      const quizRes = await client.query(`
        INSERT INTO fundamental_quizzes (
          material_id, question_text, stimulus, image_url, difficulty, display_order
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [material_id, soal, stimulus, imageUrl, difficulty, nextOrder++]);

      const quizId = quizRes.rows[0].id;

      // Extract options A - E
      const labels = ['A', 'B', 'C', 'D', 'E'];
      for (const label of labels) {
        const optContent = resolveExcelRow(row, `opsi_${label.toLowerCase()}`);
        if (optContent) {
          const isCorrect = correctKey === label;
          await client.query(`
            INSERT INTO fundamental_quiz_options (
              quiz_id, label, content, is_correct, explanation
            ) VALUES ($1, $2, $3, $4, $5)
          `, [quizId, label, optContent, isCorrect, isCorrect ? explanation : '']);
        }
      }
      importedCount++;
    }

    if (importedCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Tidak ada baris soal yang valid ditemukan di file Excel. Pastikan nama kolom berisi SOAL, OPSI A, OPSI B, dst.'
      });
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'CREATE', 'FUNDAMENTAL_QUIZ', `Material: ${material_id}`, `Import ${importedCount} soal kuis fundamental via Excel`);

    res.json({ success: true, message: `Berhasil mengimpor ${importedCount} soal kuis`, count: importedCount });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});


// --- 3. ADMIN: DRILLING SOAL ---

/**
 * GET /api/fundamental/admin/drillings
 * List drilling questions for a subject
 */
router.get('/admin/drillings', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { subject_id } = req.query;
    if (!subject_id) {
      return res.status(400).json({ error: 'subject_id query parameter is required' });
    }

    const drillingsRes = await pool.query(`
      SELECT q.*, s.title AS subject_title, s.name AS subject_name
      FROM fundamental_drilling_questions q
      JOIN subjects s ON s.id = q.subject_id
      WHERE q.subject_id = $1
      ORDER BY q.display_order ASC, q.created_at ASC
    `, [subject_id]);

    const qIds = drillingsRes.rows.map(q => q.id);
    let options = [];
    if (qIds.length > 0) {
      const optionsRes = await pool.query(`
        SELECT * FROM fundamental_drilling_options
        WHERE drilling_question_id = ANY($1)
        ORDER BY label ASC
      `, [qIds]);
      options = optionsRes.rows;
    }

    const optionsMap = {};
    options.forEach(opt => {
      if (!optionsMap[opt.drilling_question_id]) optionsMap[opt.drilling_question_id] = [];
      optionsMap[opt.drilling_question_id].push(opt);
    });

    const data = drillingsRes.rows.map(q => ({
      ...q,
      options: optionsMap[q.id] || []
    }));

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/admin/drillings
 * Create a new drilling question
 */
router.post('/admin/drillings', [verifyToken, verifyAdmin], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      subject_id, question_text, stimulus, image_url, image_position,
      difficulty, display_order, is_active, options = []
    } = req.body;

    if (!subject_id || !question_text) {
      return res.status(400).json({ error: 'subject_id dan question_text wajib diisi' });
    }

    await client.query('BEGIN');

    let finalOrder = display_order;
    if (!finalOrder) {
      const maxOrderRes = await client.query(
        'SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM fundamental_drilling_questions WHERE subject_id = $1',
        [subject_id]
      );
      finalOrder = maxOrderRes.rows[0].next_order;
    }

    const qRes = await client.query(`
      INSERT INTO fundamental_drilling_questions (
        subject_id, question_text, stimulus, image_url, image_position, difficulty, display_order, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      subject_id, question_text, stimulus || null, image_url || null,
      image_position || 'after', difficulty || 'medium', finalOrder, is_active ?? true
    ]);

    const question = qRes.rows[0];

    const createdOptions = [];
    for (const opt of options) {
      const optRes = await client.query(`
        INSERT INTO fundamental_drilling_options (
          drilling_question_id, label, content, is_correct, explanation
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [question.id, opt.label, opt.content, opt.is_correct ?? false, opt.explanation || '']);
      createdOptions.push(optRes.rows[0]);
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'CREATE', 'FUNDAMENTAL_DRILLING', `Drilling ID: ${question.id}`, `Menambahkan butir soal drilling fundamental`);

    res.status(201).json({
      success: true,
      data: {
        ...question,
        options: createdOptions
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/fundamental/admin/drillings/:id
 * Update drilling question
 */
router.patch('/admin/drillings/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      question_text, stimulus, image_url, image_position, difficulty,
      display_order, is_active, options
    } = req.body;

    await client.query('BEGIN');

    const fields = [];
    const values = [];
    let idx = 1;

    if (question_text !== undefined) {
      fields.push(`question_text = $${idx++}`);
      values.push(question_text);
    }
    if (stimulus !== undefined) {
      fields.push(`stimulus = $${idx++}`);
      values.push(stimulus || null);
    }
    if (image_url !== undefined) {
      fields.push(`image_url = $${idx++}`);
      values.push(image_url || null);
    }
    if (image_position !== undefined) {
      fields.push(`image_position = $${idx++}`);
      values.push(image_position);
    }
    if (difficulty !== undefined) {
      fields.push(`difficulty = $${idx++}`);
      values.push(difficulty);
    }
    if (display_order !== undefined) {
      fields.push(`display_order = $${idx++}`);
      values.push(display_order);
    }
    if (is_active !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(is_active);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const qRes = await client.query(`
      UPDATE fundamental_drilling_questions
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `, values);

    if (qRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Soal drilling tidak ditemukan' });
    }

    const question = qRes.rows[0];

    let updatedOptions = [];
    if (Array.isArray(options) && options.length > 0) {
      await client.query('DELETE FROM fundamental_drilling_options WHERE drilling_question_id = $1', [id]);
      for (const opt of options) {
        const optRes = await client.query(`
          INSERT INTO fundamental_drilling_options (
            drilling_question_id, label, content, is_correct, explanation
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [id, opt.label, opt.content, opt.is_correct ?? false, opt.explanation || '']);
        updatedOptions.push(optRes.rows[0]);
      }
    } else {
      const currentOpts = await client.query('SELECT * FROM fundamental_drilling_options WHERE drilling_question_id = $1 ORDER BY label ASC', [id]);
      updatedOptions = currentOpts.rows;
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'UPDATE', 'FUNDAMENTAL_DRILLING', `Drilling ID: ${id}`, `Mengubah soal drilling fundamental`);

    res.json({
      success: true,
      data: {
        ...question,
        options: updatedOptions
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/fundamental/admin/drillings/:id
 * Delete drilling question
 */
router.delete('/admin/drillings/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM fundamental_drilling_questions WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Soal drilling tidak ditemukan' });
    }

    logAdminActivity(req, 'DELETE', 'FUNDAMENTAL_DRILLING', `Drilling ID: ${id}`, `Menghapus soal drilling fundamental`);
    res.json({ success: true, message: 'Soal drilling berhasil dihapus' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/fundamental/admin/drillings/import
 * Bulk import drilling questions from Excel
 */
router.post('/admin/drillings/import', [verifyToken, verifyAdmin, upload.single('file')], async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { subject_id } = req.body;
    if (!subject_id) {
      return res.status(400).json({ error: 'subject_id is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'File Excel (.xlsx) wajib diunggah' });
    }

    const subCheck = await pool.query('SELECT id FROM subjects WHERE id = $1', [subject_id]);
    if (subCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Subtes tujuan tidak ditemukan' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'File Excel kosong atau format tidak sesuai' });
    }

    await client.query('BEGIN');

    // Get current max display_order
    const maxOrderRes = await client.query(
      'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM fundamental_drilling_questions WHERE subject_id = $1',
      [subject_id]
    );
    let nextOrder = (maxOrderRes.rows[0]?.max_order || 0) + 1;

    let importedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const soal = resolveExcelRow(row, 'soal');
      if (!soal) continue;

      const stimulus = resolveExcelRow(row, 'stimulus') || null;
      const imageUrl = resolveExcelRow(row, 'image_url') || null;
      const rawDifficulty = resolveExcelRow(row, 'difficulty').toLowerCase();
      const difficulty = ['easy', 'mudah'].includes(rawDifficulty) ? 'easy' :
                         ['hard', 'sulit', 'hots'].includes(rawDifficulty) ? 'hard' : 'medium';
      const rawKey = resolveExcelRow(row, 'kunci').toUpperCase().trim();
      const correctKey = ['A', 'B', 'C', 'D', 'E'].includes(rawKey) ? rawKey : 'A';
      const explanation = resolveExcelRow(row, 'pembahasan') || '';

      const qRes = await client.query(`
        INSERT INTO fundamental_drilling_questions (
          subject_id, question_text, stimulus, image_url, difficulty, display_order, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [subject_id, soal, stimulus, imageUrl, difficulty, nextOrder++, true]);

      const qId = qRes.rows[0].id;

      const labels = ['A', 'B', 'C', 'D', 'E'];
      for (const label of labels) {
        const optContent = resolveExcelRow(row, `opsi_${label.toLowerCase()}`);
        if (optContent) {
          const isCorrect = correctKey === label;
          await client.query(`
            INSERT INTO fundamental_drilling_options (
              drilling_question_id, label, content, is_correct, explanation
            ) VALUES ($1, $2, $3, $4, $5)
          `, [qId, label, optContent, isCorrect, isCorrect ? explanation : '']);
        }
      }
      importedCount++;
    }

    if (importedCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Tidak ada baris soal yang valid ditemukan di file Excel. Pastikan nama kolom berisi SOAL, OPSI A, OPSI B, dst.'
      });
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'CREATE', 'FUNDAMENTAL_DRILLING', `Subject: ${subject_id}`, `Import ${importedCount} soal drilling fundamental via Excel`);

    res.json({ success: true, message: `Berhasil mengimpor ${importedCount} soal drilling`, count: importedCount });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
