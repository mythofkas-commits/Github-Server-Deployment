const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const projectStore = require('./projectStore');

const INDEX_PATH = path.join(config.PROJECTS_DIR, '.deployments-index.json');

async function loadIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveIndex(index) {
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

async function createDeployment(projectId, payload = {}) {
  const deploymentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const baseRecord = {
    deploymentId,
    projectId,
    status: 'queued',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    steps: {},
    commit: null,
    logPath: getLogPath(projectId, deploymentId),
    ...payload
  };
  const dir = projectStore.deploymentsDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getMetaPath(projectId, deploymentId), JSON.stringify(baseRecord, null, 2));
  const index = await loadIndex();
  index[deploymentId] = { projectId };
  await saveIndex(index);
  return baseRecord;
}

const getMetaPath = (projectId, deploymentId) =>
  path.join(projectStore.deploymentsDir(projectId), `${deploymentId}.json`);

const getLogPath = (projectId, deploymentId) =>
  path.join(config.LOGS_DIR, projectId, `${deploymentId}.log`);

async function getDeployment(deploymentId) {
  const index = await loadIndex();
  const info = index[deploymentId];
  if (!info) return null;
  try {
    const raw = await fs.readFile(getMetaPath(info.projectId, deploymentId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function updateDeployment(deploymentId, updates) {
  const record = await getDeployment(deploymentId);
  if (!record) return null;
  const updated = { ...record, ...updates };
  if (updates.steps) {
    updated.steps = { ...(record.steps || {}), ...updates.steps };
  }
  await fs.writeFile(getMetaPath(record.projectId, deploymentId), JSON.stringify(updated, null, 2));
  return updated;
}

async function appendStep(deploymentId, stepName, data) {
  const record = await getDeployment(deploymentId);
  if (!record) return null;
  const steps = record.steps || {};
  const existing = steps[stepName] || {};
  const nextSteps = {
    ...steps,
    [stepName]: { ...existing, ...data }
  };
  return updateDeployment(deploymentId, { steps: nextSteps });
}

async function listDeployments(projectId, limit = 10) {
  const dir = projectStore.deploymentsDir(projectId);
  const files = await fs.readdir(dir).catch(() => []);
  const records = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      records.push(JSON.parse(raw));
    } catch {
      // ignore
    }
  }
  records.sort((a, b) => {
    const aDate = new Date(a.createdAt).getTime();
    const bDate = new Date(b.createdAt).getTime();
    return bDate - aDate;
  });
  return records.slice(0, limit);
}

module.exports = {
  createDeployment,
  getDeployment,
  updateDeployment,
  appendStep,
  listDeployments,
  getLogPath
};
