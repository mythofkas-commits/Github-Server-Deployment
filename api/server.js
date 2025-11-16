const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('./lib/config');
const projectStore = require('./lib/projectStore');
const deploymentStore = require('./lib/deploymentStore');
const deployEngine = require('./lib/deployEngine');
const userStore = require('./lib/userStore');
const { getTemplate, listTemplates } = require('./lib/commandTemplates');
const { validateProjectPayload, parseGitHubRepo } = require('./lib/projectValidator');
const {
  requireAuth,
  setAuthCookie,
  clearAuthCookie,
  getUserFromRequest,
  signSessionToken,
  createUserPayload,
  authenticateCredentials
} = require('./lib/auth');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3001;
const AUTH_USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
const ADMIN_OWNER_ID = 'admin';

app.set('trust proxy', true);
app.use(bodyParser.json());
app.use(cookieParser());

const allowedOrigins = new Set();
if (config.ALLOWED_ORIGIN) {
  allowedOrigins.add(config.ALLOWED_ORIGIN);
}
if (!config.isProduction) {
  ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'].forEach((origin) => {
    if (origin !== config.ALLOWED_ORIGIN) {
      allowedOrigins.add(origin);
    }
  });
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS_ORIGIN_FORBIDDEN'));
  },
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const generalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please slow down.' })
});

const deployLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many deployment requests. Try again later.' })
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' })
});

app.use('/api', generalLimiter);

const sendError = (res, error, defaultStatus = 500) => {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : defaultStatus;
  res.status(status).json({ error: error.message || 'Unexpected error' });
};

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const result = await authenticateCredentials(username, password);
    if (!result) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    setAuthCookie(res, result.token);
    return res.json({ ok: true, user: toPublicUser(result.user) });
  } catch (error) {
    return sendError(res, error, 500);
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/users/signup', authLimiter, async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  if (!AUTH_USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters and include only letters, numbers, ".", "_" or "-".' });
  }
  if (username === config.ADMIN_USERNAME) {
    return res.status(400).json({ error: 'Username not available' });
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long` });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await userStore.createUser({ username, passwordHash, role: 'user' });
    const payload = createUserPayload(user);
    const token = signSessionToken(payload);
    setAuthCookie(res, token);
    return res.status(201).json({
      ok: true,
      user: { id: user.id, username: user.username, role: user.role || 'user', isAdmin: false }
    });
  } catch (error) {
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    return sendError(res, error, 500);
  }
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ authenticated: false });
  }
  return res.json({ authenticated: true, user: toPublicUser(user) });
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

const ownsProject = (project, user) => {
  if (!project || !user) return false;
  if (user.isAdmin) return true;
  return project.ownerId === user.id;
};

const ensureProjectAccess = (project, user, res) => {
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  if (!ownsProject(project, user)) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return project;
};

const toPublicUser = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isAdmin: user.isAdmin
  };
};

const determineOwnerId = (user) => (user && user.isAdmin ? ADMIN_OWNER_ID : user?.id);

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

app.get('/api/command-templates', requireAuth, (req, res) => {
  res.json(listTemplates());
});

app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const projects = await projectStore.listProjects();
    const scoped = req.user.isAdmin ? projects : projects.filter((project) => project.ownerId === req.user.id);
    res.json(scoped.map(presentProject));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:projectId', requireAuth, async (req, res) => {
  try {
    const project = await projectStore.getProject(req.params.projectId);
    const allowed = ensureProjectAccess(project, req.user, res);
    if (!allowed) return;
    res.json(presentProject(allowed));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/import', requireAuth, async (req, res) => {
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
      { partial: false, projectId, isAdmin: !!req.user?.isAdmin, role: req.user?.isAdmin ? 'admin' : 'user' }
    );
    const branchName = validated.branch || 'main';
    const templateId = Object.prototype.hasOwnProperty.call(validated, 'templateId') ? validated.templateId : null;
    const template = templateId ? getTemplate(templateId) : null;
    if (!req.user?.isAdmin && !template) {
      return res.status(400).json({ error: 'A valid command template is required for this project' });
    }
    const pickCommand = (value, fallback) => (value !== undefined ? value : fallback);
    const resolvedInstallCommand = req.user?.isAdmin
      ? pickCommand(validated.installCommand, payload.installCommand ?? '')
      : (template?.installCommand || '');
    const resolvedBuildCommand = req.user?.isAdmin
      ? pickCommand(validated.buildCommand, payload.buildCommand || 'npm run build')
      : (template?.buildCommand || 'npm run build');
    const resolvedTestCommand = req.user?.isAdmin
      ? pickCommand(validated.testCommand, payload.testCommand ?? '')
      : (template?.testCommand || '');
    const resolvedStartCommand = req.user?.isAdmin
      ? pickCommand(validated.startCommand, payload.startCommand ?? '')
      : (template?.startCommand || '');
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
      buildCommand: resolvedBuildCommand,
      buildOutput: validated.buildOutput || payload.buildOutput || config.DEFAULT_BUILD_OUTPUT,
      installCommand: resolvedInstallCommand,
      testCommand: resolvedTestCommand,
      startCommand: resolvedStartCommand,
      runtime: validated.runtime || payload.runtime || 'static',
      domain: validated.domain ?? payload.domain ?? '',
      port: Object.prototype.hasOwnProperty.call(validated, 'port') ? validated.port : (payload.port ? Number.parseInt(payload.port, 10) : null),
      deployPath: validated.deployPath,
      templateId: templateId ?? null,
      ownerId: determineOwnerId(req.user),
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

app.patch('/api/projects/:projectId', requireAuth, async (req, res) => {
  try {
    const existing = await projectStore.getProject(req.params.projectId);
    const allowed = ensureProjectAccess(existing, req.user, res);
    if (!allowed) return;
    const { project: updates } = validateProjectPayload(req.body || {}, {
      partial: true,
      projectId: req.params.projectId,
      existing: allowed,
      isAdmin: !!req.user?.isAdmin,
      role: req.user?.isAdmin ? 'admin' : 'user'
    });
    if (!req.user?.isAdmin) {
      if (Object.prototype.hasOwnProperty.call(updates, 'templateId')) {
        const template = getTemplate(updates.templateId);
        if (!template) {
          return res.status(400).json({ error: 'A valid command template is required' });
        }
        updates.installCommand = template.installCommand || '';
        updates.buildCommand = template.buildCommand || 'npm run build';
        updates.testCommand = template.testCommand || '';
        updates.startCommand = template.startCommand || '';
      } else {
        delete updates.installCommand;
        delete updates.buildCommand;
        delete updates.testCommand;
        delete updates.startCommand;
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.json(presentProject(allowed));
    }
    const repoChanged = updates.repo && updates.repo !== allowed.repo;
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

app.post('/api/projects/:projectId/deploy', deployLimiter, requireAuth, async (req, res) => {
  try {
    const project = await projectStore.getProject(req.params.projectId);
    const allowed = ensureProjectAccess(project, req.user, res);
    if (!allowed) return;
    const result = await deployEngine.queueDeployment(req.params.projectId, { dryRun: !!req.body?.dryRun });
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get('/api/projects/:projectId/deployments', requireAuth, async (req, res) => {
  try {
    const project = await projectStore.getProject(req.params.projectId);
    const allowed = ensureProjectAccess(project, req.user, res);
    if (!allowed) return;
    const limit = Number.parseInt(req.query.limit || '10', 10);
    const deployments = await deploymentStore.listDeployments(req.params.projectId, limit);
    res.json(deployments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deployments/:deploymentId', requireAuth, async (req, res) => {
  try {
    const deployment = await deploymentStore.getDeployment(req.params.deploymentId);
    if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
    const project = await projectStore.getProject(deployment.projectId);
    const allowed = ensureProjectAccess(project, req.user, res);
    if (!allowed) return;
    res.json(deployment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deployments/:deploymentId/log', requireAuth, async (req, res) => {
  try {
    const deployment = await deploymentStore.getDeployment(req.params.deploymentId);
    if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
    const project = await projectStore.getProject(deployment.projectId);
    const allowed = ensureProjectAccess(project, req.user, res);
    if (!allowed) return;
    const log = await fs.readFile(deployment.logPath, 'utf8').catch(() => '');
    res.header('Content-Type', 'text/plain').send(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:projectId/rollback', deployLimiter, requireAuth, async (req, res) => {
  try {
    const project = await projectStore.getProject(req.params.projectId);
    const allowed = ensureProjectAccess(project, req.user, res);
    if (!allowed) return;
    await deployEngine.rollbackProject(req.params.projectId);
    res.json({ status: 'ok' });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.use((err, req, res, next) => {
  if (err?.message === 'CORS_ORIGIN_FORBIDDEN') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  return next(err);
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
