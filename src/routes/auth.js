const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { OAuth2Client } = require('google-auth-library');
const { getJwtSecret } = require('../config/jwt');
const { sendPasswordResetEmail } = require('../services/emailService');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Register
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password minimal harus 8 karakter.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Format email tidak valid.' });
    }

    const checkUser = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already registered.' });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, role',
      [name.trim(), normalizedEmail, passwordHash]
    );

    const user = result.rows[0];
    const { sendWelcomeEmail } = require('../services/emailService');
    sendWelcomeEmail(user.email, user.name).catch(err => console.error('Welcome email error:', err));

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({ success: true, data: { user, token }, message: 'Registered successfully.' });
  } catch (error) {
    next(error);
  }
});

// Login
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email dan password harus diisi.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Email atau password salah.' });
    }

    const user = result.rows[0];

    // Deteksi akun yang dibuat via Google (tidak punya password asli)
    if (user.google_id && !user.password_hash) {
      return res.status(401).json({
        success: false,
        error: 'Akun ini terdaftar melalui Google Sign-In. Silakan gunakan tombol "Masuk dengan Google".',
        hint: 'google_account'
      });
    }

    if (!user.password_hash) {
      return res.status(401).json({ success: false, error: 'Email atau password salah.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!isMatch) {
      // Cek apakah akun ini sebenarnya akun Google (password_hash dari randomBytes)
      // Tidak ada cara 100% pasti, tapi jika ada google_id di DB kita bisa deteksi
      const googleCheck = await pool.query('SELECT google_id FROM users WHERE id = $1 AND google_id IS NOT NULL', [user.id]);
      if (googleCheck.rows.length > 0) {
        return res.status(401).json({
          success: false,
          error: 'Akun ini terdaftar melalui Google Sign-In. Silakan gunakan tombol "Masuk dengan Google".',
          hint: 'google_account'
        });
      }
      return res.status(401).json({ success: false, error: 'Email atau password salah.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    delete user.password_hash;
    res.json({ success: true, data: { user, token }, message: 'Logged in successfully.' });
  } catch (error) {
    next(error);
  }
});

// Helper function to extract or fallback name from Google payload
const getSafeNameFromPayload = (payload) => {
  if (payload.name && payload.name.trim() !== '') {
    return payload.name.trim();
  }
  if (payload.given_name || payload.family_name) {
    return `${payload.given_name || ''} ${payload.family_name || ''}`.trim();
  }
  if (payload.email) {
    const emailPrefix = payload.email.split('@')[0];
    return emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);
  }
  return 'Pengguna Stubia';
};

// Google Login via Authorization Code Redirect Flow (New Preferred Flow)
router.post('/google-code', async (req, res, next) => {
  try {
    const { code, redirect_uri } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Authorization code Google diperlukan.' });
    }

    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri || `${process.env.CLIENT_URL || 'http://localhost:8080'}/auth/google/callback`
    );

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.id_token) {
      return res.status(400).json({ success: false, error: 'Gagal mendapatkan ID token dari Google.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, sub: googleId } = payload;
    const normalizedEmail = String(email).trim().toLowerCase();
    const safeName = getSafeNameFromPayload(payload);

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    let user;

    if (result.rows.length === 0) {
      // User baru: buat akun
      const insertResult = await pool.query(
        'INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING id, name, email, role',
        [safeName, normalizedEmail, googleId]
      );
      user = insertResult.rows[0];
      const { sendWelcomeEmail } = require('../services/emailService');
      sendWelcomeEmail(user.email, user.name).catch(err => console.error('Google welcome email error:', err));
    } else {
      user = result.rows[0];
      // Update google_id jika belum ada
      if (!user.google_id) {
        await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, user.id]);
        user.google_id = googleId;
      }
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    delete user.password_hash;
    res.json({ success: true, data: { user, token }, message: 'Logged in with Google successfully.' });
  } catch (error) {
    console.error('Google code exchange error:', error);
    res.status(401).json({ success: false, error: 'Gagal otentikasi dengan Google. Silakan coba lagi.' });
  }
});

// Google Login (Pop-up flow legacy compatibility)
router.post('/google', async (req, res, next) => {
  try {
    const { access_token } = req.body; // Actually an ID token from credential
    if (!access_token) {
      return res.status(400).json({ success: false, error: 'Google token is required.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: access_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { email, sub: googleId } = payload;
    const normalizedEmail = String(email).trim().toLowerCase();
    const safeName = getSafeNameFromPayload(payload);

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    let user;
    
    if (result.rows.length === 0) {
      // User baru: buat akun, tandai sebagai akun Google
      const insertResult = await pool.query(
        'INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING id, name, email, role',
        [safeName, normalizedEmail, googleId]
      );
      user = insertResult.rows[0];
      const { sendWelcomeEmail } = require('../services/emailService');
      sendWelcomeEmail(user.email, user.name).catch(err => console.error('Google welcome email error:', err));
    } else {
      user = result.rows[0];
      // Update google_id jika belum ada (user lama yang daftar Google pertama kali)
      if (!user.google_id) {
        await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, user.id]);
        user.google_id = googleId;
      }
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    delete user.password_hash;
    res.json({ success: true, data: { user, token }, message: 'Logged in with Google successfully.' });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(401).json({ success: false, error: 'Token Google tidak valid. Silakan coba lagi.' });
  }
});

// Get Current User
router.get('/me', verifyToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, current_plan, target_ptn, target_major, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    res.json({ success: true, data: result.rows[0], message: 'User profile retrieved.' });
  } catch (error) {
    next(error);
  }
});

// Update Profile Name
router.put('/update-profile', verifyToken, async (req, res, next) => {
  try {
    const { name, target_ptn, target_major } = req.body;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ success: false, error: 'Nama tidak boleh kosong.' });
    }

    if (name.length > 255) {
      return res.status(400).json({ success: false, error: 'Nama tidak boleh melebihi 255 karakter.' });
    }

    const result = await pool.query(
      'UPDATE users SET name = $1, target_ptn = $2, target_major = $3 WHERE id = $4 RETURNING id, name, email, role, current_plan, target_ptn, target_major, created_at',
      [name.trim(), target_ptn || null, target_major || null, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });
    }

    // Also update all target_ptn and target_major in active sessions for this user so leaderboard updates
    if (target_ptn && target_major) {
      await pool.query(
        'UPDATE tryout_sessions SET target_ptn = $1, target_major = $2 WHERE user_id = $3',
        [target_ptn, target_major, req.user.id]
      );
    }

    res.json({ success: true, data: result.rows[0], message: 'Profil berhasil diperbarui.' });
  } catch (error) {
    next(error);
  }
});

// Update Password
router.put('/update-password', verifyToken, authLimiter, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Password lama dan password baru harus diisi.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password baru harus minimal 8 karakter.' });
    }

    // Ambil user dari DB untuk mencocokkan password lama
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Password lama tidak sesuai.' });
    }

    // Hash password baru
    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, req.user.id]);

    res.json({ success: true, message: 'Password berhasil diperbarui.' });
  } catch (error) {
    next(error);
  }
});

// Request Forgot Password (Magic Link)
router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email wajib diisi.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Format email tidak valid.' });
    }

    const genericSuccessMessage = 'Jika email terdaftar, kami telah mengirimkan tautan reset password. Silakan periksa kotak masuk atau spam email kamu.';

    const userResult = await pool.query(
      'SELECT id, name, email, google_id, password_hash FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
      // Return generic message to prevent email enumeration
      return res.json({ success: true, message: genericSuccessMessage });
    }

    const user = userResult.rows[0];

    // Jika akun terdaftar via Google murni (tidak punya password), user tinggal login via Google
    if (user.google_id && !user.password_hash) {
      return res.json({
        success: true,
        message: genericSuccessMessage,
      });
    }

    // Generate secure random reset token and store its SHA-256 hash in DB
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 menit

    await pool.query(
      'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3',
      [hashedResetToken, expiresAt, user.id]
    );

    const clientUrl = process.env.CLIENT_URL || 'https://stubia.id';
    const resetLink = `${clientUrl.replace(/\/$/, '')}/reset-password?token=${resetToken}`;

    // Send email via Brevo
    sendPasswordResetEmail(user.email, user.name, resetLink).catch((err) =>
      console.error('Failed to send reset password email:', err)
    );

    res.json({
      success: true,
      message: genericSuccessMessage,
    });
  } catch (error) {
    next(error);
  }
});

// Verify Reset Password Token
router.get('/verify-reset-token', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ success: false, valid: false, error: 'Token tidak valid.' });
    }

    const hashedToken = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await pool.query(
      'SELECT id, email, reset_password_expires FROM users WHERE reset_password_token = $1 OR reset_password_token = $2',
      [hashedToken, String(token)]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: 'Tautan reset password tidak valid atau sudah pernah digunakan.',
      });
    }

    const user = result.rows[0];
    const isExpired = new Date(user.reset_password_expires).getTime() < Date.now();

    if (isExpired) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: 'Tautan reset password sudah kadaluarsa (melebihi 15 menit). Silakan ajukan permintaan baru.',
      });
    }

    res.json({ success: true, valid: true, email: user.email });
  } catch (error) {
    next(error);
  }
});

// Reset Password
router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, error: 'Token dan password baru wajib diisi.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password baru harus minimal 8 karakter.' });
    }

    const hashedToken = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await pool.query(
      'SELECT id, email, reset_password_expires FROM users WHERE reset_password_token = $1 OR reset_password_token = $2',
      [hashedToken, String(token)]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Tautan reset password tidak valid atau sudah pernah digunakan. Silakan minta tautan baru.',
      });
    }

    const user = result.rows[0];
    const isExpired = new Date(user.reset_password_expires).getTime() < Date.now();

    if (isExpired) {
      // Clear expired token
      await pool.query(
        'UPDATE users SET reset_password_token = NULL, reset_password_expires = NULL WHERE id = $1',
        [user.id]
      );
      return res.status(400).json({
        success: false,
        error: 'Tautan reset password sudah kadaluarsa (melebihi 15 menit). Silakan ajukan permintaan baru.',
      });
    }

    // Hash new password
    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password and invalidate token
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
      [newPasswordHash, user.id]
    );

    res.json({
      success: true,
      message: 'Password berhasil diubah! Silakan masuk dengan password baru kamu.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

