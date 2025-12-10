const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { COOKIE_NAME, JWT_SECRET } = require('../middleware/auth');

let secureCookie;
if (typeof process.env.COOKIE_SECURE === 'string' && process.env.COOKIE_SECURE.length) {
  secureCookie = process.env.COOKIE_SECURE.toLowerCase() === 'true';
} else {
  secureCookie = process.env.NODE_ENV === 'production';
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: secureCookie,
  maxAge: 1000 * 60 * 60 * 12, // 12 hours
  path: '/'
};

function buildTokenPayload(user) {
  return {
    userId: user.user_id,
    email: user.email,
    role: user.role,
    name: user.full_name || user.email
  };
}

function publicUser(user) {
  return {
    id: user.user_id,
    email: user.email,
    name: user.full_name,
    role: user.role,
    created_at: user.created_at,
    last_login: user.last_login
  };
}

async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const result = await pool.query(
      'SELECT user_id, email, password_hash, full_name, role, created_at, last_login FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const payload = buildTokenPayload(user);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
    await pool.query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.user_id]);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Unable to login' });
  }
}

async function logout(req, res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
}

async function me(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const result = await pool.query(
      'SELECT user_id, email, full_name, role, created_at, last_login FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({ success: true, user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Unable to load profile' });
  }
}

async function listUsers(req, res) {
  try {
    const result = await pool.query(
      'SELECT user_id, email, full_name, role, created_at, last_login FROM users ORDER BY created_at ASC'
    );
    res.json({
      success: true,
      users: result.rows.map(publicUser)
    });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Unable to list users' });
  }
}

async function createUser(req, res) {
  try {
    const { email, password, full_name, role } = req.body || {};
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'email, password, role are required' });
    }
    if (!['uploader', 'manager', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, email, full_name, role, created_at, last_login`,
      [email.toLowerCase(), hash, full_name || null, role]
    );
    res.status(201).json({ success: true, user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error('Create user error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Unable to create user' });
  }
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const userId = Number(id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (req.user.userId === userId) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const result = await pool.query(
      'SELECT user_id, email FROM users WHERE user_id = $1',
      [userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Preserve document history but drop ownership reference
    await pool.query('UPDATE documents SET uploaded_by = NULL WHERE uploaded_by = $1', [userId]);
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Unable to delete user' });
  }
}

module.exports = {
  login,
  logout,
  me,
  listUsers,
  createUser,
  deleteUser
};
