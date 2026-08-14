const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');

// ── FELLOWSHIP BUDDIES & ALUMNI CRUD ──

// GET /api/fellowship/buddies - Public: Get all buddies/alumni
router.get('/buddies', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM fellowship_buddies ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/fellowship/buddies - Admin only: Add a new buddy
router.post('/buddies', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { name, photo_url, position, message } = req.body;
    if (!name || !photo_url || !position || !message) {
      return res.status(400).json({ success: false, error: 'Nama, foto, posisi, dan pesan wajib diisi' });
    }
    const result = await pool.query(
      `INSERT INTO fellowship_buddies (name, photo_url, position, message, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [name, photo_url, position, message]
    );
    logAdminActivity(req, 'CREATE', 'FELLOWSHIP_BUDDY', name, `Menambahkan buddy fellowship "${name}" (${position})`);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/fellowship/buddies/:id - Admin only: Update buddy details
router.put('/buddies/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, photo_url, position, message } = req.body;

    const buddyCheck = await pool.query('SELECT * FROM fellowship_buddies WHERE id = $1', [id]);
    if (buddyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Buddy fellowship tidak ditemukan' });
    }
    const oldBuddy = buddyCheck.rows[0];

    const updatedName = name !== undefined ? name : oldBuddy.name;
    const updatedPhoto = photo_url !== undefined ? photo_url : oldBuddy.photo_url;
    const updatedPos = position !== undefined ? position : oldBuddy.position;
    const updatedMsg = message !== undefined ? message : oldBuddy.message;

    const result = await pool.query(
      `UPDATE fellowship_buddies
       SET name = $1, photo_url = $2, position = $3, message = $4
       WHERE id = $5 RETURNING *`,
      [updatedName, updatedPhoto, updatedPos, updatedMsg, id]
    );
    logAdminActivity(req, 'UPDATE', 'FELLOWSHIP_BUDDY', updatedName, `Mengubah buddy fellowship ID: ${id}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/fellowship/buddies/:id - Admin only: Delete buddy
router.delete('/buddies/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM fellowship_buddies WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Buddy fellowship tidak ditemukan' });
    }
    logAdminActivity(req, 'DELETE', 'FELLOWSHIP_BUDDY', result.rows[0].name, `Menghapus buddy fellowship "${result.rows[0].name}"`);
    res.json({ success: true, message: 'Buddy fellowship berhasil dihapus', data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
