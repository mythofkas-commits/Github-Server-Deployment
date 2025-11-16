const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const userStore = require('./userStore');

const TOKEN_COOKIE_NAME = 'authToken';
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const ADMIN_SUBJECT = 'admin';

const getCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: !!config.isProduction,
  maxAge: TOKEN_TTL_SECONDS * 1000
});

const signSessionToken = (payload) =>
  jwt.sign(payload, config.SESSION_SECRET, { expiresIn: TOKEN_TTL_SECONDS });

const readAuthToken = (req) => {
  if (req.cookies?.[TOKEN_COOKIE_NAME]) {
    return req.cookies[TOKEN_COOKIE_NAME];
  }
  const header = req.get('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return null;
};

const verifyToken = (token) => {
  if (!token) return null;
  try {
    return jwt.verify(token, config.SESSION_SECRET);
  } catch {
    return null;
  }
};

const buildUserFromPayload = (payload) => {
  if (!payload?.sub) return null;
  const role = payload.role === 'admin' ? 'admin' : 'user';
  return {
    id: payload.sub,
    username: payload.username || (role === 'admin' ? config.ADMIN_USERNAME : ''),
    role,
    isAdmin: role === 'admin'
  };
};

const requireAuth = (req, res, next) => {
  const token = readAuthToken(req);
  const payload = verifyToken(token);
  const user = buildUserFromPayload(payload);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = user;
  return next();
};

const requireAdmin = (req, res, next) =>
  requireAuth(req, res, () => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return next();
  });

const getUserFromRequest = (req) => {
  const payload = verifyToken(readAuthToken(req));
  return buildUserFromPayload(payload);
};

const setAuthCookie = (res, token) => {
  res.cookie(TOKEN_COOKIE_NAME, token, getCookieOptions());
};

const clearAuthCookie = (res) => {
  res.cookie(TOKEN_COOKIE_NAME, '', { ...getCookieOptions(), maxAge: 0 });
};

const createAdminPayload = () => ({
  sub: ADMIN_SUBJECT,
  username: config.ADMIN_USERNAME,
  role: 'admin'
});

const createUserPayload = (user) => ({
  sub: user.id,
  username: user.username,
  role: user.role || 'user'
});

async function authenticateCredentials(username, password) {
  if (!username || !password) {
    return null;
  }
  if (username === config.ADMIN_USERNAME) {
    if (!config.ADMIN_PASSWORD_HASH) return null;
    const isValid = await bcrypt.compare(password, config.ADMIN_PASSWORD_HASH);
    if (!isValid) return null;
    const payload = createAdminPayload();
    return {
      token: signSessionToken(payload),
      user: buildUserFromPayload(payload)
    };
  }
  const record = await userStore.getUserByUsername(username);
  if (!record || record.disabled) {
    return null;
  }
  const isValid = await bcrypt.compare(password, record.passwordHash);
  if (!isValid) {
    return null;
  }
  const payload = createUserPayload(record);
  return {
    token: signSessionToken(payload),
    user: buildUserFromPayload(payload)
  };
}

module.exports = {
  TOKEN_COOKIE_NAME,
  requireAuth,
  requireAdmin,
  getUserFromRequest,
  setAuthCookie,
  clearAuthCookie,
  signSessionToken,
  getCookieOptions,
  authenticateCredentials,
  createAdminPayload,
  createUserPayload
};
