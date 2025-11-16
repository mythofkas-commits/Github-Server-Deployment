const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const config = require('./config');
const projectStore = require('./projectStore');
const deploymentStore = require('./deploymentStore');
const nginxManager = require('./nginxManager');
const { runCommand, runShellCommand } = require('./command');
const { buildEnvMaps } = require('./envBuilder');
const { getTemplate } = require('./commandTemplates');

const queue = [];
let active = 0;
const MAX_CONCURRENT = Math.max(1, config.MAX_CONCURRENT_DEPLOYS || 1);
const MAX_QUEUE_SIZE = Math.max(1, config.MAX_QUEUE_SIZE || 50);
const ADMIN_OWNER_ID = 'admin';

const pathExists = async (target) => {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
};

const ensureWithinBase = (baseDir, candidate, fieldName) => {
  const normalizedBase = path.resolve(baseDir);
  const resolved = path.resolve(normalizedBase, candidate || '.');
  if (resolved === normalizedBase) {
    return resolved;
  }
  if (!resolved.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error(`${fieldName} must stay within the project repository`);
  }
  return resolved;
};

const ensureDeployPathWithinRoot = (deployPath) => {
  const root = path.resolve(config.NGINX_ROOT);
  const resolved = path.resolve(deployPath);
  if (resolved === root) {
    return resolved;
  }
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Deploy path must be inside the nginx root');
  }
  return resolved;
};

const removePath = async (target) => {
  try {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) {
      await fsp.unlink(target);
    } else if (stat.isDirectory()) {
      await fsp.rm(target, { recursive: true, force: true });
    } else {
      await fsp.unlink(target);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

const writeLog = async (projectId, deploymentId) => {
  const logPath = deploymentStore.getLogPath(projectId, deploymentId);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  return fs.createWriteStream(logPath, { flags: 'a' });
};

const closeStream = (stream) => new Promise((resolve) => {
  stream.end(resolve);
});

async function queueDeployment(projectId, options = {}) {
  const project = await projectStore.getProject(projectId);
  if (!project?.deployPath) {
    throw new Error('Project missing deployPath');
  }
  if (!project) {
    throw new Error('Project not found');
  }
  if (!project.repo || !project.branch) {
    throw new Error('Project configuration incomplete (repo and branch required)');
  }
  const ownerIsAdmin = (project.ownerId || ADMIN_OWNER_ID) === ADMIN_OWNER_ID;
  if (ownerIsAdmin) {
    if (!project.buildCommand) {
      throw new Error('Project configuration incomplete (buildCommand required)');
    }
  } else if (!project.templateId) {
    throw new Error('Project missing command template');
  }
  if (!project.deployPath) {
    throw new Error('Project missing deployPath');
  }
  ensureDeployPathWithinRoot(project.deployPath);
  if (queue.length + active >= MAX_QUEUE_SIZE) {
    const error = new Error('Deployment queue is full. Try again later.');
    error.statusCode = 429;
    throw error;
  }

  const deployment = await deploymentStore.createDeployment(projectId, { dryRun: !!options.dryRun });
  queue.push({ deploymentId: deployment.deploymentId, projectId, dryRun: !!options.dryRun });
  processQueue();
  return { deploymentId: deployment.deploymentId, status: 'queued', projectId };
}

async function processQueue() {
  if (active >= MAX_CONCURRENT) return;
  const job = queue.shift();
  if (!job) return;
  active += 1;
  try {
    await runDeployment(job);
  } finally {
    active -= 1;
    if (queue.length > 0) {
      processQueue();
    }
  }
}

async function runDeployment(job) {
  const { deploymentId, projectId, dryRun } = job;
  const logStream = await writeLog(projectId, deploymentId);
  const startTime = new Date().toISOString();
  await deploymentStore.updateDeployment(deploymentId, { status: 'running', startedAt: startTime });
  const project = await projectStore.getProject(projectId);
  const repoPath = path.resolve(projectStore.repoDir(projectId));
  const releasesDir = path.resolve(projectStore.releasesDir(projectId));
  const safeDeployPath = ensureDeployPathWithinRoot(project.deployPath);
  const isAdminProject = (project.ownerId || ADMIN_OWNER_ID) === ADMIN_OWNER_ID;
  const templateCommands = !isAdminProject && project.templateId ? getTemplate(project.templateId) : null;
  if (!isAdminProject && !templateCommands) {
    throw new Error('Command template missing or invalid for this project');
  }

  const envEntries = Array.isArray(project.env) ? project.env : [];
  let env;
  let secretKeys = [];
  try {
    const maps = buildEnvMaps(envEntries);
    env = { ...process.env, ...maps.plainEnv, ...maps.secretEnv };
    secretKeys = maps.secretKeys || [];
  } catch (error) {
    throw new Error(`Failed to decrypt secrets: ${error.message}`);
  }
  const withRedaction = (opts = {}) => (secretKeys.length ? { ...opts, redactKeys: secretKeys } : opts);
  const runtimeType = project.runtime || 'static';
  let runtimePort = null;
  if (runtimeType === 'node') {
    runtimePort = project.runtimePort || project.port || (4000 + Math.floor(Math.random() * 1000));
    if (!project.runtimePort && !dryRun) {
      project.runtimePort = runtimePort;
    }
    env.PORT = String(runtimePort);
  } else if (project.runtimePort || project.port) {
    runtimePort = project.runtimePort || project.port;
  }
  if (!runtimePort && env.PORT) {
    runtimePort = Number(env.PORT);
  }
  if (project.runtimePort) {
    env.PORT = String(project.runtimePort);
  } else if (project.port) {
    env.PORT = String(project.port);
  }

  const runStep = async (name, fn) => {
    const stepStart = new Date().toISOString();
    await deploymentStore.appendStep(deploymentId, name, { status: 'running', startedAt: stepStart });
    try {
      const result = await fn();
      await deploymentStore.appendStep(deploymentId, name, {
        status: 'success',
        finishedAt: new Date().toISOString()
      });
      return result;
    } catch (error) {
      await deploymentStore.appendStep(deploymentId, name, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: error.message
      });
      throw error;
    }
  };

  let commitHash = null;
  let releaseInfo = null;
  try {
    await runStep('sync', async () => {
      const repoExists = await pathExists(path.join(repoPath, '.git'));
      const repoUrl = project.repo.endsWith('.git') ? project.repo : `${project.repo}.git`;
      if (!repoExists) {
        const parent = path.dirname(repoPath);
        if (!dryRun) {
          await fsp.mkdir(parent, { recursive: true });
        }
        await runCommand('git', ['clone', '--branch', project.branch, repoUrl, repoPath], withRedaction(), logStream, dryRun);
      } else {
        await runCommand('git', ['fetch', '--all', '--prune'], withRedaction({ cwd: repoPath }), logStream, dryRun);
        await runCommand('git', ['checkout', project.branch], withRedaction({ cwd: repoPath }), logStream, dryRun);
        await runCommand('git', ['pull', '--ff-only'], withRedaction({ cwd: repoPath }), logStream, dryRun);
      }
      const result = await runCommand('git', ['rev-parse', 'HEAD'], withRedaction({ cwd: repoPath }), logStream, dryRun);
      commitHash = result.stdout.trim();
      await deploymentStore.updateDeployment(deploymentId, { commit: commitHash });
    });

    await runStep('install', async () => {
      let installCmd = null;
      if (isAdminProject) {
        installCmd = project.installCommand;
        if (!installCmd) {
          const lockExists = await pathExists(path.join(repoPath, 'package-lock.json'));
          const pkgExists = await pathExists(path.join(repoPath, 'package.json'));
          if (lockExists) installCmd = 'npm ci';
          else if (pkgExists) installCmd = 'npm install --production';
        }
      } else if (templateCommands) {
        installCmd = templateCommands.installCommand || null;
      }
      if (installCmd) {
        await runShellCommand(installCmd, withRedaction({ cwd: repoPath, env }), logStream, dryRun);
      } else if (logStream) {
        logStream.write('No install command defined, skipping\n');
      }
    });

    await runStep('test', async () => {
      const testCmd = isAdminProject ? project.testCommand : (templateCommands ? templateCommands.testCommand : null);
      if (!testCmd) {
        if (logStream) logStream.write('No test command, skipping\n');
        return;
      }
      await runShellCommand(testCmd, withRedaction({ cwd: repoPath, env }), logStream, dryRun);
    });

    await runStep('build', async () => {
      const buildCmd = isAdminProject
        ? (project.buildCommand || 'npm run build')
        : (templateCommands ? templateCommands.buildCommand : null);
      if (!buildCmd) {
        throw new Error('Build command is not configured for this project/template');
      }
      await runShellCommand(buildCmd, withRedaction({ cwd: repoPath, env }), logStream, dryRun);
    });

    releaseInfo = await runStep('release', async () => {
      const outputDir = project.buildOutputDir || project.buildOutput || config.DEFAULT_BUILD_OUTPUT;
      const absOutput = ensureWithinBase(repoPath, outputDir, 'Build output path');
      if (!dryRun) {
        const exists = await pathExists(absOutput);
        if (!exists) throw new Error(`Build output directory not found: ${absOutput}`);
      }

      const releaseName = `${Date.now()}-${(commitHash || 'latest').slice(0, 7)}`;
      const releasePath = path.join(releasesDir, releaseName);
      if (!dryRun) {
        await fsp.mkdir(releasePath, { recursive: true });
        await fsp.cp(absOutput, releasePath, { recursive: true });
      }

      const currentLink = projectStore.currentSymlink(projectId);
      const previousLink = projectStore.previousSymlink(projectId);
      let previousTarget = null;
      try {
        previousTarget = await fsp.readlink(currentLink);
      } catch {
        // ignore
      }
      if (!dryRun) {
        if (previousTarget) {
          await fsp.rm(previousLink, { force: true }).catch(() => {});
          await fsp.symlink(previousTarget, previousLink).catch(() => {});
        }
        await fsp.rm(currentLink, { force: true }).catch(() => {});
        await fsp.symlink(releasePath, currentLink);
        await fsp.mkdir(path.dirname(safeDeployPath), { recursive: true });
        await removePath(safeDeployPath);
        await fsp.symlink(releasePath, safeDeployPath);
      }
      return { releasePath };
    });

    await runStep('nginx', async () => {
      await nginxManager.writeConfig(projectId, {
        runtime: runtimeType,
        domain: project.domain,
        deployPath: safeDeployPath,
        runtimePort
      }, logStream, dryRun);
    });

    await runStep('runtime', async () => {
      if (runtimeType !== 'node') {
        if (logStream) logStream.write('Runtime not node, skipping pm2\n');
        return;
      }
      const startCmd = isAdminProject ? project.startCommand : (templateCommands ? templateCommands.startCommand : null);
      if (!startCmd) {
        throw new Error('startCommand required for node runtime');
      }
      const currentLink = projectStore.currentSymlink(projectId);
      const currentRelease = dryRun ? releaseInfo.releasePath : await fsp.readlink(currentLink);
      const runtimeEnvVars = { ...env, PORT: runtimePort };
      await runCommand(config.PM2_BIN, [
        'start',
        'bash',
        '--name',
        projectId,
        '--cwd',
        currentRelease,
        '--update-env',
        '--',
        '-lc',
        startCmd
      ], withRedaction({ env: runtimeEnvVars }), logStream, dryRun);
    });

    const finishTime = new Date().toISOString();
    await deploymentStore.updateDeployment(deploymentId, { status: 'success', finishedAt: finishTime });
    const projectUpdate = { lastDeploy: finishTime, lastCommit: commitHash };
    if (project.runtimePort) {
      projectUpdate.runtimePort = project.runtimePort;
    }
    await projectStore.updateProject(projectId, projectUpdate);
  } catch (error) {
    await deploymentStore.updateDeployment(deploymentId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message
    });
    if (logStream) logStream.write(`Deployment failed: ${error.stack || error.message}\n`);
  } finally {
    if (logStream) await closeStream(logStream);
  }
}

async function rollbackProject(projectId) {
  const currentLink = projectStore.currentSymlink(projectId);
  const previousLink = projectStore.previousSymlink(projectId);
  let previousTarget = null;
  try {
    previousTarget = await fsp.readlink(previousLink);
  } catch {
    throw new Error('No previous release to roll back to');
  }
  await fsp.rm(currentLink, { force: true }).catch(() => {});
  await fsp.symlink(previousTarget, currentLink);
  const project = await projectStore.getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.deployPath) throw new Error('Project missing deployPath');
  const safeDeployPath = ensureDeployPathWithinRoot(project.deployPath);
  await removePath(safeDeployPath);
  await fsp.symlink(previousTarget, safeDeployPath);
  await nginxManager.writeConfig(projectId, {
    runtime: project.runtime || 'static',
    domain: project.domain,
    deployPath: safeDeployPath,
    runtimePort: project.runtimePort || project.port
  });
  if ((project.runtime || 'static') === 'node' && project.startCommand) {
    await runCommand(config.PM2_BIN, ['restart', projectId], {}, null, false);
  }
}

module.exports = {
  queueDeployment,
  rollbackProject
};
