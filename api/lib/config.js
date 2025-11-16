const path = require('path');
require('dotenv').config();

const resolvePath = (value, fallback) => path.resolve(value || fallback);

const PROJECTS_DIR = resolvePath(process.env.PROJECTS_DIR, '/var/deploy/projects');
const LOGS_DIR = resolvePath(process.env.LOGS_DIR, '/var/deploy/logs');
const BUILD_DIR = resolvePath(process.env.BUILD_DIR, '/var/deploy/builds');
const NGINX_ROOT = resolvePath(process.env.NGINX_ROOT, '/var/www');
const SECRETS_MASTER_KEY = process.env.SECRETS_MASTER_KEY || '';
const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').trim();
const MAX_QUEUE_SIZE = Math.max(1, Number.parseInt(process.env.MAX_QUEUE_SIZE || '50', 10));
const USERS_FILE = resolvePath(process.env.USERS_FILE, path.join(__dirname, '..', 'data', 'users.json'));

if (!SECRETS_MASTER_KEY) {
  if (isProduction) {
    throw new Error('SECRETS_MASTER_KEY must be set in production.');
  } else {
    console.warn('[config] SECRETS_MASTER_KEY is not set. Secret env vars will not work until this is configured.');
  }
} else if (SECRETS_MASTER_KEY.length < 16 || SECRETS_MASTER_KEY === 'test-master-key') {
  console.warn('[config] SECRETS_MASTER_KEY looks weak. Use a strong random string before deploying to production.');
}

if (!ADMIN_PASSWORD_HASH) {
  const message = '[config] ADMIN_PASSWORD_HASH is not set. API login is disabled until this is configured.';
  if (isProduction) {
    throw new Error(message);
  } else {
    console.warn(message);
  }
}

if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  const message = '[config] SESSION_SECRET must be a strong random string.';
  if (isProduction) {
    throw new Error(message);
  } else {
    console.warn(message);
  }
}

if (!ALLOWED_ORIGIN) {
  console.warn('[config] ALLOWED_ORIGIN is empty. Set it to your frontend origin to enable CORS.');
}

module.exports = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  GITHUB_USERNAME: process.env.GITHUB_USERNAME || '',
  PROJECTS_DIR,
  BUILD_DIR,
  LOGS_DIR,
  NGINX_ROOT,
  SECRETS_MASTER_KEY,
  RELEASES_DIR_NAME: process.env.RELEASES_DIR_NAME || 'releases',
  DEFAULT_BUILD_OUTPUT: process.env.DEFAULT_BUILD_OUTPUT || 'build',
  MAX_CONCURRENT_DEPLOYS: Number.parseInt(process.env.MAX_CONCURRENT_DEPLOYS || '1', 10),
  NGINX_SITES_AVAILABLE: resolvePath(process.env.NGINX_SITES_AVAILABLE, '/etc/nginx/sites-available'),
  NGINX_SITES_ENABLED: resolvePath(process.env.NGINX_SITES_ENABLED, '/etc/nginx/sites-enabled'),
  PM2_BIN: process.env.PM2_BIN || 'pm2',
  DEPLOY_USER: process.env.DEPLOY_USER || process.env.USER || 'root',
  ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH,
  SESSION_SECRET,
  ALLOWED_ORIGIN,
  MAX_QUEUE_SIZE,
  USERS_FILE,
  isProduction
};
