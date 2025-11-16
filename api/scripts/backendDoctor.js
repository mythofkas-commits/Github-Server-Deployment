#!/usr/bin/env node
/**
 * Backend Doctor
 *
 * Runs a suite of platform diagnostics:
 *   - Registry/config validation
 *   - Filesystem/git/symlink checks
 *   - nginx config presence + global nginx -t
 *   - pm2 process state (for runtime apps)
 *   - Deployment history/log presence
 *
 * Usage:
 *   cd api
 *   SECRETS_MASTER_KEY=... npm run doctor:backend
 *
 * Secrets are never printed. Only metadata/status information is displayed.
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../lib/config');
const projectStore = require('../lib/projectStore');
const deploymentStore = require('../lib/deploymentStore');
const { runCommand } = require('../lib/command');

const statusOrder = { OK: 0, WARN: 1, ERROR: 2 };
const combineStatus = (...statuses) =>
  statuses.reduce((acc, curr) => (statusOrder[curr] > statusOrder[acc] ? curr : acc), 'OK');

const projectReport = [];
const summary = { OK: 0, WARN: 0, ERROR: 0 };

const formatStatus = (status, message) => `[${status}] ${message}`;

const checkConfig = () => {
  const messages = [];
  let status = 'OK';
  if (!config.SECRETS_MASTER_KEY) {
    messages.push('SECRETS_MASTER_KEY missing – secrets unusable');
    status = 'ERROR';
  } else if (config.SECRETS_MASTER_KEY === 'test-master-key') {
    messages.push('SECRETS_MASTER_KEY is set to test-master-key (do not use in prod)');
    status = 'WARN';
  }
  messages.push(`projects_dir=${config.PROJECTS_DIR}`);
  messages.push(`nginx_root=${config.NGINX_ROOT}`);
  return { status, messages };
};

const checkGitRepo = async (projectId, repoPath) => {
  try {
    await fs.stat(path.join(repoPath, '.git'));
  } catch {
    return { status: 'WARN', message: 'No .git directory present' };
  }
  try {
    await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repoPath }, null, false);
    return { status: 'OK', message: 'Git repo healthy' };
  } catch (err) {
    return { status: 'WARN', message: `Git command failed (${err.message})` };
  }
};

const checkFilesystem = async (project, projectPaths) => {
  const details = [];
  let status = 'OK';
  const ensure = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      details.push(`${label}: ${error.message}`);
      status = status === 'ERROR' ? status : 'WARN';
    }
  };
  await ensure('project root', () => fs.stat(projectPaths.root));
  const gitResult = await checkGitRepo(project.id, projectPaths.repo);
  status = combineStatus(status, gitResult.status);
  details.push(`git: ${gitResult.message}`);
  await ensure('releases dir', () => fs.stat(projectPaths.releases));
  await ensure('current symlink', async () => {
    const target = await fs.readlink(projectPaths.current);
    await fs.stat(path.resolve(path.dirname(projectPaths.current), target));
  });
  await ensure('previous symlink (optional)', async () => {
    await fs.readlink(projectPaths.previous);
  });
  return { status, details };
};

const nginxPathsForProject = (projectId) => ({
  available: path.join(config.NGINX_SITES_AVAILABLE, `deployer-${projectId}.conf`),
  enabled: path.join(config.NGINX_SITES_ENABLED, `deployer-${projectId}.conf`)
});

const checkNginxForProject = async (paths) => {
  let status = 'OK';
  const details = [];
  try {
    await fs.stat(paths.available);
    details.push(`config: ${paths.available}`);
  } catch {
    status = 'WARN';
    details.push('config missing');
  }
  try {
    const target = await fs.readlink(paths.enabled);
    details.push(`enabled -> ${target}`);
  } catch {
    status = status === 'ERROR' ? status : 'WARN';
    details.push('sites-enabled symlink missing');
  }
  return { status, details };
};

const loadPm2List = async () => {
  try {
    const result = await runCommand('pm2', ['jlist'], {}, null, false);
    const list = JSON.parse(result.stdout || '[]');
    const map = new Map();
    list.forEach((proc) => {
      if (proc?.name) map.set(proc.name, proc);
    });
    return { status: 'OK', map };
  } catch (error) {
    return { status: 'WARN', map: new Map(), message: `Unable to inspect pm2 (${error.message})` };
  }
};

const checkPm2ForProject = (project, pm2Map) => {
  if ((project.runtime || 'static') !== 'node') {
    return { status: 'OK', details: ['runtime not node – pm2 not required'] };
  }
  const proc = pm2Map.get(project.id);
  if (!proc) {
    return { status: 'WARN', details: ['pm2 process not found'] };
  }
  const status = proc.pm2_env?.status || 'unknown';
  const cwd = proc.pm2_env?.pm_cwd || 'unknown';
  const finalStatus = status === 'online' ? 'OK' : 'WARN';
  return { status: finalStatus, details: [`pm2 status=${status}`, `cwd=${cwd}`] };
};

const checkDeployments = async (projectId) => {
  const deployments = await deploymentStore.listDeployments(projectId, 5);
  if (!deployments.length) {
    return { status: 'WARN', details: ['No deployments found'] };
  }
  const latest = deployments[0];
  const details = [
    `latest status=${latest.status}`,
    `started=${latest.startedAt || latest.createdAt}`
  ];
  if (latest.logPath) {
    try {
      await fs.stat(latest.logPath);
      details.push('log file present');
    } catch {
      details.push('log file missing');
      return { status: 'WARN', details };
    }
  }
  if (latest.status === 'failed') {
    return { status: 'WARN', details };
  }
  return { status: 'OK', details };
};

const checkRegistry = (project) => {
  const required = ['repo', 'branch', 'buildCommand', 'deployPath'];
  const missing = required.filter((field) => !project[field]);
  const details = [];
  let status = 'OK';
  if (missing.length) {
    status = 'ERROR';
    details.push(`Missing fields: ${missing.join(', ')}`);
  }
  if ((project.runtime || 'static') === 'node' && !project.startCommand) {
    status = combineStatus(status, 'ERROR');
    details.push('Node runtime requires startCommand');
  }
  const envEntries = Array.isArray(project.env) ? project.env : [];
  const secrets = envEntries.filter((entry) => entry?.isSecret).length;
  const nonSecrets = envEntries.length - secrets;
  details.push(`env: ${nonSecrets} non-secret, ${secrets} secret`);
  return { status, details };
};

const printSection = (title, checks) => {
  console.log(`\nProject ${title}`);
  for (const [name, result] of Object.entries(checks)) {
    result.details.forEach((detail, idx) => {
      const prefix = idx === 0 ? formatStatus(result.status, name) : ' '.repeat(name.length + 4);
      console.log(`${prefix} - ${detail}`);
    });
  }
};

async function main() {
  console.log('=== Backend Doctor ===');
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

  const configReport = checkConfig();
  configReport.messages.forEach((msg) => console.log(formatStatus(configReport.status, msg)));

  let nginxGlobal = { status: 'OK', message: 'nginx -t not run' };
  try {
    await runCommand('nginx', ['-t'], {}, null, false);
    nginxGlobal = { status: 'OK', message: 'nginx -t passed' };
  } catch (error) {
    nginxGlobal = { status: 'WARN', message: `nginx -t failed (${error.message})` };
  }
  console.log(formatStatus(nginxGlobal.status, nginxGlobal.message));

  const pm2Info = await loadPm2List();
  if (pm2Info.message) {
    console.log(formatStatus(pm2Info.status, pm2Info.message));
  } else {
    console.log(formatStatus('OK', `pm2 processes detected: ${pm2Info.map.size}`));
  }

  const projects = await projectStore.listProjects();
  console.log(`\nProjects detected: ${projects.length}`);

  for (const project of projects) {
    const paths = {
      root: projectStore.projectRoot(project.id),
      repo: projectStore.repoDir(project.id),
      releases: projectStore.releasesDir(project.id),
      current: projectStore.currentSymlink(project.id),
      previous: projectStore.previousSymlink(project.id)
    };
    const registry = checkRegistry(project);
    const fsGit = await checkFilesystem(project, paths);
    const nginx = await checkNginxForProject(nginxPathsForProject(project.id));
    const pm2Check = checkPm2ForProject(project, pm2Info.map);
    const deployments = await checkDeployments(project.id);

    const worst = combineStatus(registry.status, fsGit.status, nginx.status, pm2Check.status, deployments.status);
    summary[worst] += 1;

    printSection(project.id + (project.name ? ` (${project.name})` : ''), {
      registry,
      filesystem: fsGit,
      nginx,
      pm2: pm2Check,
      deployments
    });
  }

  console.log('\n=== Summary ===');
  console.log(`Projects checked: ${projects.length}`);
  console.log(`OK: ${summary.OK}`);
  console.log(`WARN: ${summary.WARN}`);
  console.log(`ERROR: ${summary.ERROR}`);
  if (summary.ERROR > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Backend Doctor failed:', error);
  process.exit(1);
});
