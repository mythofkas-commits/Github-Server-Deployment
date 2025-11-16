const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { encryptSecret } = require('./secrets');

const projectRoot = (projectId) => path.join(config.PROJECTS_DIR, projectId);
const repoDir = (projectId) => path.join(projectRoot(projectId), 'repo');
const configPath = (projectId) => path.join(projectRoot(projectId), 'deploy-config.json');
const deploymentsDir = (projectId) => path.join(projectRoot(projectId), 'deployments');
const releasesDir = (projectId) => path.join(projectRoot(projectId), config.RELEASES_DIR_NAME);
const currentSymlink = (projectId) => path.join(projectRoot(projectId), 'current');
const previousSymlink = (projectId) => path.join(projectRoot(projectId), 'previous');

const normalizeStoredEnv = (rawEnv) => {
  if (!rawEnv) return [];
  if (Array.isArray(rawEnv)) {
    return rawEnv
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || !entry.key) return null;
        const normalized = {
          key: entry.key,
          isSecret: !!entry.isSecret
        };
        if (normalized.isSecret) {
          normalized.encryptedValue = entry.encryptedValue || null;
        } else {
          const value = entry.value;
          normalized.value = value != null ? String(value) : '';
        }
        return normalized;
      })
      .filter(Boolean);
  }
  if (typeof rawEnv === 'object') {
    return Object.entries(rawEnv).map(([key, value]) => ({
      key,
      value: value != null ? String(value) : '',
      isSecret: false
    }));
  }
  return [];
};

const formatEnvForStorage = (existingEnv = [], updates) => {
  if (updates === undefined) {
    return existingEnv.map((entry) => ({ ...entry }));
  }
  const existingMap = new Map(existingEnv.map((entry) => [entry.key, entry]));
  const next = [];
  for (const entry of updates) {
    if (!entry || !entry.key) continue;
    const prev = existingMap.get(entry.key);
    if (entry.isSecret) {
      let encryptedValue = prev?.encryptedValue || null;
      if (entry.value !== undefined) {
        encryptedValue = encryptSecret(entry.value);
      }
      if (!encryptedValue) {
        throw new Error(`Secret env ${entry.key} requires a value`);
      }
      next.push({ key: entry.key, isSecret: true, encryptedValue });
    } else {
      next.push({ key: entry.key, isSecret: false, value: entry.value ?? '' });
    }
    existingMap.delete(entry.key);
  }
  return next;
};

const writeProject = async (projectId, payload) => {
  await fs.mkdir(projectRoot(projectId), { recursive: true });
  const { id: _removed, ...rest } = payload || {};
  await fs.writeFile(configPath(projectId), JSON.stringify(rest, null, 2));
};

async function ensureProjectDirs(projectId) {
  await fs.mkdir(projectRoot(projectId), { recursive: true });
  await fs.mkdir(repoDir(projectId), { recursive: true });
  await fs.mkdir(deploymentsDir(projectId), { recursive: true });
  await fs.mkdir(releasesDir(projectId), { recursive: true });
}

async function listProjects() {
  const dirs = await fs.readdir(config.PROJECTS_DIR).catch(() => []);
  const projects = [];
  for (const dir of dirs) {
    const file = configPath(dir);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      data.env = normalizeStoredEnv(data.env);
      data.ownerId = data.ownerId || 'admin';
      data.templateId = data.templateId ?? null;
      projects.push({ id: dir, ...data });
    } catch {
      // ignore invalid project
    }
  }
  return projects;
}

async function getProject(projectId) {
  try {
    const raw = await fs.readFile(configPath(projectId), 'utf8');
    const data = JSON.parse(raw);
    data.env = normalizeStoredEnv(data.env);
    data.ownerId = data.ownerId || 'admin';
    data.templateId = data.templateId ?? null;
    return { id: projectId, ...data };
  } catch {
    return null;
  }
}

async function saveProject(projectId, data) {
  const envUpdates = Array.isArray(data?.env) ? data.env : [];
  const storedEnv = formatEnvForStorage([], envUpdates);
  const ownerId = data?.ownerId || 'admin';
  const templateId = data?.templateId ?? null;
  await writeProject(projectId, { ...data, env: storedEnv, ownerId, templateId });
}

async function updateProject(projectId, updates) {
  const existing = await getProject(projectId);
  if (!existing) {
    throw new Error('Project not found');
  }
  const storedEnv = formatEnvForStorage(existing.env || [], updates.env);
  const next = {
    ...existing,
    ...updates,
    ownerId: updates.ownerId || existing.ownerId || 'admin',
    templateId: Object.prototype.hasOwnProperty.call(updates, 'templateId')
      ? (updates.templateId ?? null)
      : (existing.templateId ?? null),
    env: storedEnv
  };
  await writeProject(projectId, next);
  return next;
}

module.exports = {
  projectRoot,
  repoDir,
  configPath,
  listProjects,
  getProject,
  saveProject,
  updateProject,
  ensureProjectDirs,
  deploymentsDir,
  releasesDir,
  currentSymlink,
  previousSymlink,
  normalizeStoredEnv,
  formatEnvForStorage
};
