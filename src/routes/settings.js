const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Sensitive keys that should not be exposed publicly
const SENSITIVE_KEYS = ['admin_pin'];

// GET /api/settings - Public: get all site settings (excluding sensitive keys)
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const settings = {};
    result.rows.forEach(row => {
      if (!SENSITIVE_KEYS.includes(row.key)) {
        settings[row.key] = row.value;
      }
    });
    res.json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
});

// GET /api/settings/admin - Admin only: get ALL settings including sensitive keys
router.get('/admin', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/verify-pin - Admin only: verify CMS admin PIN
router.post('/verify-pin', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({ success: false, error: 'PIN is required' });
    }
    const result = await pool.query("SELECT value FROM site_settings WHERE key = 'admin_pin'");
    const correctPin = result.rows.length > 0 ? result.rows[0].value : '1234';
    if (pin.trim() === correctPin.trim()) {
      res.json({ success: true, verified: true });
    } else {
      res.status(403).json({ success: false, verified: false, error: 'PIN Admin salah' });
    }
  } catch (error) {
    next(error);
  }
});

// PATCH /api/settings - Admin only: update one or more settings
router.patch('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const updates = req.body; // { key: value, ... }
    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No settings provided' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of Object.entries(updates)) {
        await client.query(
          `INSERT INTO site_settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, value]
        );
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
