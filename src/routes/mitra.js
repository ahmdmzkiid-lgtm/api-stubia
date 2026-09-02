const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { pool } = require('../config/db');
const { getJwtSecret } = require('../config/jwt');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../utils/activityLogger');
const { authLimiter } = require('../middleware/rateLimiter');
const cloudinary = require('../config/cloudinary');

// ─── MULTER CONFIG FOR IN-MEMORY FILE UPLOADS ───
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowedMimetypes = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedMimetypes.includes(file.mimetype) || !allowedExtensions.includes(ext)) {
      return cb(new Error('Hanya format JPG, JPEG, PNG, dan WEBP yang diizinkan.'), false);
    }
    cb(null, true);
  },
});

// Helper to upload buffer to Cloudinary
const uploadBufferToCloudinary = (buffer, folder = 'mitra') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `stubia/${folder}`,
        resource_type: 'image',
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
};

// ─── MITRA AUTHENTICATION MIDDLEWARE ───
const verifyMitraToken = async (req, res, next) => {
  try {
    let token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Akses ditolak. Token tidak ditemukan.' });
    }

    token = token.split(' ')[1];
    const decoded = jwt.verify(token, getJwtSecret());

    const mitraId = decoded.mitra_id || decoded.id;
    if (!mitraId) {
      return res.status(401).json({ success: false, error: 'Sesi token tidak valid.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, ktp_number, ktp_image_url, address, email, whatsapp,
              bank_name, bank_account, bank_holder, referral_code, balance,
              total_withdrawn, status, rejection_reason, created_at
       FROM mitra_users WHERE id = $1`,
      [mitraId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Akun mitra tidak ditemukan.' });
    }

    const mitra = rows[0];
    if (mitra.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Akun Mitra Anda sedang ditangguhkan (suspended). Silakan hubungi admin / CS Stubia.',
      });
    }

    req.mitra = mitra;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Token kedaluwarsa atau tidak valid.' });
  }
};

// Helper: Mask sensitive string for privacy
function maskName(name) {
  if (!name) return 'Siswa';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    const single = parts[0];
    if (single.length <= 2) return single + '***';
    return single.slice(0, 2) + '*'.repeat(Math.max(1, single.length - 2));
  }
  return parts.map((p, idx) => {
    if (idx === 0) {
      return p.length <= 2 ? p : p.slice(0, 2) + '*'.repeat(Math.max(1, p.length - 2));
    }
    return p.charAt(0) + '.';
  }).join(' ');
}

function maskOrderId(orderId) {
  if (!orderId) return '-';
  if (orderId.length <= 8) return orderId;
  return orderId.slice(0, 7) + '...' + orderId.slice(-4);
}

// =========================================================================
// PUBLIC & MITRA AUTH ROUTES
// =========================================================================

// POST /api/mitra/auth/register - Register new mitra
router.post('/auth/register', authLimiter, (req, res, next) => {
  upload.single('ktp_image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Ukuran file foto KTP maksimal 5MB.' });
      }
      return res.status(400).json({ success: false, error: err.message });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      name,
      ktp_number,
      address,
      email,
      whatsapp,
      bank_name,
      bank_account,
      bank_holder,
      password,
      custom_referral_code,
    } = req.body;

    // Validations
    if (!name || !ktp_number || !address || !email || !whatsapp || !bank_name || !bank_account || !bank_holder || !password) {
      return res.status(400).json({ success: false, error: 'Semua field bertanda bintang wajib diisi.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Format email tidak valid.' });
    }

    const cleanKtp = ktp_number.trim().replace(/\D/g, '');
    if (cleanKtp.length !== 16) {
      return res.status(400).json({ success: false, error: 'Nomor NIK KTP harus terdiri dari 16 digit angka.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password minimal 8 karakter.' });
    }

    // Check email uniqueness
    const existingEmail = await client.query(
      'SELECT id FROM mitra_users WHERE LOWER(email) = $1',
      [cleanEmail]
    );
    if (existingEmail.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Email sudah terdaftar sebagai Mitra.' });
    }

    // Determine referral code
    let referralCode = '';
    if (custom_referral_code && custom_referral_code.trim()) {
      const sanitized = custom_referral_code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (sanitized.length < 3 || sanitized.length > 30) {
        return res.status(400).json({ success: false, error: 'Kustomisasi kode referral harus 3-30 karakter alfanumerik.' });
      }

      // Check uniqueness in mitra_users and vouchers
      const duplicateRef = await client.query(
        'SELECT id FROM mitra_users WHERE UPPER(referral_code) = $1',
        [sanitized]
      );
      if (duplicateRef.rows.length > 0) {
        return res.status(400).json({ success: false, error: 'Kode referral sudah digunakan oleh mitra lain. Silakan pilih kode lain.' });
      }
      referralCode = sanitized;
    } else {
      // Auto-generate referral code
      const namePart = name.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'MITRA';
      let unique = false;
      let attempts = 0;
      while (!unique && attempts < 10) {
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const candidate = `${namePart}${randomNum}`;
        const check = await client.query(
          'SELECT id FROM mitra_users WHERE referral_code = $1',
          [candidate]
        );
        if (check.rows.length === 0) {
          referralCode = candidate;
          unique = true;
        }
        attempts++;
      }
      if (!unique) {
        referralCode = `STB${Date.now().toString().slice(-6)}`;
      }
    }

    // Handle KTP image upload to Cloudinary if provided
    let ktpImageUrl = null;
    if (req.file) {
      try {
        const uploadRes = await uploadBufferToCloudinary(req.file.buffer, 'mitra_ktp');
        ktpImageUrl = uploadRes.secure_url;
      } catch (uploadErr) {
        console.error('KTP Cloudinary upload error:', uploadErr);
      }
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO mitra_users (
        name, ktp_number, ktp_image_url, address, email, whatsapp,
        bank_name, bank_account, bank_holder, password_hash, referral_code,
        balance, total_withdrawn, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 'pending')
      RETURNING id, name, email, whatsapp, address, ktp_number, ktp_image_url, bank_name, bank_account, bank_holder, referral_code, balance, total_withdrawn, status, created_at`,
      [
        name.trim(),
        cleanKtp,
        ktpImageUrl,
        address.trim(),
        cleanEmail,
        whatsapp.trim(),
        bank_name.trim(),
        bank_account.trim(),
        bank_holder.trim(),
        passwordHash,
        referralCode,
      ]
    );
    const newUser = insertRes.rows[0];

    // Initialize progress for all active missions
    const activeMissions = await client.query(
      'SELECT id FROM mitra_missions WHERE is_active = TRUE'
    );
    for (const mission of activeMissions.rows) {
      await client.query(
        `INSERT INTO mitra_mission_progress (mitra_id, mission_id, current_progress, is_completed, is_claimed)
         VALUES ($1, $2, 0, FALSE, FALSE)
         ON CONFLICT (mitra_id, mission_id) DO NOTHING`,
        [newUser.id, mission.id]
      );
    }

    await client.query('COMMIT');

    // Generate JWT token
    const token = jwt.sign(
      { id: newUser.id, mitra_id: newUser.id, email: newUser.email, type: 'mitra' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Pendaftaran mitra berhasil! Akun Anda sedang dalam status verifikasi/peninjauan.',
      data: {
        user: newUser,
        token,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// POST /api/mitra/auth/login - Login mitra
router.post('/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email dan password wajib diisi.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const { rows } = await pool.query(
      `SELECT * FROM mitra_users WHERE LOWER(email) = $1`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Email atau password salah.' });
    }

    const mitra = rows[0];

    const isMatch = await bcrypt.compare(password, mitra.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Email atau password salah.' });
    }

    if (mitra.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Akun Anda sedang ditangguhkan (suspended). Silakan hubungi CS / Admin Stubia.',
      });
    }

    const token = jwt.sign(
      { id: mitra.id, mitra_id: mitra.id, email: mitra.email, type: 'mitra' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    const safeUser = {
      id: mitra.id,
      name: mitra.name,
      email: mitra.email,
      whatsapp: mitra.whatsapp,
      address: mitra.address,
      ktp_number: mitra.ktp_number,
      ktp_image_url: mitra.ktp_image_url,
      bank_name: mitra.bank_name,
      bank_account: mitra.bank_account,
      bank_holder: mitra.bank_holder,
      referral_code: mitra.referral_code,
      balance: mitra.balance,
      total_withdrawn: mitra.total_withdrawn,
      status: mitra.status,
      rejection_reason: mitra.rejection_reason,
      created_at: mitra.created_at,
    };

    res.json({
      success: true,
      data: {
        user: safeUser,
        token,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/auth/me - Get current mitra profile
router.get('/auth/me', verifyMitraToken, (req, res) => {
  res.json({
    success: true,
    data: req.mitra,
  });
});

// PUT /api/mitra/auth/profile - Update mitra profile
router.put('/auth/profile', verifyMitraToken, async (req, res, next) => {
  try {
    const { name, whatsapp, address, bank_name, bank_account, bank_holder } = req.body;

    if (!name || !whatsapp || !bank_name || !bank_account || !bank_holder) {
      return res.status(400).json({ success: false, error: 'Field wajib tidak boleh kosong.' });
    }

    const { rows } = await pool.query(
      `UPDATE mitra_users
       SET name = $1, whatsapp = $2, address = $3, bank_name = $4, bank_account = $5, bank_holder = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING id, name, email, whatsapp, address, ktp_number, ktp_image_url, bank_name, bank_account, bank_holder, referral_code, balance, total_withdrawn, status, rejection_reason, created_at`,
      [
        name.trim(),
        whatsapp.trim(),
        address ? address.trim() : '',
        bank_name.trim(),
        bank_account.trim(),
        bank_holder.trim(),
        req.mitra.id,
      ]
    );

    res.json({
      success: true,
      message: 'Profil berhasil diperbarui.',
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/auth/change-password - Change password
router.post('/auth/change-password', verifyMitraToken, authLimiter, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'Password lama dan baru wajib diisi.' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password baru minimal 8 karakter.' });
    }

    const userRes = await pool.query('SELECT password_hash FROM mitra_users WHERE id = $1', [req.mitra.id]);
    const currentHash = userRes.rows[0]?.password_hash;

    const isMatch = await bcrypt.compare(current_password, currentHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Password saat ini salah.' });
    }

    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(new_password, salt);

    await pool.query(
      'UPDATE mitra_users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.mitra.id]
    );

    res.json({ success: true, message: 'Password berhasil diubah.' });
  } catch (error) {
    next(error);
  }
});

// =========================================================================
// MITRA DASHBOARD & TRANSACTIONS
// =========================================================================

// GET /api/mitra/dashboard/stats - Dashboard analytics
router.get('/dashboard/stats', verifyMitraToken, async (req, res, next) => {
  try {
    const mitraId = req.mitra.id;

    // 1. Total clicks
    const clicksRes = await pool.query(
      'SELECT COUNT(*) FROM mitra_clicks WHERE mitra_id = $1',
      [mitraId]
    );
    const totalClicks = parseInt(clicksRes.rows[0]?.count || '0', 10);

    // 2. Successful transactions & commission
    const txStatsRes = await pool.query(
      `SELECT 
         COUNT(*) as success_count,
         COALESCE(SUM(commission_amount), 0) as total_commission
       FROM mitra_transactions
       WHERE mitra_id = $1 AND status = 'settled'`,
      [mitraId]
    );
    const successfulTransactions = parseInt(txStatsRes.rows[0]?.success_count || '0', 10);
    const totalCommissionEarned = parseInt(txStatsRes.rows[0]?.total_commission || '0', 10);

    // 3. Recent 5 transactions
    const recentTxRes = await pool.query(
      `SELECT id, order_id, product_name, total_price, commission_amount, status, created_at
       FROM mitra_transactions
       WHERE mitra_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [mitraId]
    );

    // 4. Announcements
    const annRes = await pool.query(
      `SELECT id, title, message, type, badge_text, action_url
       FROM mitra_announcements
       WHERE is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 3`
    );

    res.json({
      success: true,
      data: {
        metrics: {
          totalClicks,
          successfulTransactions,
          totalCommissionEarned,
          availableBalance: req.mitra.balance || 0,
        },
        recentTransactions: recentTxRes.rows,
        announcements: annRes.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/transactions - Transaction list with pagination
router.get('/transactions', verifyMitraToken, async (req, res, next) => {
  try {
    const mitraId = req.mitra.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let countQuery = 'SELECT COUNT(*) FROM mitra_transactions WHERE mitra_id = $1';
    let dataQuery = `
      SELECT id, order_id, buyer_name, product_name, total_price, discount_amount, commission_amount, status, created_at
      FROM mitra_transactions
      WHERE mitra_id = $1
    `;
    const params = [mitraId];

    if (status) {
      params.push(status);
      countQuery += ` AND status = $${params.length}`;
      dataQuery += ` AND status = $${params.length}`;
    }

    const countRes = await pool.query(countQuery, params);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    dataQuery += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const dataParams = [...params, limit, offset];
    const dataRes = await pool.query(dataQuery, dataParams);

    const maskedRows = dataRes.rows.map((row) => ({
      ...row,
      order_id_masked: maskOrderId(row.order_id),
      buyer_name_masked: maskName(row.buyer_name),
    }));

    res.json({
      success: true,
      data: maskedRows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// =========================================================================
// MITRA WITHDRAWALS
// =========================================================================

// GET /api/mitra/withdrawals - Mitra withdrawal history
router.get('/withdrawals', verifyMitraToken, async (req, res, next) => {
  try {
    const mitraId = req.mitra.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;

    const countRes = await pool.query(
      'SELECT COUNT(*) FROM mitra_withdrawals WHERE mitra_id = $1',
      [mitraId]
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const { rows } = await pool.query(
      `SELECT id, amount, bank_name, bank_account, bank_holder, status, admin_notes, transfer_proof_url, created_at, processed_at
       FROM mitra_withdrawals
       WHERE mitra_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [mitraId, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/withdrawals - Request withdrawal
router.post('/withdrawals', verifyMitraToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const mitraId = req.mitra.id;

    if (req.mitra.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Akun Anda belum aktif (masih pending atau ditolak). Penarikan dana hanya dapat dilakukan oleh mitra dengan status aktif.',
      });
    }

    const { amount } = req.body;
    const parsedAmount = parseInt(amount, 10);

    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Nominal penarikan tidak valid.' });
    }

    // Get min withdrawal setting
    const minSetting = await client.query(
      "SELECT value FROM mitra_settings WHERE key = 'min_withdrawal'"
    );
    const minWithdrawal = parseInt(minSetting.rows[0]?.value || '50000', 10);

    if (parsedAmount < minWithdrawal) {
      return res.status(400).json({
        success: false,
        error: `Batas minimum penarikan adalah Rp ${minWithdrawal.toLocaleString('id-ID')}.`,
      });
    }

    await client.query('BEGIN');

    // Lock user row and atomic balance check
    const userLock = await client.query(
      `SELECT balance, bank_name, bank_account, bank_holder, status
       FROM mitra_users WHERE id = $1 FOR UPDATE`,
      [mitraId]
    );

    const currentUser = userLock.rows[0];
    if (!currentUser || currentUser.balance < parsedAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Saldo tidak mencukupi untuk melakukan penarikan.' });
    }

    if (currentUser.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Status akun tidak aktif.' });
    }

    // Deduct balance atomically
    const updateRes = await client.query(
      `UPDATE mitra_users
       SET balance = balance - $1, updated_at = NOW()
       WHERE id = $2 AND balance >= $1
       RETURNING balance`,
      [parsedAmount, mitraId]
    );

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Gagal memproses penarikan saldo. Saldo tidak mencukupi.' });
    }

    const newBalance = updateRes.rows[0].balance;

    // Create withdrawal request
    const insertRes = await client.query(
      `INSERT INTO mitra_withdrawals (
         mitra_id, amount, bank_name, bank_account, bank_holder, status
       ) VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [
        mitraId,
        parsedAmount,
        currentUser.bank_name,
        currentUser.bank_account,
        currentUser.bank_holder,
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Pengajuan penarikan dana berhasil dikirim! Admin akan memproses dalam 1x24 jam kerja.',
      data: {
        newBalance,
        withdrawal: insertRes.rows[0],
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// =========================================================================
// MITRA MARKETING KITS & MISSIONS
// =========================================================================

// GET /api/mitra/marketing-kits - List active marketing kits with personalized copy
router.get('/marketing-kits', verifyMitraToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, type, file_url, preview_url, description, copy_text, display_order
       FROM mitra_marketing_kits
       WHERE is_active = TRUE
       ORDER BY display_order ASC`
    );

    const refCode = req.mitra.referral_code;
    const refLink = `https://stubia.id/?ref=${refCode}`;

    const personalized = rows.map((k) => ({
      ...k,
      copy_text_personalized: k.copy_text
        ? k.copy_text
            .replace(/\{REFERRAL_CODE\}/g, refCode)
            .replace(/\{REFERRAL_LINK\}/g, refLink)
        : '',
    }));

    res.json({ success: true, data: personalized });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/missions - List missions with real-time sync
router.get('/missions', verifyMitraToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const mitraId = req.mitra.id;

    // Get active missions
    const missionsRes = await client.query(
      `SELECT id, name, description, target_type, target_value, reward_amount, reward_type, category
       FROM mitra_missions
       WHERE is_active = TRUE
       ORDER BY created_at ASC`
    );

    // Compute live stats for this mitra
    const txStatsRes = await client.query(
      `SELECT 
         COUNT(*) as tx_count,
         COALESCE(SUM(total_price), 0) as total_revenue
       FROM mitra_transactions
       WHERE mitra_id = $1 AND status = 'settled'`,
      [mitraId]
    );

    const txCount = parseInt(txStatsRes.rows[0]?.tx_count || '0', 10);
    const totalRevenue = parseInt(txStatsRes.rows[0]?.total_revenue || '0', 10);

    // Fetch progress rows
    const progressRes = await client.query(
      'SELECT mission_id, current_progress, is_completed, is_claimed FROM mitra_mission_progress WHERE mitra_id = $1',
      [mitraId]
    );
    const progressMap = new Map(progressRes.rows.map((r) => [r.mission_id, r]));

    const result = [];
    for (const m of missionsRes.rows) {
      const liveProgress = m.target_type === 'transaction_count' ? txCount : totalRevenue;
      const isCompleted = liveProgress >= m.target_value;

      const existingProg = progressMap.get(m.id);
      let isClaimed = false;

      if (existingProg) {
        isClaimed = existingProg.is_claimed;
        if (existingProg.current_progress !== liveProgress || existingProg.is_completed !== isCompleted) {
          await client.query(
            `UPDATE mitra_mission_progress
             SET current_progress = $1, is_completed = $2, updated_at = NOW()
             WHERE mitra_id = $3 AND mission_id = $4`,
            [liveProgress, isCompleted, mitraId, m.id]
          );
        }
      } else {
        await client.query(
          `INSERT INTO mitra_mission_progress (mitra_id, mission_id, current_progress, is_completed, is_claimed)
           VALUES ($1, $2, $3, $4, FALSE)
           ON CONFLICT (mitra_id, mission_id) DO UPDATE
           SET current_progress = $3, is_completed = $4, updated_at = NOW()`,
          [mitraId, m.id, liveProgress, isCompleted]
        );
      }

      result.push({
        ...m,
        current_progress: liveProgress,
        is_completed: isCompleted,
        is_claimed: isClaimed,
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

// POST /api/mitra/missions/:id/claim - Claim completed mission reward
router.post('/missions/:id/claim', verifyMitraToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const mitraId = req.mitra.id;
    const missionId = req.params.id;

    if (req.mitra.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Akun Anda belum aktif. Reward misi hanya dapat diklaim oleh akun aktif.',
      });
    }

    await client.query('BEGIN');

    // Get mission info
    const missionRes = await client.query(
      'SELECT * FROM mitra_missions WHERE id = $1 AND is_active = TRUE',
      [missionId]
    );
    if (missionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Misi tidak ditemukan atau sudah tidak aktif.' });
    }
    const mission = missionRes.rows[0];

    // Atomically claim if completed and unclaimed
    const claimRes = await client.query(
      `UPDATE mitra_mission_progress
       SET is_claimed = TRUE, claimed_at = NOW(), updated_at = NOW()
       WHERE mitra_id = $1 AND mission_id = $2 AND is_completed = TRUE AND is_claimed = FALSE
       RETURNING *`,
      [mitraId, missionId]
    );

    if (claimRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Reward misi belum dapat diklaim (target belum tercapai atau reward sudah pernah diklaim sebelumnya).',
      });
    }

    // Add reward to balance
    const userUpdate = await client.query(
      `UPDATE mitra_users
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2
       RETURNING balance`,
      [mission.reward_amount, mitraId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Selamat! Reward misi sebesar Rp ${mission.reward_amount.toLocaleString('id-ID')} berhasil ditambahkan ke saldo Anda.`,
      data: {
        new_balance: userUpdate.rows[0].balance,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// =========================================================================
// PUBLIC CLICK TRACKING
// =========================================================================

// POST /api/mitra/track-click - Record click from referral link
router.post('/track-click', async (req, res, next) => {
  try {
    const { referral_code, referrer_url } = req.body;
    if (!referral_code || typeof referral_code !== 'string') {
      return res.json({ success: false });
    }

    const cleanRef = referral_code.trim().toUpperCase();
    const mitraRes = await pool.query(
      `SELECT id, status FROM mitra_users WHERE UPPER(referral_code) = $1`,
      [cleanRef]
    );

    if (mitraRes.rows.length === 0 || mitraRes.rows[0].status !== 'active') {
      return res.json({ success: false });
    }

    const mitraId = mitraRes.rows[0].id;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    // Deduplication check: 1 click per IP per referral code per hour
    const recentClick = await pool.query(
      `SELECT id FROM mitra_clicks 
       WHERE mitra_id = $1 AND ip_address = $2 AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [mitraId, ip]
    );

    if (recentClick.rows.length === 0) {
      await pool.query(
        `INSERT INTO mitra_clicks (mitra_id, referral_code, ip_address, user_agent, referrer_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [mitraId, cleanRef, ip, userAgent.slice(0, 500), referrer_url ? String(referrer_url).slice(0, 500) : null]
      );
    }

    res.json({ success: true });
  } catch (error) {
    // Non-blocking for visitor
    console.error('Track click error:', error.message);
    res.json({ success: false });
  }
});

// =========================================================================
// ADMIN ENDPOINTS (Protected with verifyToken & verifyAdmin)
// =========================================================================

// GET /api/mitra/admin/users - List all mitras with stats
router.get('/admin/users', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const { status, search } = req.query;

    let countQuery = 'SELECT COUNT(*) FROM mitra_users WHERE 1=1';
    let dataQuery = `
      SELECT 
        mu.id, mu.name, mu.email, mu.whatsapp, mu.ktp_number, mu.ktp_image_url,
        mu.address, mu.bank_name, mu.bank_account, mu.bank_holder, mu.referral_code,
        mu.balance, mu.total_withdrawn, mu.status, mu.rejection_reason, mu.approved_at, mu.created_at,
        COALESCE(tx.total_sales, 0) as total_sales,
        COALESCE(tx.tx_count, 0) as total_transactions
      FROM mitra_users mu
      LEFT JOIN (
        SELECT mitra_id, SUM(total_price) as total_sales, COUNT(*) as tx_count
        FROM mitra_transactions
        WHERE status = 'settled'
        GROUP BY mitra_id
      ) tx ON tx.mitra_id = mu.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      countQuery += ` AND status = $${params.length}`;
      dataQuery += ` AND mu.status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const searchCondition = ` AND (LOWER(mu.name) LIKE $${params.length} OR LOWER(mu.email) LIKE $${params.length} OR LOWER(mu.referral_code) LIKE $${params.length} OR mu.whatsapp LIKE $${params.length})`;
      countQuery += searchCondition;
      dataQuery += searchCondition;
    }

    const countRes = await pool.query(countQuery, params);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    dataQuery += ` ORDER BY mu.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(dataQuery, dataParams);

    // Summary KPIs
    const summaryRes = await pool.query(`
      SELECT 
        COUNT(*) as total_mitra,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_mitra,
        COUNT(*) FILTER (WHERE status = 'active') as active_mitra,
        COUNT(*) FILTER (WHERE status = 'suspended') as suspended_mitra
      FROM mitra_users
    `);
    const summary = summaryRes.rows[0] || {};

    res.json({
      success: true,
      data: rows,
      summary: {
        total_mitra: parseInt(summary.total_mitra || '0', 10),
        pending_mitra: parseInt(summary.pending_mitra || '0', 10),
        active_mitra: parseInt(summary.active_mitra || '0', 10),
        suspended_mitra: parseInt(summary.suspended_mitra || '0', 10),
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/admin/users/:id - Single mitra detail
router.get('/admin/users/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM mitra_users WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Mitra tidak ditemukan.' });
    }

    const mitra = rows[0];

    const clicksRes = await pool.query('SELECT COUNT(*) FROM mitra_clicks WHERE mitra_id = $1', [id]);
    const totalClicks = parseInt(clicksRes.rows[0]?.count || '0', 10);

    const txRes = await pool.query(
      `SELECT id, order_id, buyer_name, buyer_email, product_name, total_price, commission_amount, status, created_at
       FROM mitra_transactions
       WHERE mitra_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...mitra,
        totalClicks,
        recentTransactions: txRes.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/admin/users/:id/approve - Approve mitra
router.post('/admin/users/:id/approve', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE mitra_users
       SET status = 'active', approved_at = NOW(), approved_by = $1, rejection_reason = NULL, updated_at = NOW()
       WHERE id = $2
       RETURNING name, email, referral_code`,
      [req.user.id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Mitra tidak ditemukan.' });
    }

    logAdminActivity(req, 'UPDATE', 'MITRA_USER', rows[0].name, `Menyetujui pendaftaran mitra "${rows[0].name}" (${rows[0].email})`);

    res.json({
      success: true,
      message: `Pendaftaran mitra "${rows[0].name}" berhasil disetujui!`,
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/admin/users/:id/reject - Reject mitra
router.post('/admin/users/:id/reject', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows } = await pool.query(
      `UPDATE mitra_users
       SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING name, email`,
      [reason ? reason.trim() : 'Data identitas / foto KTP tidak valid', id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Mitra tidak ditemukan.' });
    }

    logAdminActivity(req, 'UPDATE', 'MITRA_USER', rows[0].name, `Menolak pendaftaran mitra "${rows[0].name}" dengan alasan: ${reason || '-'}`);

    res.json({
      success: true,
      message: `Pendaftaran mitra "${rows[0].name}" ditolak.`,
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/admin/users/:id/suspend - Suspend mitra
router.post('/admin/users/:id/suspend', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows } = await pool.query(
      `UPDATE mitra_users
       SET status = 'suspended', rejection_reason = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING name, email`,
      [reason ? reason.trim() : 'Pelanggaran ketentuan mitra / indikasi fraud', id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Mitra tidak ditemukan.' });
    }

    logAdminActivity(req, 'UPDATE', 'MITRA_USER', rows[0].name, `Menangguhkan/suspend akun mitra "${rows[0].name}". Alasan: ${reason || '-'}`);

    res.json({
      success: true,
      message: `Akun mitra "${rows[0].name}" berhasil disuspend.`,
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/admin/users/:id/activate - Re-activate mitra
router.post('/admin/users/:id/activate', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE mitra_users
       SET status = 'active', rejection_reason = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING name, email`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Mitra tidak ditemukan.' });
    }

    logAdminActivity(req, 'UPDATE', 'MITRA_USER', rows[0].name, `Mengaktifkan kembali akun mitra "${rows[0].name}"`);

    res.json({
      success: true,
      message: `Akun mitra "${rows[0].name}" berhasil diaktifkan!`,
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/admin/withdrawals - List all withdrawals for admin
router.get('/admin/withdrawals', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 15));
    const offset = (page - 1) * limit;
    const { status } = req.query;

    let countQuery = 'SELECT COUNT(*) FROM mitra_withdrawals WHERE 1=1';
    let dataQuery = `
      SELECT 
        mw.id, mw.mitra_id, mw.amount, mw.bank_name, mw.bank_account, mw.bank_holder,
        mw.status, mw.admin_notes, mw.transfer_proof_url, mw.created_at, mw.processed_at,
        mu.name as mitra_name, mu.whatsapp as mitra_whatsapp, mu.email as mitra_email
      FROM mitra_withdrawals mw
      JOIN mitra_users mu ON mu.id = mw.mitra_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      countQuery += ` AND status = $${params.length}`;
      dataQuery += ` AND mw.status = $${params.length}`;
    }

    const countRes = await pool.query(countQuery, params);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    dataQuery += ` ORDER BY mw.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(dataQuery, dataParams);

    // Summary KPIs
    const summaryRes = await pool.query(`
      SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) as pending_amount,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) as total_payout_done,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_count
      FROM mitra_withdrawals
    `);
    const s = summaryRes.rows[0] || {};

    res.json({
      success: true,
      data: rows,
      summary: {
        total_requests: parseInt(s.total_requests || '0', 10),
        pending_amount: parseInt(s.pending_amount || '0', 10),
        pending_count: parseInt(s.pending_count || '0', 10),
        total_payout_done: parseInt(s.total_payout_done || '0', 10),
        approved_count: parseInt(s.approved_count || '0', 10),
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/admin/withdrawals/:id/approve - Approve withdrawal and upload proof
router.post('/admin/withdrawals/:id/approve', verifyToken, verifyAdmin, (req, res, next) => {
  upload.single('proof_image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'Ukuran file bukti transfer maksimal 5MB.' });
      }
      return res.status(400).json({ success: false, error: err.message });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { admin_notes } = req.body;

    let proofUrl = null;
    if (req.file) {
      try {
        const uploadRes = await uploadBufferToCloudinary(req.file.buffer, 'mitra_payouts');
        proofUrl = uploadRes.secure_url;
      } catch (uploadErr) {
        console.error('Cloudinary proof upload error:', uploadErr);
      }
    }

    await client.query('BEGIN');

    const wdRes = await client.query(
      `UPDATE mitra_withdrawals
       SET status = 'approved', admin_notes = $1, transfer_proof_url = COALESCE($2, transfer_proof_url), processed_by = $3, processed_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING *`,
      [admin_notes ? admin_notes.trim() : 'Transfer berhasil diproses', proofUrl, req.user.id, id]
    );

    if (wdRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Pengajuan penarikan tidak ditemukan atau sudah diproses sebelumnya.' });
    }

    const wd = wdRes.rows[0];

    // Update total_withdrawn
    await client.query(
      `UPDATE mitra_users
       SET total_withdrawn = total_withdrawn + $1, updated_at = NOW()
       WHERE id = $2`,
      [wd.amount, wd.mitra_id]
    );

    await client.query('COMMIT');

    logAdminActivity(req, 'UPDATE', 'MITRA_WITHDRAWAL', wd.bank_holder, `Menyetujui pencairan dana mitra Rp ${wd.amount.toLocaleString('id-ID')} ke rekening ${wd.bank_name} - ${wd.bank_account}`);

    res.json({
      success: true,
      message: 'Pencairan dana berhasil disetujui & ditandai selesai transfer!',
      data: wd,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// POST /api/mitra/admin/withdrawals/:id/reject - Reject withdrawal and refund balance atomically
router.post('/admin/withdrawals/:id/reject', verifyToken, verifyAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, error: 'Alasan penolakan wajib diisi.' });
    }

    await client.query('BEGIN');

    const wdRes = await client.query(
      `UPDATE mitra_withdrawals
       SET status = 'rejected', admin_notes = $1, processed_by = $2, processed_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reason.trim(), req.user.id, id]
    );

    if (wdRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Pengajuan penarikan tidak ditemukan atau sudah diproses.' });
    }

    const wd = wdRes.rows[0];

    // Refund balance atomically
    await client.query(
      `UPDATE mitra_users
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2`,
      [wd.amount, wd.mitra_id]
    );

    await client.query('COMMIT');

    logAdminActivity(req, 'UPDATE', 'MITRA_WITHDRAWAL', wd.bank_holder, `Menolak penarikan saldo Rp ${wd.amount.toLocaleString('id-ID')} (dana direfund ke saldo mitra). Alasan: ${reason}`);

    res.json({
      success: true,
      message: `Pencairan dana ditolak. Saldo sebesar Rp ${wd.amount.toLocaleString('id-ID')} telah dikembalikan secara otomatis ke akun mitra.`,
      data: wd,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/mitra/admin/transactions - List all referral transactions for admin
router.get('/admin/transactions', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 15));
    const offset = (page - 1) * limit;
    const { status, search, startDate, endDate } = req.query;

    let countQuery = 'SELECT COUNT(*) FROM mitra_transactions mt JOIN mitra_users mu ON mu.id = mt.mitra_id WHERE 1=1';
    let dataQuery = `
      SELECT 
        mt.id, mt.order_id, mt.buyer_name, mt.buyer_email, mt.product_name,
        mt.total_price, mt.discount_amount, mt.commission_amount, mt.status, mt.created_at, mt.settled_at,
        mu.name as mitra_name, mu.referral_code, mu.whatsapp as mitra_whatsapp
      FROM mitra_transactions mt
      JOIN mitra_users mu ON mu.id = mt.mitra_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      countQuery += ` AND mt.status = $${params.length}`;
      dataQuery += ` AND mt.status = $${params.length}`;
    }

    if (startDate) {
      params.push(startDate);
      countQuery += ` AND mt.created_at >= $${params.length}`;
      dataQuery += ` AND mt.created_at >= $${params.length}`;
    }

    if (endDate) {
      params.push(`${endDate} 23:59:59`);
      countQuery += ` AND mt.created_at <= $${params.length}`;
      dataQuery += ` AND mt.created_at <= $${params.length}`;
    }

    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const searchClause = ` AND (LOWER(mt.order_id) LIKE $${params.length} OR LOWER(mt.buyer_name) LIKE $${params.length} OR LOWER(mu.name) LIKE $${params.length} OR LOWER(mu.referral_code) LIKE $${params.length})`;
      countQuery += searchClause;
      dataQuery += searchClause;
    }

    const countRes = await pool.query(countQuery, params);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    dataQuery += ` ORDER BY mt.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(dataQuery, dataParams);

    // Summary
    const summaryRes = await pool.query(`
      SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(total_price) FILTER (WHERE status = 'settled'), 0) as total_sales,
        COALESCE(SUM(commission_amount) FILTER (WHERE status = 'settled'), 0) as total_commission,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count
      FROM mitra_transactions
    `);
    const s = summaryRes.rows[0] || {};

    res.json({
      success: true,
      data: rows,
      summary: {
        total_count: parseInt(s.total_count || '0', 10),
        total_sales: parseInt(s.total_sales || '0', 10),
        total_commission: parseInt(s.total_commission || '0', 10),
        pending_count: parseInt(s.pending_count || '0', 10),
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/admin/settings - Get settings
router.get('/admin/settings', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM mitra_settings');
    const settings = {
      buyerDiscountPercent: 10,
      commissionPercent: 10,
      minWithdrawal: 50000,
      cookieDays: 14,
    };

    rows.forEach((r) => {
      if (r.key === 'buyer_discount_percent') settings.buyerDiscountPercent = parseInt(r.value, 10) || 10;
      if (r.key === 'commission_percent') settings.commissionPercent = parseInt(r.value, 10) || 10;
      if (r.key === 'min_withdrawal') settings.minWithdrawal = parseInt(r.value, 10) || 50000;
      if (r.key === 'cookie_days') settings.cookieDays = parseInt(r.value, 10) || 14;
    });

    res.json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
});

// PUT /api/mitra/admin/settings - Update settings
router.put('/admin/settings', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { buyerDiscountPercent, commissionPercent, minWithdrawal, cookieDays } = req.body;

    const updates = [
      { key: 'buyer_discount_percent', val: String(Math.max(0, Math.min(100, parseInt(buyerDiscountPercent, 10) || 10))) },
      { key: 'commission_percent', val: String(Math.max(0, Math.min(100, parseInt(commissionPercent, 10) || 10))) },
      { key: 'min_withdrawal', val: String(Math.max(10000, parseInt(minWithdrawal, 10) || 50000)) },
      { key: 'cookie_days', val: String(Math.max(1, Math.min(90, parseInt(cookieDays, 10) || 14))) },
    ];

    for (const u of updates) {
      await pool.query(
        `INSERT INTO mitra_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [u.key, u.val]
      );
    }

    logAdminActivity(req, 'UPDATE', 'MITRA_SETTINGS', 'Config', `Mengubah konfigurasi komisi mitra (Buyer Disc: ${buyerDiscountPercent}%, Mitra Comm: ${commissionPercent}%, Min WD: Rp ${minWithdrawal})`);

    res.json({ success: true, message: 'Pengaturan mitra berhasil disimpan.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/mitra/admin/missions - List missions for admin
router.get('/admin/missions', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        mm.*,
        COUNT(DISTINCT mp.mitra_id) as participants_count,
        COUNT(DISTINCT mp.mitra_id) FILTER (WHERE mp.is_completed = TRUE) as completed_count,
        COUNT(DISTINCT mp.mitra_id) FILTER (WHERE mp.is_claimed = TRUE) as claimed_count
      FROM mitra_missions mm
      LEFT JOIN mitra_mission_progress mp ON mp.mission_id = mm.id
      GROUP BY mm.id
      ORDER BY mm.created_at DESC
    `);

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/mitra/admin/missions - Create new mission
router.post('/admin/missions', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const {
      name,
      description,
      target_type,
      target_value,
      reward_amount,
      reward_type,
      category,
      start_date,
      end_date,
      is_active,
    } = req.body;

    if (!name || !target_value || !reward_amount) {
      return res.status(400).json({ success: false, error: 'Nama misi, nilai target, dan reward wajib diisi.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO mitra_missions (
        name, description, target_type, target_value, reward_amount, reward_type, category,
        start_date, end_date, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        name.trim(),
        description ? description.trim() : '',
        target_type || 'transaction_count',
        parseInt(target_value, 10) || 1,
        parseInt(reward_amount, 10) || 10000,
        reward_type || 'balance',
        category || 'pemula',
        start_date ? new Date(start_date) : null,
        end_date ? new Date(end_date) : null,
        is_active !== undefined ? is_active : true,
      ]
    );

    logAdminActivity(req, 'CREATE', 'MITRA_MISSION', name, `Membuat misi gamifikasi mitra baru: "${name}"`);

    res.status(201).json({
      success: true,
      message: 'Misi baru berhasil dibuat!',
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/mitra/admin/missions/:id - Update mission
router.put('/admin/missions/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      target_type,
      target_value,
      reward_amount,
      reward_type,
      category,
      start_date,
      end_date,
      is_active,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE mitra_missions
       SET name = $1, description = $2, target_type = $3, target_value = $4,
           reward_amount = $5, reward_type = $6, category = $7, start_date = $8,
           end_date = $9, is_active = $10
       WHERE id = $11
       RETURNING *`,
      [
        name.trim(),
        description ? description.trim() : '',
        target_type || 'transaction_count',
        parseInt(target_value, 10) || 1,
        parseInt(reward_amount, 10) || 10000,
        reward_type || 'balance',
        category || 'pemula',
        start_date ? new Date(start_date) : null,
        end_date ? new Date(end_date) : null,
        is_active !== undefined ? is_active : true,
        id,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Misi tidak ditemukan.' });
    }

    logAdminActivity(req, 'UPDATE', 'MITRA_MISSION', name, `Mengubah misi gamifikasi mitra ID: ${id}`);

    res.json({
      success: true,
      message: 'Misi berhasil diperbarui!',
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/mitra/admin/missions/:id - Delete mission
router.delete('/admin/missions/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'DELETE FROM mitra_missions WHERE id = $1 RETURNING name',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Misi tidak ditemukan.' });
    }

    logAdminActivity(req, 'DELETE', 'MITRA_MISSION', rows[0].name, `Menghapus misi gamifikasi mitra "${rows[0].name}"`);

    res.json({
      success: true,
      message: 'Misi berhasil dihapus.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
