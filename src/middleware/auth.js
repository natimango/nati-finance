const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'nati_token';
const JWT_SECRET = process.env.JWT_SECRET || 'nati-dev-secret';

function getTokenFromRequest(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.substring(7);
  }
  return null;
}

function authenticate(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    console.error('Auth token error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (roles.length === 0 || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

module.exports = {
  authenticate,
  authorize,
  COOKIE_NAME,
  JWT_SECRET
};
