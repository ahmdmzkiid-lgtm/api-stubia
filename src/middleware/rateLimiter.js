let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch (e) {
  console.warn('⚠️ express-rate-limit module missing, bypassing rate limiter');
  rateLimit = () => (req, res, next) => next();
}

const createLimiter = (options) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
      xForwardedForHeader: false,
    },
    ...options,
  });

// Rate limiter for Auth endpoints (login, register, update-password)
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    success: false,
    error: 'Terlalu banyak percobaan. Silakan coba lagi dalam 15 menit.',
  },
});

// Rate limiter for Voucher Validation endpoint
const voucherLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 attempts per windowMs
  message: {
    success: false,
    error: 'Terlalu banyak percobaan validasi voucher. Silakan coba lagi dalam 15 menit.',
  },
});

// Rate limiter for Public Upload endpoints
const publicUploadLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 uploads per hour
  message: {
    success: false,
    error: 'Batas upload gratis per jam telah tercapai. Silakan coba lagi nanti.',
  },
});

// Rate limiter for AI Chat endpoints (9Router API protection)
const chatLimiter = createLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 15, // Limit each IP to 15 chat messages per minute
  message: {
    success: false,
    error: 'Terlalu banyak pesan dikirim. Silakan tunggu beberapa detik sebelum bertanya lagi.',
  },
});

// Rate limiter for Admin PIN verification (prevent brute-force)
const pinLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 attempts per 15 minutes
  message: {
    success: false,
    error: 'Terlalu banyak percobaan PIN Admin yang salah. Silakan coba lagi dalam 15 menit.',
  },
});

// Rate limiter for Career Applications (prevent spamming form submissions)
const careerApplyLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 applications per hour
  message: {
    success: false,
    error: 'Terlalu banyak pengiriman lamaran dari IP ini. Silakan coba lagi dalam 1 jam.',
  },
});

module.exports = {
  authLimiter,
  voucherLimiter,
  publicUploadLimiter,
  chatLimiter,
  pinLimiter,
  careerApplyLimiter,
};
