const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');

// Update topic
router.patch('/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const { title, description, icon, questions, level, type, isPopular, isFeatured } = req.body;
  try {
    const result = await pool.query(
      `UPDATE topics SET 
      title = $1, description = $2, icon = $3, questions_count = $4, 
      difficulty_level = $5, card_type = $6, is_popular = $7, is_featured = $8 
      WHERE id = $9 RETURNING *`,
      [title, description, icon, questions, level, type, isPopular, isFeatured, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Topic not found' });
    logAdminActivity(req, 'UPDATE', 'PAKET_LATIHAN', title || `ID: ${id}`, `Mengubah topik latihan: "${title}"`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Delete topic
router.delete('/:id', [verifyToken, verifyAdmin], async (req, res, next) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete bookmarks referencing these questions
    await client.query(
      `DELETE FROM bookmarks WHERE question_id IN (SELECT id FROM questions WHERE topic_id = $1)`,
      [id]
    );

    // 2. Delete user_answers referencing these questions
    await client.query(
      `DELETE FROM user_answers WHERE question_id IN (SELECT id FROM questions WHERE topic_id = $1)`,
      [id]
    );

    // 3. Delete questions (this will cascade delete answer_choices)
    await client.query(
      `DELETE FROM questions WHERE topic_id = $1`,
      [id]
    );

    // 4. Delete the topic itself
    const result = await client.query('DELETE FROM topics WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Topic not found' });
    }

    await client.query('COMMIT');
    logAdminActivity(req, 'DELETE', 'PAKET_LATIHAN', result.rows[0].title || `ID: ${id}`, `Menghapus topik latihan dan seluruh soal di dalamnya: "${result.rows[0].title}"`);
    res.json({ success: true, message: 'Topic and its questions deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
