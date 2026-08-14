const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');

// --- Subject Routes ---

// List all subjects
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM subjects ORDER BY name ASC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// Create subject
router.post('/', [verifyToken, verifyAdmin], async (req, res, next) => {
  const { title, description, icon, bgColor, iconColor, requiredPlan, is_active } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO subjects (name, title, description, icon, bg_color, icon_color, category, required_plan, is_active) VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [title, description, icon, bgColor, iconColor, 'TPS', requiredPlan || 'gratis', is_active ?? true]
    );
    logAdminActivity(req, 'CREATE', 'PAKET_LATIHAN', title, `Membuat mata pelajaran (Subject) baru: "${title}"`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Update subject
router.patch('/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { title, description, icon, bgColor, iconColor, requiredPlan, is_active } = req.body;
  try {
    const result = await pool.query(
      'UPDATE subjects SET title = $1, name = $1, description = $2, icon = $3, bg_color = $4, icon_color = $5, required_plan = $6, is_active = COALESCE($7, is_active) WHERE id = $8 RETURNING *',
      [title, description, icon, bgColor, iconColor, requiredPlan || 'gratis', is_active, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    logAdminActivity(req, 'UPDATE', 'PAKET_LATIHAN', title || `ID: ${id}`, `Mengubah mata pelajaran (Subject): "${title}"`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Delete subject
router.delete('/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete bookmarks referencing questions in this subject
    await client.query(
      `DELETE FROM bookmarks WHERE question_id IN (SELECT id FROM questions WHERE subject_id = $1)`,
      [id]
    );

    // 2. Delete user_answers referencing questions in this subject
    await client.query(
      `DELETE FROM user_answers WHERE question_id IN (SELECT id FROM questions WHERE subject_id = $1)`,
      [id]
    );

    // 3. Delete user_answers referencing choices of questions in this subject
    await client.query(
      `DELETE FROM user_answers WHERE chosen_choice_id IN (
        SELECT ac.id FROM answer_choices ac
        JOIN questions q ON ac.question_id = q.id
        WHERE q.subject_id = $1
      )`,
      [id]
    );

    // 4. Delete answer choices for questions in this subject
    await client.query(
      `DELETE FROM answer_choices WHERE question_id IN (SELECT id FROM questions WHERE subject_id = $1)`,
      [id]
    );

    // 5. Delete questions under this subject
    await client.query(
      `DELETE FROM questions WHERE subject_id = $1`,
      [id]
    );

    // 6. Delete the subject itself
    const result = await client.query('DELETE FROM subjects WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subject not found' });
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'DELETE', 'PAKET_LATIHAN', result.rows[0].title || `ID: ${id}`, `Menghapus mata pelajaran (Subject) dan semua soal di dalamnya: "${result.rows[0].title}"`);
    res.json({ success: true, message: 'Subject and its questions deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// --- Topic Routes ---

// List topics for a subject
router.get('/:subjectId/topics', verifyToken, async (req, res, next) => {
  const { subjectId } = req.params;
  const userId = req.user.id;
  try {
    const query = `
      SELECT 
        t.*,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', ls.id,
              'correct_count', ls.correct_count,
              'total_questions', ls.total_questions,
              'irt_score', ls.irt_score,
              'submitted_at', ls.submitted_at,
              'percentage', CASE WHEN ls.total_questions > 0 THEN ROUND((ls.correct_count::float / ls.total_questions) * 100) ELSE 0 END
            ) ORDER BY ls.submitted_at DESC)
            FROM latihan_sessions ls
            WHERE ls.topic_id = t.id AND ls.user_id = $2
          ),
          '[]'::json
        ) as history
      FROM topics t
      WHERE t.subject_id = $1
      ORDER BY t.created_at ASC
    `;
    const result = await pool.query(query, [subjectId, userId]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// Create topic
router.post('/:subjectId/topics', [verifyToken, verifyAdmin], async (req, res, next) => {
  const { subjectId } = req.params;
  const { title, description, icon, questions, level, type, isPopular, isFeatured } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO topics 
      (subject_id, title, description, icon, questions_count, difficulty_level, card_type, is_popular, is_featured) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [subjectId, title, description, icon, questions, level, type, isPopular, isFeatured]
    );
    logAdminActivity(req, 'CREATE', 'PAKET_LATIHAN', title, `Membuat topik latihan baru: "${title}" untuk Subject ID: ${subjectId}`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Update topic (mounted at /api/subjects/topics/:topicId in frontend but here we use a dedicated route if needed)
// Wait, my frontend uses: updateTopic: (topicId, data) => api.patch(`/topics/${topicId}`, data)
// So I should mount topics separately or handle it here.
// I'll add a catch-all for topics here for simplicity if needed, but better to mount it properly.

module.exports = router;
