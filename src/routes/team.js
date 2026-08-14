const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/team - Public: list all team members
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, role, photo_url, bio, instagram_url, linkedin_url FROM team_members ORDER BY display_order ASC, created_at ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
