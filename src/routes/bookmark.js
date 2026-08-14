const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// List Bookmarks
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT b.id as bookmark_id, q.* 
      FROM bookmarks b
      JOIN questions q ON b.question_id = q.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `, [req.user.id]);
    
    // Fetch choices for these questions
    if (result.rows.length > 0) {
      const questionIds = result.rows.map(q => q.id);
      const placeholders = questionIds.map((_, i) => `$${i + 1}`).join(',');
      
      const choicesResult = await pool.query(
        `SELECT * FROM answer_choices WHERE question_id IN (${placeholders}) ORDER BY label ASC`,
        questionIds
      );
      
      for (const question of result.rows) {
        question.choices = choicesResult.rows.filter(c => c.question_id === question.id);
      }
    }
    
    res.json({ success: true, data: result.rows, message: 'Bookmarks retrieved' });
  } catch (error) {
    next(error);
  }
});

// Toggle Bookmark
router.post('/:question_id', verifyToken, async (req, res, next) => {
  try {
    const { question_id } = req.params;
    
    // Check if exists
    const check = await pool.query('SELECT id FROM bookmarks WHERE user_id = $1 AND question_id = $2', [req.user.id, question_id]);
    
    if (check.rows.length > 0) {
      // Remove
      await pool.query('DELETE FROM bookmarks WHERE id = $1', [check.rows[0].id]);
      res.json({ success: true, data: { is_bookmarked: false }, message: 'Bookmark removed' });
    } else {
      // Add
      await pool.query('INSERT INTO bookmarks (user_id, question_id) VALUES ($1, $2)', [req.user.id, question_id]);
      res.json({ success: true, data: { is_bookmarked: true }, message: 'Bookmark added' });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
