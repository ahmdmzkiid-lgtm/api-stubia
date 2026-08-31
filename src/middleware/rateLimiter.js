let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch (e) {
  console.warn('⚠️ express-rate-limit module missing, bypassing rate limiter');
  rateLimit = () => (req, res, next) => next();
}

// Rate limiter for Auth endpoints (login, register, update-password)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Terlalu banyak percobaan. Silakan coba lagi dalam 15 menit.',
  },
});

// Rate limiter for Voucher Validation endpoint
const voucherLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 attempts per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Terlalu banyak percobaan validasi voucher. Silakan coba lagi dalam 15 menit.',
  },
});

// Rate limiter for Public Upload endpoints
const publicUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 uploads per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Batas upload gratis per jam telah tercapai. Silakan coba lagi nanti.',
  },
});

// Rate limiter for AI Chat endpoints (9Router API protection)
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 15, // Limit each IP to 15 chat messages per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Terlalu banyak pesan dikirim. Silakan tunggu beberapa detik sebelum bertanya lagi.',
  },
});

// Rate limiter for Admin PIN verification (prevent brute-force)
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Terlalu banyak percobaan PIN Admin yang salah. Silakan coba lagi dalam 15 menit.',
  },
});

module.exports = {
  authLimiter,
  voucherLimiter,
  publicUploadLimiter,
  chatLimiter,
  pinLimiter,
};
