const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const USERS_FILE = config.USERS_FILE;

const normalizeUsername = (value = '') => value.trim().toLowerCase();

async function ensureUsersFile() {
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
    await fs.writeFile(USERS_FILE, '[]', 'utf8');
  }
}

async function readUsers() {
  await ensureUsersFile();
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
  const payload = JSON.stringify(users, null, 2);
  const tempPath = `${USERS_FILE}.tmp`;
  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, USERS_FILE).catch(async () => {
    await fs.writeFile(USERS_FILE, payload, 'utf8');
  });
}

async function getAllUsers() {
  return readUsers();
}

async function getUserByUsername(username) {
  const normalized = normalizeUsername(username || '');
  if (!normalized) return undefined;
  const users = await readUsers();
  return users.find((user) => normalizeUsername(user.username) === normalized);
}

async function getUserById(userId) {
  if (!userId) return undefined;
  const users = await readUsers();
  return users.find((user) => user.id === userId);
}

async function createUser({ username, passwordHash, role = 'user' }) {
  const normalized = normalizeUsername(username || '');
  if (!normalized) {
    throw new Error('Username is required');
  }
  if (!passwordHash) {
    throw new Error('Password hash is required');
  }
  const users = await readUsers();
  if (users.some((user) => normalizeUsername(user.username) === normalized)) {
    const error = new Error('Username already exists');
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const newUser = {
    id: crypto.randomUUID(),
    username: username.trim(),
    passwordHash,
    role: role || 'user',
    createdAt: now,
    disabled: false
  };
  users.push(newUser);
  await writeUsers(users);
  return newUser;
}

async function updateUser(userId, patch = {}) {
  if (!userId) {
    throw new Error('User id is required');
  }
  const users = await readUsers();
  const index = users.findIndex((user) => user.id === userId);
  if (index === -1) {
    throw new Error('User not found');
  }
  const updated = { ...users[index], ...patch };
  users[index] = updated;
  await writeUsers(users);
  return updated;
}

module.exports = {
  getAllUsers,
  getUserByUsername,
  getUserById,
  createUser,
  updateUser
};
