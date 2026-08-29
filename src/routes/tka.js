const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');
const { generateQuestionHash } = require('../utils/questionHashUtil');
const { hasActiveTkaSubscription } = require('../utils/latihanAccessUtil');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// HELPER: Calculate Scaled Score (0-100) & Weakness Analysis
// ============================================================
function calculateScaledScore(correctCount, totalCount) {
  if (!totalCount || totalCount <= 0) return 0;
  return Math.round((correctCount / totalCount) * 100 * 10) / 10;
}

/**
 * Evaluates whether a student answer is correct for any TKA question type
 */
function evaluateTkaQuestionAnswer(qType, choices, ans) {
  if (!ans) return false;
  const { chosen_choice_id, answer_text } = ans;

  if (qType === 'short_answer') {
    const correctChoice = (choices || []).find(c => c.is_correct);
    if (!correctChoice) return false;
    const targetTxt = (correctChoice.content || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const userTxt = (answer_text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!userTxt) return false;
    return userTxt === targetTxt || userTxt.replace(',', '.') === targetTxt.replace(',', '.');
  }

  if (qType === 'complex_mc_tf') {
    let userAnswersObj = {};
    try {
      userAnswersObj = answer_text ? (typeof answer_text === 'string' ? JSON.parse(answer_text) : answer_text) : {};
      if (!userAnswersObj || typeof userAnswersObj !== 'object' || Array.isArray(userAnswersObj)) userAnswersObj = {};
    } catch (e) {
      userAnswersObj = {};
    }
    if (!choices || choices.length === 0) return false;
    return choices.every((c) => {
      const studentAns = userAnswersObj[c.label] !== undefined ? userAnswersObj[c.label] : userAnswersObj[c.id];
      if (studentAns === undefined) return false;
      const parsedBool = (studentAns === true || studentAns === 'true' || studentAns === 1 || studentAns === '1');
      return parsedBool === Boolean(c.is_correct);
    });
  }

  if (qType === 'complex_mc_multi') {
    let userSelected = [];
    try {
      userSelected = answer_text ? (typeof answer_text === 'string' ? JSON.parse(answer_text) : answer_text) : [];
      if (!Array.isArray(userSelected)) userSelected = [];
    } catch (e) {
      userSelected = [];
    }
    const correctLabels = (choices || []).filter(c => c.is_correct).map(c => String(c.label).toUpperCase().trim());
    const selectedNormalized = userSelected.map(s => {
      const matched = (choices || []).find(c => c.id === s || String(c.id) === String(s));
      return matched ? String(matched.label).toUpperCase().trim() : String(s).toUpperCase().trim();
    });

    if (correctLabels.length === 0 || selectedNormalized.length === 0) return false;

    const correctSet = new Set(correctLabels);
    const userSet = new Set(selectedNormalized);
    if (correctSet.size !== userSet.size) return false;
    for (const item of correctSet) {
      if (!userSet.has(item)) return false;
    }
    return true;
  }

  // Default: multiple_choice
  const correctChoice = (choices || []).find(c => c.is_correct);
  if (!correctChoice) return false;
  if (chosen_choice_id !== null && chosen_choice_id !== undefined && chosen_choice_id !== '') {
    return String(chosen_choice_id) === String(correctChoice.id);
  }
  if (answer_text && String(answer_text).trim()) {
    return String(answer_text).trim().toUpperCase() === String(correctChoice.label).trim().toUpperCase();
  }
  return false;
}

/**
 * Generates weak materi breakdown by aggregating correct/incorrect answers per topic & subject
 * @param {Array} answersWithTopic Array of { subject_id, subject_name, topic_title, is_correct }
 */
function generateMateriAnalysis(answersWithTopic) {
  const map = {};
  for (const item of answersWithTopic) {
    const topic = item.topic_title || 'Materi Umum';
    const subjectName = item.subject_name || 'Mata Pelajaran';
    const subjectId = item.subject_id || '';
    const key = `${subjectId}___${topic}`;
    if (!map[key]) {
      map[key] = {
        subject_id: subjectId,
        subject_name: subjectName,
        topic,
        total: 0,
        correct: 0,
        incorrect: 0,
        percentage: 0,
        status: 'Sedang'
      };
    }
    map[key].total += 1;
    if (item.is_correct) {
      map[key].correct += 1;
    } else {
      map[key].incorrect += 1;
    }
  }

  for (const key in map) {
    const item = map[key];
    item.percentage = Math.round((item.correct / item.total) * 100);
    if (item.percentage >= 80) {
      item.status = 'Menguasai';
    } else if (item.percentage >= 50) {
      item.status = 'Cukup';
    } else {
      item.status = 'Perlu Ditingkatkan';
    }
  }

  return Object.values(map);
}

// ============================================================
// 1. PUBLIC / STUDENT: Subjects & Topics
// ============================================================

// GET /api/tka/subjects?level=SD|SMP|SMA
router.get('/subjects', verifyToken, async (req, res, next) => {
  try {
    const { level } = req.query;
    let query = `
      SELECT s.*, COALESCE(tc.topic_count, 0)::int AS topic_count, COALESCE(qc.question_count, 0)::int AS actual_question_count
      FROM tka_subjects s
      LEFT JOIN (SELECT subject_id, COUNT(*) AS topic_count FROM tka_topics GROUP BY subject_id) tc ON tc.subject_id = s.id
      LEFT JOIN (SELECT subject_id, COUNT(*) AS question_count FROM tka_questions WHERE tryout_package_id IS NULL GROUP BY subject_id) qc ON qc.subject_id = s.id
      WHERE s.is_active = TRUE
    `;
    const params = [];
    if (level) {
      query += ` AND s.education_level = $1`;
      params.push(level.toUpperCase());
    }
    query += ` ORDER BY s.display_order ASC, s.name ASC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/tka/subjects/:subjectId/topics
router.get('/subjects/:subjectId/topics', verifyToken, async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const result = await pool.query(
      `SELECT t.*, COUNT(q.id)::int as actual_question_count
       FROM tka_topics t
       LEFT JOIN tka_questions q ON q.topic_id = t.id AND q.tryout_package_id IS NULL
       WHERE t.subject_id = $1
       GROUP BY t.id
       ORDER BY t.display_order ASC, t.title ASC`,
      [subjectId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 2. STUDENT: Latihan Soal TKA
// ============================================================

// GET /api/tka/latihan/packages?subject_id=...&topic_id=...
router.get('/latihan/packages', verifyToken, async (req, res, next) => {
  try {
    const { subject_id, topic_id } = req.query;
    if (!subject_id) {
      return res.status(400).json({ success: false, error: 'subject_id wajib diisi' });
    }

    let countQuery = `
      SELECT package_number, COUNT(*)::int as question_count
      FROM tka_questions
      WHERE subject_id = $1 AND tryout_package_id IS NULL
    `;
    const countParams = [subject_id];
    if (topic_id) {
      countParams.push(topic_id);
      countQuery += ` AND topic_id = $2`;
    }
    countQuery += ` GROUP BY package_number ORDER BY package_number ASC`;

    const countRes = await pool.query(countQuery, countParams);
    const packagesData = countRes.rows;

    let totalQuestions = 0;
    packagesData.forEach(p => totalQuestions += p.question_count);

    // Get user's completed latihan sessions for this subject/topic
    let sessionQuery = `
      SELECT package_number, total_score, submitted_at, correct_count, total_questions
      FROM tka_latihan_sessions
      WHERE user_id = $1 AND subject_id = $2
    `;
    const sessionParams = [req.user.id, subject_id];
    if (topic_id) {
      sessionParams.push(topic_id);
      sessionQuery += ` AND topic_id = $3`;
    }
    sessionQuery += ` ORDER BY submitted_at DESC`;

    const sessionRes = await pool.query(sessionQuery, sessionParams);
    const sessionsByPackage = {};
    for (const row of sessionRes.rows) {
      const pNum = row.package_number || 1;
      if (!sessionsByPackage[pNum]) {
        sessionsByPackage[pNum] = row;
      }
    }

    // Fetch custom package titles
    const namesRes = await pool.query(
      `SELECT package_number, title FROM tka_latihan_package_names WHERE subject_id = $1`,
      [subject_id]
    );
    const customNamesMap = {};
    for (const r of namesRes.rows) {
      customNamesMap[r.package_number] = r.title;
    }

    const packages = [];
    for (const pkg of packagesData) {
      const i = pkg.package_number || 1;
      const qCount = pkg.question_count;
      const completedSession = sessionsByPackage[i];

      packages.push({
        package_number: i,
        title: customNamesMap[i] || `Paket Soal ${i}`,
        question_count: qCount,
        estimated_minutes: Math.ceil(qCount * 1.5),
        is_completed: !!completedSession,
        last_score: completedSession ? completedSession.total_score : null,
        submitted_at: completedSession ? completedSession.submitted_at : null
      });
    }

    res.json({
      success: true,
      total_questions: totalQuestions,
      packages
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tka/latihan/packages/name (Admin only)
router.put('/latihan/packages/name', verifyToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak' });
    }
    const { subject_id, package_number, title } = req.body;
    if (!subject_id || !package_number || !title) {
      return res.status(400).json({ success: false, error: 'subject_id, package_number, dan title wajib diisi' });
    }

    const trimmedTitle = title.trim();
    await pool.query(
      `INSERT INTO tka_latihan_package_names (subject_id, package_number, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (subject_id, package_number)
       DO UPDATE SET title = EXCLUDED.title, updated_at = CURRENT_TIMESTAMP`,
      [subject_id, package_number, trimmedTitle]
    );

    res.json({ success: true, message: 'Nama paket berhasil diperbarui', title: trimmedTitle });
  } catch (err) {
    next(err);
  }
});

// GET /api/tka/latihan/questions?subject_id=...&topic_id=...&package_number=...
router.get('/latihan/questions', verifyToken, async (req, res, next) => {
  try {
    const { subject_id, topic_id, package_number, limit = 10 } = req.query;
    if (!subject_id) {
      return res.status(400).json({ success: false, error: 'subject_id wajib diisi' });
    }

    const limitVal = parseInt(limit, 10) || 100;
    const pkgNum = package_number ? parseInt(package_number, 10) : null;

    let query = `
      SELECT q.id, q.subject_id, q.topic_id, q.content, q.stimulus, q.image_url, q.image_position,
             q.difficulty, q.question_type, q.options_config, q.display_order, q.package_number,
             t.title as topic_title, s.name as subject_name,
             COALESCE(s.duration_minutes, 30) as duration_minutes
      FROM tka_questions q
      JOIN tka_subjects s ON q.subject_id = s.id
      LEFT JOIN tka_topics t ON q.topic_id = t.id
      WHERE q.subject_id = $1 AND q.tryout_package_id IS NULL
    `;
    const params = [subject_id];

    if (topic_id) {
      params.push(topic_id);
      query += ` AND q.topic_id = $${params.length}`;
    }

    if (pkgNum) {
      params.push(pkgNum);
      query += ` AND q.package_number = $${params.length}`;
      query += ` ORDER BY q.display_order ASC NULLS LAST, q.created_at ASC`;
    } else {
      query += ` ORDER BY RANDOM() LIMIT $${params.length + 1}`;
      params.push(limitVal);
    }

    const qResult = await pool.query(query, params);
    const questions = qResult.rows;

    if (questions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const qIds = questions.map(q => q.id);
    const cResult = await pool.query(
      `SELECT id, question_id, label, content FROM tka_answer_choices WHERE question_id = ANY($1) ORDER BY label ASC`,
      [qIds]
    );

    const choicesByQuestion = {};
    for (const choice of cResult.rows) {
      if (!choicesByQuestion[choice.question_id]) {
        choicesByQuestion[choice.question_id] = [];
      }
      choicesByQuestion[choice.question_id].push(choice);
    }

    const data = questions.map(q => ({
      ...q,
      choices: choicesByQuestion[q.id] || []
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/latihan/submit
router.post('/latihan/submit', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { education_level, subject_id, topic_id, package_number, answers } = req.body;
    // answers format: [ { question_id, chosen_choice_id, answer_text, time_spent_sec } ]

    if (!subject_id || !Array.isArray(answers)) {
      return res.status(400).json({ success: false, error: 'subject_id & answers array wajib diisi' });
    }

    const subjRes = await client.query('SELECT name FROM tka_subjects WHERE id = $1', [subject_id]);
    const subjectName = subjRes.rows[0]?.name || 'TKA Subject';

    const qIds = answers.map(a => a.question_id);
    const qMapRes = await client.query(
      `SELECT q.id, q.question_type, q.topic_id, q.options_config, t.title as topic_title
       FROM tka_questions q
       LEFT JOIN tka_topics t ON q.topic_id = t.id
       WHERE q.id = ANY($1)`,
      [qIds]
    );

    const choicesRes = await client.query(
      `SELECT id, question_id, label, content, is_correct FROM tka_answer_choices WHERE question_id = ANY($1)`,
      [qIds]
    );

    const choicesByQuestion = {};
    for (const c of choicesRes.rows) {
      if (!choicesByQuestion[c.question_id]) choicesByQuestion[c.question_id] = [];
      choicesByQuestion[c.question_id].push(c);
    }

    const qInfoMap = {};
    for (const row of qMapRes.rows) {
      qInfoMap[row.id] = {
        question_type: row.question_type,
        topic_id: row.topic_id,
        topic_title: row.topic_title || 'Materi Umum',
        options_config: row.options_config || {},
        choices: choicesByQuestion[row.id] || []
      };
    }

    let correctCount = 0;
    let incorrectCount = 0;
    let unansweredCount = 0;
    const answerAnalysisItems = [];

    for (const ans of answers) {
      const qInfo = qInfoMap[ans.question_id];
      let isCorrect = false;

      const hasAnswer = (ans.chosen_choice_id !== null && ans.chosen_choice_id !== undefined && ans.chosen_choice_id !== '') ||
        (ans.answer_text !== null && ans.answer_text !== undefined && String(ans.answer_text).trim() !== '' && String(ans.answer_text) !== '[]' && String(ans.answer_text) !== '{}');

      if (!hasAnswer) {
        unansweredCount++;
      } else if (qInfo) {
        isCorrect = evaluateTkaQuestionAnswer(qInfo.question_type, qInfo.choices, ans);
        if (isCorrect) {
          correctCount++;
        } else {
          incorrectCount++;
        }
      }

      answerAnalysisItems.push({
        subject_id: subject_id,
        subject_name: subjectName,
        topic_title: qInfo?.topic_title || 'Materi Umum',
        is_correct: isCorrect
      });
    }

    const totalQuestions = answers.length;
    const totalScore = calculateScaledScore(correctCount, totalQuestions);
    const materiAnalysis = generateMateriAnalysis(answerAnalysisItems);

    const sessionRes = await client.query(
      `INSERT INTO tka_latihan_sessions
       (user_id, education_level, subject_id, topic_id, package_number, subject_name, total_questions, correct_count, incorrect_count, unanswered_count, total_score, materi_analysis, started_at, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
       RETURNING *`,
      [req.user.id, education_level || 'SMA', subject_id, topic_id || null, package_number ? parseInt(package_number, 10) : 1, subjectName, totalQuestions, correctCount, incorrectCount, unansweredCount, totalScore, JSON.stringify(materiAnalysis)]
    );

    const sessionId = sessionRes.rows[0].id;

    for (let i = 0; i < answers.length; i++) {
      const ans = answers[i];
      const qInfo = qInfoMap[ans.question_id];
      const isCorrect = qInfo ? evaluateTkaQuestionAnswer(qInfo.question_type, qInfo.choices, ans) : false;

      await client.query(
        `INSERT INTO tka_latihan_answers (session_id, question_id, chosen_choice_id, answer_text, is_correct, time_spent_sec, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, ans.question_id, ans.chosen_choice_id || null, ans.answer_text || null, isCorrect, ans.time_spent_sec || 0, i + 1]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { session_id: sessionId, score: totalScore, materi_analysis: materiAnalysis } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/tka/latihan/hasil/:sessionId
router.get('/latihan/hasil/:sessionId', verifyToken, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const sessionRes = await pool.query(
      `SELECT ls.*, s.name as subject_name, t.title as topic_title
       FROM tka_latihan_sessions ls
       LEFT JOIN tka_subjects s ON ls.subject_id = s.id
       LEFT JOIN tka_topics t ON ls.topic_id = t.id
       WHERE ls.id = $1 AND ls.user_id = $2`,
      [sessionId, req.user.id]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Hasil latihan tidak ditemukan' });
    }

    const session = sessionRes.rows[0];

    const answersRes = await pool.query(
      `SELECT la.*, q.content as question_content, q.stimulus, q.image_url, q.image_position, q.question_type, q.options_config, s.name as subject_name,
              ac.label as chosen_label, ac.content as chosen_content
       FROM tka_latihan_answers la
       JOIN tka_questions q ON la.question_id = q.id
       LEFT JOIN tka_subjects s ON q.subject_id = s.id
       LEFT JOIN tka_answer_choices ac ON la.chosen_choice_id = ac.id
       WHERE la.session_id = $1
       ORDER BY la.position ASC`,
      [sessionId]
    );

    const questionIds = answersRes.rows.map(a => a.question_id);
    const choicesRes = await pool.query(
      `SELECT * FROM tka_answer_choices WHERE question_id = ANY($1) ORDER BY label ASC`,
      [questionIds]
    );

    const choicesByQuestion = {};
    for (const c of choicesRes.rows) {
      if (!choicesByQuestion[c.question_id]) choicesByQuestion[c.question_id] = [];
      choicesByQuestion[c.question_id].push(c);
    }

    // Calculate ranking & participant stats
    let userRank = null;
    let totalParticipants = 0;
    try {
      let qParams = [session.subject_id];
      let whereClause = `WHERE ls.subject_id = $1`;
      if (session.topic_id) {
        qParams.push(session.topic_id);
        whereClause += ` AND ls.topic_id = $${qParams.length}`;
      }
      if (session.package_number) {
        qParams.push(session.package_number);
        whereClause += ` AND ls.package_number = $${qParams.length}`;
      }

      const leaderboardRes = await pool.query(
        `SELECT ls.user_id,
                COALESCE(
                  (SELECT ls_curr.total_score FROM tka_latihan_sessions ls_curr
                   ${whereClause.replace(/ls\./g, 'ls_curr.')} AND ls_curr.user_id = ls.user_id
                     AND ls_curr.submitted_at IS NOT NULL AND ls_curr.total_score IS NOT NULL
                   ORDER BY ls_curr.submitted_at DESC, ls_curr.started_at DESC LIMIT 1),
                  MAX(ls.total_score)
                ) as total_score
         FROM tka_latihan_sessions ls
         JOIN users u ON u.id = ls.user_id
         ${whereClause}
           AND ls.submitted_at IS NOT NULL
           AND ls.total_score IS NOT NULL
           AND u.role = 'student'
         GROUP BY ls.user_id`,
        qParams
      );

      const allSorted = leaderboardRes.rows
        .filter((r) => r.total_score !== null && r.total_score !== undefined)
        .sort((a, b) => (Number(b.total_score) || 0) - (Number(a.total_score) || 0));

      totalParticipants = allSorted.length;
      const userIdx = allSorted.findIndex((r) => r.user_id === req.user.id);
      if (userIdx >= 0) {
        userRank = {
          rank: userIdx + 1,
          total_participants: totalParticipants
        };
      }
    } catch (e) {
      console.error("Error calculating latihan rank:", e);
    }

    res.json({
      success: true,
      data: {
        session,
        answers,
        user_rank: userRank,
        total_participants: totalParticipants
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 3. STUDENT: Tryout TKA
// ============================================================

// GET /api/tka/tryout/packages?level=SD|SMP|SMA
router.get('/tryout/packages', verifyToken, async (req, res, next) => {
  try {
    const { level } = req.query;
    let query = `
      SELECT p.*,
        (SELECT COUNT(*)::int FROM tka_tryout_sessions s WHERE s.package_id = p.id AND s.user_id = $1 AND s.submitted_at IS NOT NULL) as my_attempts,
        (SELECT s.id FROM tka_tryout_sessions s WHERE s.package_id = p.id AND s.user_id = $1 AND s.submitted_at IS NOT NULL ORDER BY s.submitted_at DESC LIMIT 1) as last_submitted_session_id
      FROM tka_tryout_packages p
      WHERE p.is_active = TRUE AND p.is_public = TRUE
    `;
    const params = [req.user.id];

    if (level) {
      params.push(level.toUpperCase());
      query += ` AND p.education_level = $${params.length}`;
    }

    query += ` ORDER BY p.created_at DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/tka/tryout/packages/:id
router.get('/tryout/packages/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM tka_tryout_packages WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Paket tryout tidak ditemukan' });
    }
    const pkg = result.rows[0];

    // Check active session for this user & package
    const sessionRes = await pool.query(
      `SELECT * FROM tka_tryout_sessions WHERE user_id = $1 AND package_id = $2 ORDER BY started_at DESC LIMIT 1`,
      [req.user.id, id]
    );
    const session = sessionRes.rows[0] || null;

    let subtestProgress = {};
    if (session) {
      const statsRes = await pool.query(
        `SELECT q.subject_id,
                COUNT(DISTINCT q.id)::int as total_count,
                COUNT(DISTINCT ua.question_id)::int as answered_count
         FROM tka_questions q
         LEFT JOIN tka_user_answers ua ON ua.question_id = q.id AND ua.session_id = $1
         WHERE q.tryout_package_id = $2
         GROUP BY q.subject_id`,
        [session.id, id]
      );
      for (const row of statsRes.rows) {
        subtestProgress[row.subject_id] = {
          total: row.total_count,
          answered: row.answered_count
        };
      }
    }

    res.json({ success: true, data: pkg, session, subtestProgress });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/tryout/start
router.post('/tryout/start', verifyToken, async (req, res, next) => {
  try {
    const { package_id, selected_elective_subjects = [], force_new = false } = req.body;
    if (!package_id) {
      return res.status(400).json({ success: false, error: 'package_id wajib diisi' });
    }

    const pkgRes = await pool.query(`SELECT * FROM tka_tryout_packages WHERE id = $1`, [package_id]);
    if (pkgRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Paket tryout tidak ditemukan' });
    }

    const pkg = pkgRes.rows[0];

    // Check premium subscription if package requires premium plan
    if (pkg.required_plan === 'premium' && req.user.role !== 'admin') {
      const hasTkaPlan = await hasActiveTkaSubscription(req.user.id, pkg.education_level);
      if (!hasTkaPlan) {
        return res.status(403).json({
          success: false,
          error: `Paket Tryout TKA ini khusus untuk pengguna Premium TKA ${pkg.education_level}. Silakan upgrade paket belajar TKA ${pkg.education_level} Anda.`
        });
      }
    }

    // Validation for SMA level elective subjects
    if (pkg.education_level === 'SMA') {
      if (!Array.isArray(selected_elective_subjects) || selected_elective_subjects.length !== 2) {
        return res.status(400).json({ success: false, error: 'Tryout TKA SMA wajib memilih 2 mata pelajaran pilihan.' });
      }
    }

    // Check if active unsubmitted session exists (unless force_new is true)
    if (!force_new) {
      const existingSession = await pool.query(
        `SELECT * FROM tka_tryout_sessions WHERE user_id = $1 AND package_id = $2 AND submitted_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        [req.user.id, package_id]
      );

      if (existingSession.rows.length > 0) {
        if (pkg.education_level === 'SMA' && selected_elective_subjects.length === 2) {
          await pool.query(
            `UPDATE tka_tryout_sessions SET selected_elective_subjects = $1 WHERE id = $2`,
            [JSON.stringify(selected_elective_subjects), existingSession.rows[0].id]
          );
          existingSession.rows[0].selected_elective_subjects = selected_elective_subjects;
        }
        return res.json({ success: true, data: existingSession.rows[0] });
      }
    }

    const sessionRes = await pool.query(
      `INSERT INTO tka_tryout_sessions (user_id, package_id, education_level, selected_elective_subjects, started_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [req.user.id, package_id, pkg.education_level, JSON.stringify(selected_elective_subjects)]
    );

    res.json({ success: true, data: sessionRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/tka/tryout/session/:sessionId/questions?subject_id=...
router.get('/tryout/session/:sessionId/questions', verifyToken, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { subject_id } = req.query;

    const sRes = await pool.query(`SELECT * FROM tka_tryout_sessions WHERE id = $1 AND user_id = $2`, [sessionId, req.user.id]);
    if (sRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sesi tryout tidak ditemukan' });
    }

    const session = sRes.rows[0];

    let query = `
      SELECT q.id, q.subject_id, q.topic_id, q.content, q.stimulus, q.image_url, q.image_position,
             q.difficulty, q.question_type, q.options_config, q.display_order, s.name as subject_name,
             s.group_category,
             COALESCE(s.duration_minutes, CASE WHEN s.group_category = 'wajib' THEN 75 ELSE 60 END) as duration_minutes,
             ua.chosen_choice_id, ua.answer_text, ua.is_flagged
      FROM tka_questions q
      JOIN tka_subjects s ON q.subject_id = s.id
      LEFT JOIN tka_user_answers ua ON ua.question_id = q.id AND ua.session_id = $1
      WHERE q.tryout_package_id = $2
    `;
    const params = [sessionId, session.package_id];

    if (subject_id) {
      params.push(subject_id);
      query += ` AND q.subject_id = $${params.length}`;
    }

    query += ` ORDER BY s.display_order ASC, s.name ASC, q.display_order ASC, q.created_at ASC`;

    const qResult = await pool.query(query, params);
    const questions = qResult.rows;

    if (questions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const qIds = questions.map(q => q.id);
    const cResult = await pool.query(
      `SELECT id, question_id, label, content FROM tka_answer_choices WHERE question_id = ANY($1) ORDER BY label ASC`,
      [qIds]
    );

    const choicesByQuestion = {};
    for (const choice of cResult.rows) {
      if (!choicesByQuestion[choice.question_id]) {
        choicesByQuestion[choice.question_id] = [];
      }
      choicesByQuestion[choice.question_id].push(choice);
    }

    const data = questions.map(q => ({
      ...q,
      choices: choicesByQuestion[q.id] || []
    }));

    res.json({ success: true, data, session });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/tryout/submit-answer
router.post('/tryout/submit-answer', verifyToken, async (req, res, next) => {
  try {
    const { session_id, question_id, chosen_choice_id, answer_text, is_flagged, time_spent_sec, position } = req.body;
    if (!session_id || !question_id) {
      return res.status(400).json({ success: false, error: 'session_id dan question_id wajib diisi' });
    }

    await pool.query(
      `INSERT INTO tka_user_answers (session_id, question_id, chosen_choice_id, answer_text, is_flagged, time_spent_sec, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id, question_id)
       DO UPDATE SET
         chosen_choice_id = EXCLUDED.chosen_choice_id,
         answer_text = EXCLUDED.answer_text,
         is_flagged = EXCLUDED.is_flagged,
         time_spent_sec = tka_user_answers.time_spent_sec + EXCLUDED.time_spent_sec,
         position = EXCLUDED.position`,
      [session_id, question_id, chosen_choice_id || null, answer_text || null, !!is_flagged, time_spent_sec || 0, position || 0]
    );

    res.json({ success: true, message: 'Jawaban tersimpan' });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/tryout/submit-subtest
router.post('/tryout/submit-subtest', verifyToken, async (req, res, next) => {
  try {
    const { session_id, subject_id } = req.body;
    if (!session_id || !subject_id) {
      return res.status(400).json({ success: false, error: 'session_id dan subject_id wajib diisi' });
    }

    const sRes = await pool.query(
      `SELECT * FROM tka_tryout_sessions WHERE id = $1 AND user_id = $2`,
      [session_id, req.user.id]
    );
    if (sRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sesi tryout tidak ditemukan' });
    }

    let currentCompleted = [];
    try {
      const raw = sRes.rows[0].completed_subtests;
      currentCompleted = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
      if (!Array.isArray(currentCompleted)) currentCompleted = [];
    } catch (e) {
      currentCompleted = [];
    }

    if (!currentCompleted.includes(subject_id)) {
      currentCompleted.push(subject_id);
      await pool.query(
        `UPDATE tka_tryout_sessions SET completed_subtests = $1 WHERE id = $2`,
        [JSON.stringify(currentCompleted), session_id]
      );
    }

    res.json({ success: true, message: 'Subtes berhasil diselesaikan', completed_subtests: currentCompleted });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/tryout/submit-session
router.post('/tryout/submit-session', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ success: false, error: 'session_id wajib diisi' });
    }

    const sRes = await client.query(`SELECT * FROM tka_tryout_sessions WHERE id = $1 AND user_id = $2`, [session_id, req.user.id]);
    if (sRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sesi tryout tidak ditemukan' });
    }

    const session = sRes.rows[0];

    let electives = [];
    if (session.selected_elective_subjects) {
      try {
        electives = typeof session.selected_elective_subjects === 'string'
          ? JSON.parse(session.selected_elective_subjects)
          : session.selected_elective_subjects;
        if (!Array.isArray(electives)) electives = [];
      } catch (e) {
        electives = [];
      }
    }

    let qQuery = `
      SELECT q.id, q.subject_id, q.topic_id, q.question_type, q.options_config, s.name as subject_name, s.group_category, t.title as topic_title
      FROM tka_questions q
      JOIN tka_subjects s ON q.subject_id = s.id
      LEFT JOIN tka_topics t ON q.topic_id = t.id
      WHERE q.tryout_package_id = $1
    `;
    const qParams = [session.package_id];

    if (session.education_level === 'SMA' && electives.length > 0) {
      qParams.push(electives);
      qQuery += ` AND (s.group_category = 'wajib' OR q.subject_id = ANY($${qParams.length}))`;
    }

    const qRes = await client.query(qQuery, qParams);

    const questions = qRes.rows;
    const qIds = questions.map(q => q.id);

    const choicesRes = await client.query(
      `SELECT id, question_id, label, content, is_correct FROM tka_answer_choices WHERE question_id = ANY($1)`,
      [qIds]
    );

    const choicesByQuestion = {};
    for (const c of choicesRes.rows) {
      if (!choicesByQuestion[c.question_id]) choicesByQuestion[c.question_id] = [];
      choicesByQuestion[c.question_id].push(c);
    }

    const uAnswersRes = await client.query(
      `SELECT * FROM tka_user_answers WHERE session_id = $1`,
      [session_id]
    );

    const userAnsMap = {};
    for (const ua of uAnswersRes.rows) {
      userAnsMap[ua.question_id] = ua;
    }

    const subjectStats = {};
    const materiItems = [];

    for (const q of questions) {
      const sId = q.subject_id;
      const sName = q.subject_name;

      if (!subjectStats[sId]) {
        subjectStats[sId] = { subject_id: sId, subject_name: sName, total: 0, correct: 0, score: 0 };
      }
      subjectStats[sId].total += 1;

      const ua = userAnsMap[q.id];
      const qChoices = choicesByQuestion[q.id] || [];
      const isCorrect = ua ? evaluateTkaQuestionAnswer(q.question_type, qChoices, ua) : false;

      if (isCorrect) {
        subjectStats[sId].correct += 1;
      }

      materiItems.push({
        subject_id: q.subject_id,
        subject_name: q.subject_name || 'Mata Pelajaran',
        topic_title: q.topic_title || 'Materi Umum',
        is_correct: isCorrect
      });
    }

    let totalSubtestScoreSum = 0;
    let subtestCount = 0;

    for (const sId in subjectStats) {
      const st = subjectStats[sId];
      st.score = calculateScaledScore(st.correct, st.total);
      totalSubtestScoreSum += st.score;
      subtestCount += 1;
    }

    const overallTotalScore = subtestCount > 0 ? Math.round((totalSubtestScoreSum / subtestCount) * 10) / 10 : 0;
    const materiAnalysis = generateMateriAnalysis(materiItems);

    await client.query(
      `UPDATE tka_tryout_sessions
       SET submitted_at = NOW(),
           total_score = $1,
           score_breakdown = $2,
           materi_analysis = $3
       WHERE id = $4`,
      [overallTotalScore, JSON.stringify(subjectStats), JSON.stringify(materiAnalysis), session_id]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      data: {
        session_id,
        total_score: overallTotalScore,
        score_breakdown: subjectStats,
        materi_analysis: materiAnalysis
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/tka/tryout/hasil/:sessionId
router.get('/tryout/hasil/:sessionId', verifyToken, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const sRes = await pool.query(
      `SELECT s.*, p.title as package_title, p.education_level as package_level
       FROM tka_tryout_sessions s
       JOIN tka_tryout_packages p ON s.package_id = p.id
       WHERE s.id = $1 AND s.user_id = $2`,
      [sessionId, req.user.id]
    );

    if (sRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Hasil tryout tidak ditemukan' });
    }

    const session = sRes.rows[0];

    let electives = [];
    if (session.selected_elective_subjects) {
      try {
        electives = typeof session.selected_elective_subjects === 'string'
          ? JSON.parse(session.selected_elective_subjects)
          : session.selected_elective_subjects;
        if (!Array.isArray(electives)) electives = [];
      } catch (e) {
        electives = [];
      }
    }

    let qQuery = `
      SELECT q.id, q.subject_id, q.topic_id, q.content, q.stimulus, q.image_url, q.image_position, q.question_type, q.options_config,
             s.name as subject_name, s.group_category, t.title as topic_title,
             ua.chosen_choice_id, ua.answer_text, ua.is_flagged
      FROM tka_questions q
      JOIN tka_subjects s ON q.subject_id = s.id
      LEFT JOIN tka_topics t ON q.topic_id = t.id
      LEFT JOIN tka_user_answers ua ON ua.question_id = q.id AND ua.session_id = $1
      WHERE q.tryout_package_id = $2
    `;
    const qParams = [sessionId, session.package_id];

    if (session.education_level === 'SMA' && electives.length > 0) {
      qParams.push(electives);
      qQuery += ` AND (s.group_category = 'wajib' OR q.subject_id = ANY($${qParams.length}))`;
    }

    qQuery += ` ORDER BY s.display_order ASC, s.name ASC, q.display_order ASC, q.created_at ASC`;
    const qRes = await pool.query(qQuery, qParams);

    const questions = qRes.rows;
    const qIds = questions.map(q => q.id);

    const choicesRes = qIds.length > 0 ? await pool.query(
      `SELECT * FROM tka_answer_choices WHERE question_id = ANY($1) ORDER BY label ASC`,
      [qIds]
    ) : { rows: [] };

    const choicesByQuestion = {};
    for (const c of choicesRes.rows) {
      if (!choicesByQuestion[c.question_id]) choicesByQuestion[c.question_id] = [];
      choicesByQuestion[c.question_id].push(c);
    }

    const fullQuestions = questions.map(q => {
      const qChoices = choicesByQuestion[q.id] || [];
      const ua = { chosen_choice_id: q.chosen_choice_id, answer_text: q.answer_text };
      const is_correct = evaluateTkaQuestionAnswer(q.question_type, qChoices, ua);
      return {
        ...q,
        is_correct,
        choices: qChoices
      };
    });

    // Calculate ranking & participant stats
    let userRank = null;
    let totalParticipants = 0;
    try {
      const leaderboardRes = await pool.query(
        `SELECT ts.user_id,
                COALESCE(
                  (SELECT ts_curr.total_score FROM tka_tryout_sessions ts_curr
                   WHERE ts_curr.user_id = ts.user_id AND ts_curr.package_id = $1
                     AND ts_curr.submitted_at IS NOT NULL AND ts_curr.total_score IS NOT NULL
                   ORDER BY ts_curr.submitted_at DESC, ts_curr.started_at DESC LIMIT 1),
                  MAX(ts.total_score)
                ) as total_score
         FROM tka_tryout_sessions ts
         JOIN users u ON u.id = ts.user_id
         WHERE ts.package_id = $1
           AND ts.submitted_at IS NOT NULL
           AND ts.total_score IS NOT NULL
           AND u.role = 'student'
         GROUP BY ts.user_id`,
        [session.package_id]
      );

      const allSorted = leaderboardRes.rows
        .filter((r) => r.total_score !== null && r.total_score !== undefined)
        .sort((a, b) => (Number(b.total_score) || 0) - (Number(a.total_score) || 0));

      totalParticipants = allSorted.length;
      const userIdx = allSorted.findIndex((r) => r.user_id === req.user.id);
      if (userIdx >= 0) {
        userRank = {
          rank: userIdx + 1,
          total_participants: totalParticipants
        };
      }
    } catch (e) {
      console.error("Error calculating tryout rank:", e);
    }

    res.json({
      success: true,
      data: {
        session,
        questions: fullQuestions,
        user_rank: userRank,
        total_participants: totalParticipants
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 4. STUDENT: Riwayat & Evaluasi Chart
// ============================================================

// GET /api/tka/riwayat
router.get('/riwayat', verifyToken, async (req, res, next) => {
  try {
    const { level } = req.query;

    let tryoutQuery = `
      SELECT s.id, 'tryout' as session_type, s.education_level, s.started_at, s.submitted_at, s.total_score,
             p.title as title, p.id as package_id
      FROM tka_tryout_sessions s
      JOIN tka_tryout_packages p ON s.package_id = p.id
      WHERE s.user_id = $1 AND s.submitted_at IS NOT NULL
    `;
    const tryoutParams = [req.user.id];

    if (level) {
      tryoutParams.push(level.toUpperCase());
      tryoutQuery += ` AND s.education_level = $${tryoutParams.length}`;
    }

    let latihanQuery = `
      SELECT l.id, 'latihan' as session_type, l.education_level, l.started_at, l.submitted_at, l.total_score,
             sub.name as title, l.subject_id as package_id
      FROM tka_latihan_sessions l
      LEFT JOIN tka_subjects sub ON l.subject_id = sub.id
      WHERE l.user_id = $1 AND l.submitted_at IS NOT NULL
    `;
    const latihanParams = [req.user.id];

    if (level) {
      latihanParams.push(level.toUpperCase());
      latihanQuery += ` AND l.education_level = $${latihanParams.length}`;
    }

    const [tRes, lRes] = await Promise.all([
      pool.query(tryoutQuery, tryoutParams),
      pool.query(latihanQuery, latihanParams)
    ]);

    const combined = [...tRes.rows, ...lRes.rows].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));

    res.json({ success: true, data: combined });
  } catch (err) {
    next(err);
  }
});

// GET /api/tka/evaluasi-chart
router.get('/evaluasi-chart', verifyToken, async (req, res, next) => {
  try {
    const { level } = req.query;
    let query = `
      SELECT s.id, s.education_level, s.submitted_at, s.total_score, p.title
      FROM tka_tryout_sessions s
      JOIN tka_tryout_packages p ON s.package_id = p.id
      WHERE s.user_id = $1 AND s.submitted_at IS NOT NULL
    `;
    const params = [req.user.id];

    if (level) {
      params.push(level.toUpperCase());
      query += ` AND s.education_level = $${params.length}`;
    }

    query += ` ORDER BY s.submitted_at ASC LIMIT 20`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 5. ADMIN: Manage Questions, Topics, Tryout Packages & Import Excel
// ============================================================

// POST /api/tka/admin/topics
router.post('/admin/topics', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id, subject_id, title, description, icon, difficulty_level, display_order } = req.body;
    if (!subject_id || !title) {
      return res.status(400).json({ success: false, error: 'subject_id dan title wajib diisi' });
    }

    let result;
    if (id) {
      result = await pool.query(
        `UPDATE tka_topics
         SET subject_id = $1, title = $2, description = $3, icon = $4, difficulty_level = $5, display_order = $6
         WHERE id = $7 RETURNING *`,
        [subject_id, title, description || '', icon || 'topic', difficulty_level || 'Dasar', display_order || 0, id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO tka_topics (subject_id, title, description, icon, difficulty_level, display_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [subject_id, title, description || '', icon || 'topic', difficulty_level || 'Dasar', display_order || 0]
      );
    }

    logAdminActivity(req.user.id, id ? 'UPDATE_TKA_TOPIC' : 'CREATE_TKA_TOPIC', `Topic: ${title}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tka/admin/topics/:id
router.delete('/admin/topics/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tka_topics WHERE id = $1', [id]);
    logAdminActivity(req.user.id, 'DELETE_TKA_TOPIC', `Topic ID: ${id}`);
    res.json({ success: true, message: 'Topic berhasil dihapus' });
  } catch (err) {
    next(err);
  }
});

// GET /api/tka/admin/questions
router.get('/admin/questions', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { level, subject_id, topic_id, tryout_package_id, destination } = req.query;
    let query = `
      SELECT q.*, s.name as subject_name, t.title as topic_title, tp.title as tryout_package_title
      FROM tka_questions q
      JOIN tka_subjects s ON q.subject_id = s.id
      LEFT JOIN tka_topics t ON q.topic_id = t.id
      LEFT JOIN tka_tryout_packages tp ON q.tryout_package_id = tp.id
      WHERE 1=1
    `;
    const params = [];

    if (level) {
      params.push(level.toUpperCase());
      query += ` AND q.education_level = $${params.length}`;
    }
    if (subject_id) {
      params.push(subject_id);
      query += ` AND q.subject_id = $${params.length}`;
    }
    if (topic_id) {
      params.push(topic_id);
      query += ` AND q.topic_id = $${params.length}`;
    }
    if (tryout_package_id) {
      params.push(tryout_package_id);
      query += ` AND q.tryout_package_id = $${params.length}`;
    } else if (destination === 'latihan') {
      query += ` AND q.tryout_package_id IS NULL`;
    }

    query += ` ORDER BY s.display_order ASC, s.name ASC, q.display_order ASC, q.created_at ASC`;

    const qResult = await pool.query(query, params);
    const questions = qResult.rows;

    if (questions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const qIds = questions.map(q => q.id);
    const cResult = await pool.query(
      `SELECT * FROM tka_answer_choices WHERE question_id = ANY($1) ORDER BY label ASC`,
      [qIds]
    );

    const choicesByQuestion = {};
    for (const c of cResult.rows) {
      if (!choicesByQuestion[c.question_id]) choicesByQuestion[c.question_id] = [];
      choicesByQuestion[c.question_id].push(c);
    }

    const data = questions.map(q => ({
      ...q,
      choices: choicesByQuestion[q.id] || []
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/admin/questions (Manual Entry & Update)
router.post('/admin/questions', [verifyToken, verifyAdmin], async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      id, subject_id, topic_id, tryout_package_id, education_level, package_number = 1,
      content, stimulus, image_url, image_position = 'after', difficulty = 'medium',
      question_type = 'multiple_choice', options_config = {}, display_order, choices = []
    } = req.body;

    if (!subject_id || !education_level || !content) {
      return res.status(400).json({ success: false, error: 'subject_id, education_level, dan content wajib diisi' });
    }

    const contentHash = generateQuestionHash(content);
    let questionId = id;

    if (id) {
      // If display_order is provided from form, use it; otherwise preserve existing display_order in DB
      let targetOrder = display_order;
      if (targetOrder === undefined || targetOrder === null) {
        const existingQ = await client.query('SELECT display_order FROM tka_questions WHERE id = $1', [id]);
        targetOrder = existingQ.rows[0]?.display_order || 1;
      }

      await client.query(
        `UPDATE tka_questions
         SET subject_id = $1, topic_id = $2, tryout_package_id = $3, education_level = $4,
             content = $5, stimulus = $6, image_url = $7, image_position = $8, difficulty = $9,
             question_type = $10, options_config = $11, display_order = $12, content_hash = $13, package_number = $14
         WHERE id = $15`,
        [subject_id, topic_id || null, tryout_package_id || null, education_level, content, stimulus || null, image_url || null, image_position, difficulty, question_type, JSON.stringify(options_config || {}), targetOrder, contentHash, package_number, id]
      );
      await client.query('DELETE FROM tka_answer_choices WHERE question_id = $1', [id]);
    } else {
      // For new question, calculate next display_order if not provided
      let targetOrder = display_order;
      if (targetOrder === undefined || targetOrder === null) {
        const maxOrderRes = await client.query(
          `SELECT COALESCE(MAX(display_order), 0) as max_order FROM tka_questions WHERE subject_id = $1 AND (($2::uuid IS NULL AND tryout_package_id IS NULL) OR tryout_package_id = $2)`,
          [subject_id, tryout_package_id || null]
        );
        targetOrder = (parseInt(maxOrderRes.rows[0]?.max_order, 10) || 0) + 1;
      }

      const qRes = await client.query(
        `INSERT INTO tka_questions
         (subject_id, topic_id, tryout_package_id, education_level, content, stimulus, image_url, image_position, difficulty, question_type, options_config, display_order, content_hash, package_number, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [subject_id, topic_id || null, tryout_package_id || null, education_level, content, stimulus || null, image_url || null, image_position, difficulty, question_type, JSON.stringify(options_config || {}), targetOrder, contentHash, package_number, req.user.id]
      );
      questionId = qRes.rows[0].id;
    }

    if (Array.isArray(choices) && choices.length > 0) {
      for (const choice of choices) {
        await client.query(
          `INSERT INTO tka_answer_choices (question_id, label, content, is_correct, explanation)
           VALUES ($1, $2, $3, $4, $5)`,
          [questionId, choice.label, choice.content || '', !!choice.is_correct, choice.explanation || '']
        );
      }
    }

    await client.query('COMMIT');
    logAdminActivity(req.user.id, id ? 'UPDATE_TKA_QUESTION' : 'CREATE_TKA_QUESTION', `Question ID: ${questionId}`);
    res.json({ success: true, data: { id: questionId } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/tka/admin/questions/:id
router.delete('/admin/questions/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tka_questions WHERE id = $1', [id]);
    logAdminActivity(req.user.id, 'DELETE_TKA_QUESTION', `Question ID: ${id}`);
    res.json({ success: true, message: 'Soal TKA berhasil dihapus' });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/admin/tryout/packages (Create/Update Package)
router.post('/admin/tryout/packages', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id, title, education_level, description, subject_config, scheduled_at, is_public, is_active, required_plan } = req.body;
    if (!title || !education_level) {
      return res.status(400).json({ success: false, error: 'title dan education_level wajib diisi' });
    }

    let result;
    if (id) {
      result = await pool.query(
        `UPDATE tka_tryout_packages
         SET title = $1, education_level = $2, description = $3, subject_config = $4,
             scheduled_at = $5, is_public = $6, is_active = $7, required_plan = $8
         WHERE id = $9 RETURNING *`,
        [title, education_level, description || '', JSON.stringify(subject_config || []), scheduled_at || null, is_public !== false, is_active !== false, required_plan || 'gratis', id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO tka_tryout_packages
         (title, education_level, description, subject_config, scheduled_at, is_public, is_active, required_plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [title, education_level, description || '', JSON.stringify(subject_config || []), scheduled_at || null, is_public !== false, is_active !== false, required_plan || 'gratis']
      );
    }

    logAdminActivity(req.user.id, id ? 'UPDATE_TKA_PACKAGE' : 'CREATE_TKA_PACKAGE', `Package: ${title}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tka/admin/tryout/packages/:id
router.delete('/admin/tryout/packages/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tka_tryout_packages WHERE id = $1', [id]);
    logAdminActivity(req.user.id, 'DELETE_TKA_PACKAGE', `Package ID: ${id}`);
    res.json({ success: true, message: 'Paket tryout TKA berhasil dihapus' });
  } catch (err) {
    next(err);
  }
});

// POST /api/tka/admin/import/excel
router.post('/admin/import/excel', [verifyToken, verifyAdmin], upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const { subject_id, topic_id, tryout_package_id, education_level = 'SMA', difficulty = 'medium', destination = 'latihan' } = req.body;
  if (!subject_id || !education_level) {
    return res.status(400).json({ success: false, error: 'subject_id dan education_level wajib diisi' });
  }

  const ALIASES = {
    materi: [
      'materi', 'topik', 'topic', 'judul materi', 'bab', 'materi pokok',
      'nama materi', 'subtes materi', 'materi/topik', 'materi / topik',
      'materi soal', 'bab/materi', 'bab materi'
    ],
    tingkat_kesulitan: [
      'tingkat kesulitan', 'tingkat_kesulitan', 'kesulitan', 'difficulty',
      'level kesulitan', 'level', 'tingkat', 'kesulitan soal',
      'kategori kesulitan', 'derajat kesulitan', 'tingkat kesukaran'
    ],
    stimulus: ['stimulus', 'wacana', 'bacaan'],
    soal: ['soal', 'content', 'question', 'pertanyaan'],
    opsi_a: ['opsi a', 'opsia', 'choice_a', 'pilihan a', 'a'],
    opsi_b: ['opsi b', 'opsib', 'choice_b', 'pilihan b', 'b'],
    opsi_c: ['opsi c', 'opsic', 'choice_c', 'pilihan c', 'c'],
    opsi_d: ['opsi d', 'opsid', 'choice_d', 'pilihan d', 'd'],
    opsi_e: ['opsi e', 'opsie', 'choice_e', 'pilihan e', 'e'],
    kunci: ['kunci jawaban', 'kunci', 'correct_label', 'answer', 'jawaban', 'kunci_jawaban'],
    pembahasan: ['pembahasan', 'explanation', 'penjelasan'],
    image_url: ['gambar', 'image', 'image_url', 'url gambar', 'foto'],
    tipe_soal: ['tipe soal', 'tipe', 'question_type', 'type', 'tipe_soal'],
    label_kolom: ['label_kolom', 'label kolom', 'kolom_pilihan', 'tf_label', 'label_benar_salah', 'opsi_label', 'label_opsi'],
    image_position: ['posisi gambar', 'posisi_gambar', 'image_position', 'image position']
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

  const resolveWithPositionalFallback = (row, key, pos) => {
    const directVal = resolve(row, key);
    if (directVal) return directVal;

    const keys = Object.keys(row);
    if (keys.length === 0) return '';
    if (pos === 'start') {
      const firstKey = keys[0];
      const cleanKey = firstKey.replace(/^\uFEFF/, '').trim().toLowerCase();
      const isKnownStandardCol = ['soal', 'content', 'stimulus', 'opsi a', 'a', 'opsi b', 'b', 'kunci', 'kunci jawaban'].includes(cleanKey);
      if (!isKnownStandardCol) {
        const val = row[firstKey];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          return String(val).trim();
        }
      }
    } else if (pos === 'end') {
      const lastKey = keys[keys.length - 1];
      const cleanKey = lastKey.replace(/^\uFEFF/, '').trim().toLowerCase();
      const isKnownStandardCol = ['soal', 'opsi a', 'opsi b', 'opsi c', 'opsi d', 'opsi e', 'kunci'].includes(cleanKey);
      if (!isKnownStandardCol) {
        const val = row[lastKey];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          return String(val).trim();
        }
      }
    }
    return '';
  };

  let results = [];
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    results = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ success: false, error: `Excel parse error: ${err.message}` });
  }

  if (!results || results.length === 0) {
    return res.status(400).json({ success: false, error: 'File Excel kosong atau tidak memiliki data' });
  }

  let importedCount = 0;
  let rejectedCount = 0;
  const errors = [];
  const topicCache = {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const maxOrderRes = await client.query(
      `SELECT COALESCE(MAX(display_order), 0) as max_order FROM tka_questions WHERE subject_id = $1 AND (($2::uuid IS NULL AND tryout_package_id IS NULL) OR tryout_package_id = $2)`,
      [subject_id, tryout_package_id || null]
    );
    const baseOrder = parseInt(maxOrderRes.rows[0]?.max_order, 10) || 0;

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const rowNum = i + 2;

      let rawMateri = resolve(row, 'materi');
      let rawDifficulty = resolve(row, 'tingkat_kesulitan');

      // Check positional fallback if not matched by header alias (urutan awal / urutan akhir)
      if (!rawMateri) {
        const candidateStart = resolveWithPositionalFallback(row, 'materi', 'start');
        const candidateEnd = resolveWithPositionalFallback(row, 'materi', 'end');
        const diffKeywords = ['mudah', 'easy', 'sedang', 'medium', 'sulit', 'hard', 'dasar', 'menengah', 'sukar', 'hots'];
        if (candidateStart && !diffKeywords.includes(candidateStart.toLowerCase())) {
          rawMateri = candidateStart;
        } else if (candidateEnd && !diffKeywords.includes(candidateEnd.toLowerCase())) {
          rawMateri = candidateEnd;
        }
      }

      if (!rawDifficulty) {
        const candidateStart = resolveWithPositionalFallback(row, 'tingkat_kesulitan', 'start');
        const candidateEnd = resolveWithPositionalFallback(row, 'tingkat_kesulitan', 'end');
        const diffKeywords = ['mudah', 'easy', 'sedang', 'medium', 'sulit', 'hard', 'dasar', 'menengah', 'sukar', 'hots'];
        if (candidateEnd && diffKeywords.includes(candidateEnd.toLowerCase())) {
          rawDifficulty = candidateEnd;
        } else if (candidateStart && diffKeywords.includes(candidateStart.toLowerCase())) {
          rawDifficulty = candidateStart;
        }
      }

      const stimulus = resolve(row, 'stimulus');
      const soal = resolve(row, 'soal');
      const opsiA = resolve(row, 'opsi_a');
      const opsiB = resolve(row, 'opsi_b');
      const opsiC = resolve(row, 'opsi_c');
      const opsiD = resolve(row, 'opsi_d');
      const opsiE = resolve(row, 'opsi_e');
      const kunci = resolve(row, 'kunci');
      const pembahasan = resolve(row, 'pembahasan');
      const imageUrl = resolve(row, 'image_url');
      const rawTipe = resolve(row, 'tipe_soal').toLowerCase();
      const rawPos = resolve(row, 'image_position').toLowerCase();
      const rawLabelKolom = resolve(row, 'label_kolom');

      const imagePosition = ['before', 'top', 'atas'].includes(rawPos) ? 'before' : 'after';

      if (!soal) {
        errors.push(`Baris ${rowNum}: Kolom SOAL kosong`);
        rejectedCount++;
        continue;
      }

      let questionType = 'multiple_choice';
      const cleanTipe = rawTipe.replace(/[\s\-_]+/g, ' ').trim();

      if (
        cleanTipe === 'multiple choice' ||
        cleanTipe === 'single' ||
        cleanTipe === 'pg tunggal' ||
        cleanTipe === 'pilihan ganda tunggal' ||
        cleanTipe === 'pilihan ganda' ||
        cleanTipe === 'pg'
      ) {
        questionType = 'multiple_choice';
      } else if (
        cleanTipe.includes('complex mc multi') ||
        cleanTipe.includes('multi jawaban') ||
        cleanTipe.includes('multi opsi') ||
        cleanTipe.includes('lebih dari 1') ||
        cleanTipe.includes('lebih dari satu') ||
        cleanTipe.includes('banyak jawaban') ||
        cleanTipe.includes('centang') ||
        (cleanTipe.includes('multi') && !cleanTipe.includes('multiple choice'))
      ) {
        questionType = 'complex_mc_multi';
      } else if (
        cleanTipe.includes('short') ||
        cleanTipe.includes('isian') ||
        cleanTipe.includes('singkat')
      ) {
        questionType = 'short_answer';
      } else if (
        cleanTipe.includes('complex mc tf') ||
        cleanTipe.includes('kompleks') ||
        cleanTipe.includes('complex') ||
        cleanTipe.includes('benar') ||
        cleanTipe.includes('salah') ||
        cleanTipe.includes('tf') ||
        cleanTipe.includes('tepat') ||
        cleanTipe.includes('true')
      ) {
        questionType = 'complex_mc_tf';
      }

      let optionsConfig = {};
      const cleanKunci = (kunci || '').toUpperCase().trim();

      if (questionType === 'complex_mc_tf') {
        if (rawLabelKolom) {
          const parts = rawLabelKolom.split(/[\/,;|\-]+/).map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            optionsConfig = { true_label: parts[0], false_label: parts[1] };
          }
        } else if (cleanKunci.includes('TRUE') || cleanKunci.includes('FALSE')) {
          optionsConfig = { true_label: 'TRUE', false_label: 'FALSE' };
        } else if (cleanKunci.includes('TEPAT')) {
          optionsConfig = { true_label: 'Tepat', false_label: 'Tidak Tepat' };
        } else if (cleanKunci.includes('SESUAI')) {
          optionsConfig = { true_label: 'Sesuai', false_label: 'Tidak Sesuai' };
        } else if (cleanKunci.includes('YA') || cleanKunci.includes('TIDAK')) {
          optionsConfig = { true_label: 'Ya', false_label: 'Tidak' };
        } else {
          optionsConfig = { true_label: 'Benar', false_label: 'Salah' };
        }
      }

      // Resolve difficulty per question
      let resolvedDifficulty = difficulty || 'medium';
      if (rawDifficulty) {
        const dLower = rawDifficulty.toLowerCase().trim();
        if (dLower.includes('mudah') || dLower.includes('easy') || dLower.includes('dasar') || dLower === '1') {
          resolvedDifficulty = 'easy';
        } else if (dLower.includes('sulit') || dLower.includes('hard') || dLower.includes('sukar') || dLower.includes('hots') || dLower.includes('tinggi') || dLower === '3') {
          resolvedDifficulty = 'hard';
        } else if (dLower.includes('sedang') || dLower.includes('medium') || dLower.includes('menengah') || dLower === '2') {
          resolvedDifficulty = 'medium';
        }
      }

      // Resolve topic/materi per question (auto-link or auto-create topic if named)
      let resolvedTopicId = topic_id || null;
      if (rawMateri) {
        const materiKey = rawMateri.toLowerCase().trim();
        if (!topicCache[materiKey]) {
          const tRes = await client.query(
            `SELECT id FROM tka_topics WHERE subject_id = $1 AND LOWER(TRIM(title)) = LOWER(TRIM($2)) LIMIT 1`,
            [subject_id, rawMateri.trim()]
          );
          if (tRes.rows.length > 0) {
            topicCache[materiKey] = tRes.rows[0].id;
          } else {
            const newTopicRes = await client.query(
              `INSERT INTO tka_topics (subject_id, title, difficulty_level, display_order)
               VALUES ($1, $2, 'Dasar', 0) RETURNING id`,
              [subject_id, rawMateri.trim()]
            );
            topicCache[materiKey] = newTopicRes.rows[0].id;
          }
        }
        resolvedTopicId = topicCache[materiKey];
      }

      const contentHash = generateQuestionHash(soal);

      const qRes = await client.query(
        `INSERT INTO tka_questions
         (subject_id, topic_id, tryout_package_id, education_level, content, stimulus, image_url, image_position, difficulty, question_type, options_config, display_order, content_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [subject_id, resolvedTopicId, tryout_package_id || null, education_level, soal, stimulus || null, imageUrl || null, imagePosition, resolvedDifficulty, questionType, JSON.stringify(optionsConfig), baseOrder + i + 1, contentHash, req.user.id]
      );

      const questionId = qRes.rows[0].id;
      const choicesRaw = [
        { label: 'A', content: opsiA },
        { label: 'B', content: opsiB },
        { label: 'C', content: opsiC },
        { label: 'D', content: opsiD },
        { label: 'E', content: opsiE },
      ].filter(c => c.content !== '');

      if (questionType === 'short_answer') {
        await client.query(
          `INSERT INTO tka_answer_choices (question_id, label, content, is_correct, explanation)
           VALUES ($1, $2, $3, $4, $5)`,
          [questionId, 'A', kunci, true, pembahasan || '']
        );
      } else if (questionType === 'complex_mc_multi') {
        const matchedLetters = cleanKunci.match(/[A-E]/g) || [];
        const correctLetters = Array.from(new Set(matchedLetters));
        for (const choice of choicesRaw) {
          const isCorrect = correctLetters.includes(choice.label);
          await client.query(
            `INSERT INTO tka_answer_choices (question_id, label, content, is_correct, explanation)
             VALUES ($1, $2, $3, $4, $5)`,
            [questionId, choice.label, choice.content, isCorrect, pembahasan || '']
          );
        }
      } else if (questionType === 'complex_mc_tf') {
        const isValueTrue = (val) => {
          const v = String(val).trim().toUpperCase();
          if (v.startsWith('TIDAK') || v.startsWith('BUKAN') || v === 'S' || v === 'SALAH' || v === 'FALSE' || v === '0') {
            return false;
          }
          if (v === 'B' || v === 'T' || v === '1' || v === 'YA' || v === 'BENAR' || v === 'TRUE' || v === 'TEPAT' || v === 'SESUAI' || v.startsWith('BENAR') || v.startsWith('TRUE') || v.startsWith('TEPAT') || v.startsWith('SESUAI')) {
            return true;
          }
          return false;
        };

        let correctnessMap = {};
        if (cleanKunci.includes(':')) {
          const pairs = cleanKunci.split(/[,;\n\r]+/);
          for (const pair of pairs) {
            const colonIdx = pair.indexOf(':');
            if (colonIdx !== -1) {
              const lbl = pair.substring(0, colonIdx).trim().toUpperCase();
              const val = pair.substring(colonIdx + 1).trim();
              if (lbl && val) {
                correctnessMap[lbl] = isValueTrue(val);
              }
            }
          }
        } else {
          // Split by comma or semicolon (preserves multi-word values like "Tidak Tepat")
          const parts = cleanKunci.split(/[,;\n\r]+/).map(s => s.trim()).filter(Boolean);
          const labels = ['A', 'B', 'C', 'D', 'E'];
          parts.forEach((part, idx) => {
            if (idx < labels.length) {
              correctnessMap[labels[idx]] = isValueTrue(part);
            }
          });
        }

        for (const choice of choicesRaw) {
          const isCorrect = correctnessMap[choice.label] === true;
          await client.query(
            `INSERT INTO tka_answer_choices (question_id, label, content, is_correct, explanation)
             VALUES ($1, $2, $3, $4, $5)`,
            [questionId, choice.label, choice.content, isCorrect, pembahasan || '']
          );
        }
      } else {
        for (const choice of choicesRaw) {
          const isCorrect = cleanKunci.includes(choice.label);
          await client.query(
            `INSERT INTO tka_answer_choices (question_id, label, content, is_correct, explanation)
             VALUES ($1, $2, $3, $4, $5)`,
            [questionId, choice.label, choice.content, isCorrect, pembahasan || '']
          );
        }
      }

      importedCount++;
    }

    await client.query('COMMIT');
    logAdminActivity(req.user.id, 'IMPORT_TKA_EXCEL', `Imported ${importedCount} TKA questions`);
    res.json({
      success: true,
      data: { importedCount, rejectedCount, errors }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ============================================================
// 6. STUDENT: Leaderboard TKA (Tryout & Latihan)
// ============================================================

// GET /api/tka/tryout/leaderboard/:packageId
router.get('/tryout/leaderboard/:packageId', verifyToken, async (req, res, next) => {
  try {
    const { packageId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);

    const pkgRes = await pool.query(
      `SELECT id, title, education_level, required_plan FROM tka_tryout_packages WHERE id = $1`,
      [packageId]
    );

    const packageInfo = pkgRes.rows[0] || null;

    const leaderboardRes = await pool.query(
      `
      SELECT
        ts.user_id,
        u.name,
        COALESCE(
          (SELECT ts_curr.total_score FROM tka_tryout_sessions ts_curr
           WHERE ts_curr.user_id = ts.user_id AND ts_curr.package_id = $1
             AND ts_curr.submitted_at IS NOT NULL AND ts_curr.total_score IS NOT NULL
           ORDER BY ts_curr.submitted_at DESC, ts_curr.started_at DESC LIMIT 1),
          MAX(ts.total_score)
        ) as total_score,
        MAX(ts.submitted_at) as submitted_at
      FROM tka_tryout_sessions ts
      JOIN users u ON u.id = ts.user_id
      WHERE ts.package_id = $1
        AND ts.submitted_at IS NOT NULL
        AND ts.total_score IS NOT NULL
        AND u.role = 'student'
      GROUP BY ts.user_id, u.name
    `,
      [packageId]
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

    res.json({
      success: true,
      data: {
        package_info: packageInfo,
        education_level: packageInfo?.education_level || null,
        title: packageInfo?.title || 'Tryout TKA',
        leaderboard: sorted,
        user_rank: userRank,
        total_participants: allSorted.length,
      },
    });
  } catch (error) {
    console.error("TKA Tryout Leaderboard error:", error);
    next(error);
  }
});

// GET /api/tka/latihan/leaderboard/:subjectId
router.get('/latihan/leaderboard/:subjectId', verifyToken, async (req, res, next) => {
  try {
    const { subjectId } = req.params;
    const { topic_id, package_number } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);

    const subjRes = await pool.query(
      `SELECT id, name, full_name, education_level FROM tka_subjects WHERE id = $1`,
      [subjectId]
    );
    const subjectInfo = subjRes.rows[0] || null;

    let query = `
      SELECT DISTINCT ON (ls.user_id)
        ls.user_id,
        u.name,
        ls.total_score,
        ls.submitted_at
      FROM tka_latihan_sessions ls
      JOIN users u ON u.id = ls.user_id
      WHERE ls.subject_id = $1
        AND ls.submitted_at IS NOT NULL
        AND ls.total_score IS NOT NULL
        AND u.role = 'student'
    `;
    const params = [subjectId];

    if (topic_id) {
      params.push(topic_id);
      query += ` AND ls.topic_id = $${params.length}`;
    }

    if (package_number) {
      params.push(parseInt(package_number, 10));
      query += ` AND ls.package_number = $${params.length}`;
    }

    query += ` ORDER BY ls.user_id, ls.submitted_at DESC`;

    const leaderboardRes = await pool.query(query, params);

    const allSorted = leaderboardRes.rows
      .filter((r) => r.total_score !== null && r.total_score !== undefined)
      .sort((a, b) => (Number(b.total_score) || 0) - (Number(a.total_score) || 0));

    const sorted = allSorted.slice(0, limit).map((row, idx) => ({
      rank: idx + 1,
      user_id: row.user_id,
      name: row.name,
      score: Math.round(Number(row.total_score) || 0),
      submitted_at: row.submitted_at,
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

    res.json({
      success: true,
      data: {
        subject_info: subjectInfo,
        education_level: subjectInfo?.education_level || null,
        title: subjectInfo?.full_name || subjectInfo?.name || 'Latihan TKA',
        leaderboard: sorted,
        user_rank: userRank,
        total_participants: allSorted.length,
      },
    });
  } catch (error) {
    console.error("TKA Latihan Leaderboard error:", error);
    next(error);
  }
});

module.exports = router;

