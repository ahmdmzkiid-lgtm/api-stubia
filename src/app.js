const path = require('path');
// Load .env: first try server-local (for Render), then root (for local dev)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initializeDatabase } = require('./config/db');
const { populateQuestionHashes } = require('./utils/populateQuestionHashes');

const app = express();

// === CORS harus SEBELUM Helmet agar preflight OPTIONS tidak di-block ===
const allowedOrigins = [
  'https://stubia.id',
  'https://www.stubia.id',
  'https://app.stubia.id',
  'https://admin.stubia.id',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:8080',
  'http://localhost:3000'
];

if (process.env.CLIENT_URL) {
  allowedOrigins.push(process.env.CLIENT_URL.replace(/\/$/, ''));
}
if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/$/, ''));
}

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  return (
    allowedOrigins.includes(origin) ||
    /^https:\/\/[a-z0-9-]+\.stubia\.id$/.test(origin) ||
    /^http:\/\/localhost:[0-9]+$/.test(origin)
  );
};

// Express Manual CORS & Preflight Handler for Hostinger CDN Compatibility
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    // Disable caching for OPTIONS so Hostinger CDN doesn't strip Origin
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.status(200).end();
  }
  next();
});

app.use(cors({
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200,
}));

// Security Headers (Helmet configured for OAuth compatibility)
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(express.json());
app.use(morgan('dev'));

// Basic health check route
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'API is running' });
});

// Import routes (will be created later)
const authRoutes = require('./routes/auth');
const soalRoutes = require('./routes/soal');
const tryoutRoutes = require('./routes/tryout');
const bookmarkRoutes = require('./routes/bookmark');
const importRoutes = require('./routes/import');
const subjectsRoutes = require('./routes/subjects');
const topicsRoutes = require('./routes/topics');
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const chatRoutes = require('./routes/chat');
const activityRoutes = require('./routes/activity');
const subscriptionRoutes = require('./routes/subscription');
const battleRoutes = require('./routes/battle');
const uploadRoutes = require('./routes/upload');
const ujianMandiriRoutes = require('./routes/ujianMandiri');
const socialRoutes = require('./routes/social');
const teamRoutes = require('./routes/team');
const vouchersRoutes = require('./routes/vouchers');
const articlesRoutes = require('./routes/articles');
const careersRoutes = require('./routes/careers');
const sitemapRoutes = require('./routes/sitemap');
const certificatesRoutes = require('./routes/certificates');
const fellowshipRoutes = require('./routes/fellowship');
const skdCpnsRoutes = require('./routes/skdCpns');
const tkaRoutes = require('./routes/tka');
const fundamentalRoutes = require('./routes/fundamental');

// Mount routes
app.use('/sitemap.xml', sitemapRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/soal', soalRoutes);
app.use('/api/tryout', tryoutRoutes);
app.use('/api/bookmark', bookmarkRoutes);
app.use('/api/import', importRoutes);
app.use('/api/subjects', subjectsRoutes);
app.use('/api/topics', topicsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/battle', battleRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/ujian-mandiri', ujianMandiriRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/vouchers', vouchersRoutes);
app.use('/api/articles', articlesRoutes);
app.use('/api/careers', careersRoutes);
app.use('/api/certificates', certificatesRoutes);
app.use('/api/fellowship', fellowshipRoutes);
app.use('/api/skd', skdCpnsRoutes);
app.use('/api/tka', tkaRoutes);
app.use('/api/fundamental', fundamentalRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  const statusCode = err.status || 500;
  const errorMessage = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Terjadi kesalahan pada server. Silakan coba lagi nanti.'
    : (err.message || 'Internal Server Error');

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
  });
});

const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    await initializeDatabase();
    await populateQuestionHashes();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
