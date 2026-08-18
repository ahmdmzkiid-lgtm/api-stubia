const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { voucherLimiter } = require('../middleware/rateLimiter');
const { logAdminActivity } = require('../utils/activityLogger');

// ─── POST /validate ─── Student endpoint to check coupon validity
router.post('/validate', verifyToken, voucherLimiter, async (req, res, next) => {
  try {
    const { code, planIds } = req.body;
    if (!code || !planIds || !Array.isArray(planIds) || planIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Code and planIds are required.' });
    }

    const cleanedCode = code.trim().toUpperCase();

    // 1. Fetch voucher from vouchers table
    const voucherRes = await pool.query(
      `SELECT * FROM vouchers WHERE UPPER(code) = $1 AND is_active = true`,
      [cleanedCode]
    );

    if (voucherRes.rows.length === 0) {
      // Check if it's a valid Mitra Referral Code
      const mitraRes = await pool.query(
        `SELECT id, name, referral_code, status FROM mitra_users WHERE UPPER(referral_code) = $1`,
        [cleanedCode]
      );

      if (mitraRes.rows.length > 0) {
        const mitra = mitraRes.rows[0];
        if (mitra.status !== 'active') {
          return res.status(400).json({
            success: false,
            error: 'Kode referral mitra belum aktif atau sedang dalam peninjauan.',
          });
        }

        // Calculate Cart Price
        const plansRes = await pool.query(
          `SELECT price FROM plans WHERE id = ANY($1)`,
          [planIds]
        );
        if (plansRes.rows.length === 0) {
          return res.status(400).json({ success: false, error: 'Paket tidak ditemukan.' });
        }

        const totalOriginal = plansRes.rows.reduce((sum, row) => sum + row.price, 0);

        // Fetch discount % from mitra_settings (default 10%)
        let discountPercent = 10;
        try {
          const settingRes = await pool.query(
            `SELECT value FROM mitra_settings WHERE key = 'buyer_discount_percent'`
          );
          if (settingRes.rows.length > 0) {
            discountPercent = parseInt(settingRes.rows[0].value, 10) || 10;
          }
        } catch (e) {}

        const discount = Math.floor((totalOriginal * discountPercent) / 100);
        const finalTotal = Math.max(0, totalOriginal - discount);

        return res.json({
          success: true,
          data: {
            voucherId: null,
            isReferral: true,
            referralCode: mitra.referral_code,
            code: mitra.referral_code,
            discountType: 'percentage',
            discountValue: discountPercent,
            discount,
            totalOriginal,
            finalTotal,
            message: `Diskon referral mitra (${mitra.name}) sebesar ${discountPercent}% berhasil diterapkan!`,
          },
        });
      }

      return res.status(404).json({ success: false, error: 'Kode voucher atau referral tidak valid.' });
    }

    const voucher = voucherRes.rows[0];

    // 2. Check Expiry
    if (new Date(voucher.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Voucher telah kedaluwarsa.' });
    }

    // 3. Check Usage Limit (Global)
    if (voucher.usage_limit !== null && voucher.usage_count >= voucher.usage_limit) {
      return res.status(400).json({ success: false, error: 'Voucher telah mencapai batas kuota penggunaan.' });
    }

    // 4. Check if user already used it
    const userUsedRes = await pool.query(
      `SELECT 1 FROM user_vouchers WHERE user_id = $1 AND voucher_id = $2`,
      [req.user.id, voucher.id]
    );
    if (userUsedRes.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Anda sudah pernah menggunakan voucher ini.' });
    }

    // 5. Calculate Cart Price
    const plansRes = await pool.query(
      `SELECT price FROM plans WHERE id = ANY($1)`,
      [planIds]
    );
    
    if (plansRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Paket tidak ditemukan.' });
    }

    const totalOriginal = plansRes.rows.reduce((sum, row) => sum + row.price, 0);

    // 6. Check Min Purchase
    if (totalOriginal < voucher.min_purchase) {
      return res.status(400).json({ 
        success: false, 
        error: `Minimum transaksi untuk voucher ini adalah Rp${voucher.min_purchase.toLocaleString('id-ID')}.` 
      });
    }

    // 7. Calculate Discount
    let discount = 0;
    if (voucher.discount_type === 'percentage') {
      discount = Math.floor((totalOriginal * voucher.discount_value) / 100);
      if (voucher.max_discount !== null && discount > voucher.max_discount) {
        discount = voucher.max_discount;
      }
    } else if (voucher.discount_type === 'fixed') {
      discount = voucher.discount_value;
    }

    // Cap discount to total price
    discount = Math.min(discount, totalOriginal);
    const finalTotal = totalOriginal - discount;

    res.json({
      success: true,
      data: {
        voucherId: voucher.id,
        code: voucher.code,
        discountType: voucher.discount_type,
        discountValue: voucher.discount_value,
        discount,
        totalOriginal,
        finalTotal
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── ADMIN ENDPOINTS ───

// GET / ─── List all vouchers
router.get('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST / ─── Create a new voucher
router.post('/', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { code, discount_type, discount_value, min_purchase, max_discount, expires_at, usage_limit } = req.body;

    if (!code || !discount_type || discount_value === undefined || !expires_at) {
      return res.status(400).json({ success: false, error: 'Code, discount_type, discount_value, and expires_at are required.' });
    }

    const cleanedCode = code.trim().toUpperCase();

    // Check duplicate code
    const checkDup = await pool.query('SELECT 1 FROM vouchers WHERE UPPER(code) = $1', [cleanedCode]);
    if (checkDup.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Kode voucher sudah terdaftar.' });
    }

    const result = await pool.query(
      `INSERT INTO vouchers 
       (code, discount_type, discount_value, min_purchase, max_discount, expires_at, usage_limit, usage_count, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, true)
       RETURNING *`,
      [
        cleanedCode,
        discount_type,
        parseInt(discount_value, 10),
        parseInt(min_purchase, 10) || 0,
        max_discount ? parseInt(max_discount, 10) : null,
        new Date(expires_at),
        usage_limit ? parseInt(usage_limit, 10) : null
      ]
    );

    logAdminActivity(req, 'CREATE', 'SETTINGS', cleanedCode, `Membuat voucher diskon baru: "${cleanedCode}" dengan diskon ${discount_value} (${discount_type})`);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Voucher berhasil dibuat.' });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id ─── Delete a voucher
router.delete('/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM vouchers WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Voucher tidak ditemukan.' });
    }
    logAdminActivity(req, 'DELETE', 'SETTINGS', result.rows[0].code || `ID: ${id}`, `Menghapus voucher diskon: "${result.rows[0].code}"`);
    res.json({ success: true, message: 'Voucher berhasil dihapus.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
