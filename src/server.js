require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const { execSync } = require('child_process');
const pool = require('./config/database');
const { authenticate } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

const defaultOrigins = ['https://accounts.natiwear.in', 'http://localhost:3000'];
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : defaultOrigins;

const startedAt = new Date().toISOString();
let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (err) {
  console.warn('Unable to resolve git SHA for /api/version');
}

const versionInfo = {
  git_sha: gitSha,
  started_at: startedAt,
  env: process.env.NODE_ENV || 'development'
};

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
const uploadRoutes = require('./routes/uploadRoutes');
const billRoutes = require('./routes/billRoutes');
const reportRoutes = require('./routes/reportRoutes');
const brainRoutes = require('./routes/brainRoutes');
const authRoutes = require('./routes/authRoutes');
const qualityRoutes = require('./routes/qualityRoutes');
const metaRoutes = require('./routes/metaRoutes');
const dropRoutes = require('./routes/dropRoutes');

app.use('/api/auth', authRoutes);
app.use('/api', authenticate, uploadRoutes);
app.use('/api', authenticate, billRoutes);
app.use('/api', authenticate, reportRoutes);
app.use('/api', authenticate, metaRoutes);
app.use('/api', authenticate, dropRoutes);
app.use('/api', authenticate, require('./routes/billItemRoutes'));
app.use('/api/brain', authenticate, brainRoutes);
app.use('/api', authenticate, qualityRoutes);

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as time');
    const userCount = await pool.query('SELECT COUNT(*) as count FROM users');
    const docCount = await pool.query('SELECT COUNT(*) as count FROM documents');
    
    res.json({
      status: 'OK',
      message: 'NATI Accounting System is running!',
      database: 'Connected',
      timestamp: result.rows[0].time,
      stats: {
        users: parseInt(userCount.rows[0].count),
        documents: parseInt(docCount.rows[0].count)
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: error.message
    });
  }
});

app.get('/api/version', (_req, res) => {
  res.json({
    ...versionInfo,
    status: 'OK'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 NATI Accounting System Started!');
  console.log(`📍 Dashboard: http://localhost:${PORT}`);
  console.log(`📊 Reports: http://localhost:${PORT}/reports.html`);
  console.log(`🤖 AI Provider: OpenAI (primary)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

module.exports = app;
