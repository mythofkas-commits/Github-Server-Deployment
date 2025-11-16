const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('./lib/config');
const projectStore = require('./lib/projectStore');
const deploymentStore = require('./lib/deploymentStore');
const deployEngine = require('./lib/deployEngine');
const { validateProjectPayload, parseGitHubRepo } = require('./lib/projectValidator');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(bodyParser.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

const pathExists = async (candidate) => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const slugifyProjectId = (owner, repoName) =>
  `${owner}-${repoName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') ||
  `project-${Date.now()}`;

const presentEnv = (envArray = []) => {
  if (!Array.isArray(envArray)) return [];
  return envArray
    .map((entry) => {
      if (!entry || !entry.key) return null;
      if (entry.isSecret) {
        return {
          key: entry.key,
          isSecret: true,
          hasValue: !!entry.encryptedValue
        };
      }
      const value = entry.value != null ? String(entry.value) : '';
      return {
        key: entry.key,
        value,
        isSecret: false,
        hasValue: value.length > 0
      };
    })
    .filter(Boolean);
};

const presentProject = (project) => {
  if (!project) return null;
  const clone = { ...project };
  if (Array.isArray(clone.env)) {
    clone.env = presentEnv(clone.env);
  }
  return clone;
};

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      github_username: config.GITHUB_USERNAME,
      projects_dir: config.PROJECTS_DIR
    }
  });
});

app.get('/api/projects', async (req, res) => {
  try {
    const projects = await projectStore.listProjects();
    res.json(projects.map(presentProject));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:projectId', async (req, res) => {
  try {
    const project = await projectStore.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(presentProject(project));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/import', async (req, res) => {
  const payload = req.body || {};
  const repoMeta = parseGitHubRepo(payload.repoUrl);
  if (!repoMeta) {
    return res.status(400).json({ error: 'Valid GitHub repository URL is required' });
  }
  const projectId = slugifyProjectId(repoMeta.owner, repoMeta.repoName);
  const projectDir = path.join(config.PROJECTS_DIR, projectId);
  if (await pathExists(projectDir)) {
    return res.status(409).json({ error: 'Project already exists' });
  }
  const repoDir = path.join(projectDir, 'repo');
  try {
    await fs.mkdir(projectDir, { recursive: true });
    const cloneUrl = `${repoMeta.cleanUrl}.git`;
    await projectStore.ensureProjectDirs(projectId);
    const { project: validated } = validateProjectPayload(
      { ...payload, repoUrl: repoMeta.cleanUrl },
      { partial: false, projectId }
    );
    const branchName = validated.branch || 'main';
    await execFileAsync('git', ['clone', '--depth', '1', '--branch', branchName, cloneUrl, repoDir]);
    const stack = [];
    if (await pathExists(path.join(repoDir, 'package.json'))) stack.push('Node.js');
    if (await pathExists(path.join(repoDir, 'requirements.txt'))) stack.push('Python');
    const projectConfig = {
      name: validated.name || repoMeta.repoName,
      description: validated.description || '',
      repo: validated.repo || repoMeta.cleanUrl,
      branch: branchName,
      target: validated.target || 'server',
      buildCommand: validated.buildCommand || payload.buildCommand || 'npm run build',
      buildOutput: validated.buildOutput || payload.buildOutput || config.DEFAULT_BUILD_OUTPUT,
      installCommand: validated.installCommand ?? payload.installCommand ?? '',
      testCommand: validated.testCommand ?? payload.testCommand ?? '',
      startCommand: validated.startCommand ?? payload.startCommand ?? '',
      runtime: validated.runtime || payload.runtime || 'static',
      domain: validated.domain ?? payload.domain ?? '',
      port: Object.prototype.hasOwnProperty.call(validated, 'port') ? validated.port : (payload.port ? Number.parseInt(payload.port, 10) : null),
      deployPath: validated.deployPath,
      stack: Array.from(new Set(stack)),
      env: validated.env || [],
      createdAt: new Date().toISOString(),
      status: 'imported',
      lastDeploy: null
    };
    await projectStore.saveProject(projectId, projectConfig);
    const stored = await projectStore.getProject(projectId);
    res.status(201).json(presentProject(stored));
  } catch (error) {
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/projects/:projectId', async (req, res) => {
  try {
    const existing = await projectStore.getProject(req.params.projectId);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const { project: updates } = validateProjectPayload(req.body || {}, {
      partial: true,
      projectId: req.params.projectId,
      existing
    });
    if (Object.keys(updates).length === 0) {
      return res.json(presentProject(existing));
    }
    const repoChanged = updates.repo && updates.repo !== existing.repo;
    const next = await projectStore.updateProject(req.params.projectId, {
      ...updates,
      updatedAt: new Date().toISOString()
    });
    if (repoChanged) {
      await fs.rm(projectStore.repoDir(req.params.projectId), { recursive: true, force: true }).catch(() => {});
    }
    res.json(presentProject(next));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/projects/:projectId/deploy', async (req, res) => {
  try {
    const result = await deployEngine.queueDeployment(req.params.projectId, { dryRun: !!req.body?.dryRun });
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/projects/:projectId/deployments', async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit || '10', 10);
    const deployments = await deploymentStore.listDeployments(req.params.projectId, limit);
    res.json(deployments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deployments/:deploymentId', async (req, res) => {
  try {
    const deployment = await deploymentStore.getDeployment(req.params.deploymentId);
    if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
    res.json(deployment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deployments/:deploymentId/log', async (req, res) => {
  try {
    const deployment = await deploymentStore.getDeployment(req.params.deploymentId);
    if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
    const log = await fs.readFile(deployment.logPath, 'utf8').catch(() => '');
    res.header('Content-Type', 'text/plain').send(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:projectId/rollback', async (req, res) => {
  try {
    await deployEngine.rollbackProject(req.params.projectId);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function initialize() {
  const dirs = [config.PROJECTS_DIR, config.BUILD_DIR, config.LOGS_DIR];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
  console.log('API initialized');
}

initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
});
