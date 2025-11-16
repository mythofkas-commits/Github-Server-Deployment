const path = require('path');
const config = require('./config');

const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,128}$/;
const TARGETS = new Set(['server', 'github-pages', 'both']);
const RUNTIMES = new Set(['static', 'node']);

const parseGitHubRepo = (input) => {
  if (!input || typeof input !== 'string') return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'github.com' && hostname !== 'www.github.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repoName = segments[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repoName)) return null;
    return {
      owner,
      repoName,
      cleanUrl: `https://github.com/${owner}/${repoName}`
    };
  } catch {
    return null;
  }
};

const resolveDeployPath = (requestedPath, projectId) => {
  const fallback = projectId ? path.join(config.NGINX_ROOT, projectId) : config.NGINX_ROOT;
  const source = typeof requestedPath === 'string' && requestedPath.trim().length > 0
    ? requestedPath.trim()
    : fallback;
  const candidate = source.startsWith('/') ? source : path.join(config.NGINX_ROOT, source);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(config.NGINX_ROOT)) {
    throw new Error('Deploy path must be inside the server root');
  }
  return resolved;
};

const normalizeEnvInput = (envInput) => {
  if (envInput == null) return undefined;
  if (Array.isArray(envInput)) {
    return envInput;
  }
  if (typeof envInput === 'object') {
    return Object.entries(envInput).map(([key, value]) => ({ key, value }));
  }
  throw new Error('Environment variables must be provided as an object or array');
};

const coerceString = (value, field, { required = false } = {}) => {
  if (value == null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed && required) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
};

function validateProjectPayload(payload = {}, options = {}) {
  const partial = !!options.partial;
  const projectId = options.projectId;
  const existing = options.existing || {};
  const project = {};
  let repoMeta = null;

  if (payload.repoUrl !== undefined) {
    repoMeta = parseGitHubRepo(payload.repoUrl);
    if (!repoMeta) throw new Error('Valid GitHub repository URL is required');
    project.repo = repoMeta.cleanUrl;
  } else if (!partial && !existing.repo) {
    throw new Error('Repository URL is required');
  }

  if (payload.name !== undefined) {
    const name = coerceString(payload.name, 'name', { required: true });
    project.name = name;
  } else if (!partial && !existing.name) {
    if (repoMeta?.repoName) {
      project.name = repoMeta.repoName;
    } else {
      throw new Error('Project name is required');
    }
  }

  const branchValue = payload.branch !== undefined
    ? coerceString(payload.branch, 'branch', { required: true })
    : (!partial && !existing.branch ? 'main' : undefined);
  if (branchValue !== undefined) {
    if (!BRANCH_PATTERN.test(branchValue)) throw new Error('Invalid branch name');
    project.branch = branchValue;
  }

  const buildCommandValue = payload.buildCommand !== undefined
    ? coerceString(payload.buildCommand, 'buildCommand', { required: true })
    : (!partial && !existing.buildCommand ? 'npm run build' : undefined);
  if (buildCommandValue !== undefined) {
    project.buildCommand = buildCommandValue;
  }

  if (payload.buildOutput !== undefined) {
    project.buildOutput = coerceString(payload.buildOutput, 'buildOutput', { required: true });
  } else if (!partial && !existing.buildOutput) {
    project.buildOutput = config.DEFAULT_BUILD_OUTPUT;
  }

  if (payload.installCommand !== undefined) {
    project.installCommand = coerceString(payload.installCommand, 'installCommand') || '';
  }
  if (payload.testCommand !== undefined) {
    project.testCommand = coerceString(payload.testCommand, 'testCommand') || '';
  }
  if (payload.startCommand !== undefined) {
    project.startCommand = coerceString(payload.startCommand, 'startCommand') || '';
  }
  if (payload.description !== undefined) {
    project.description = coerceString(payload.description, 'description') || '';
  }

  if (payload.deployPath !== undefined || (!partial && !existing.deployPath)) {
    project.deployPath = resolveDeployPath(payload.deployPath, projectId);
  }

  if (payload.runtime !== undefined) {
    const runtime = coerceString(payload.runtime, 'runtime', { required: true }).toLowerCase();
    if (!RUNTIMES.has(runtime)) throw new Error('Runtime must be "static" or "node"');
    project.runtime = runtime;
  } else if (!partial && !existing.runtime) {
    project.runtime = 'static';
  }

  if (payload.domain !== undefined) {
    project.domain = coerceString(payload.domain, 'domain') || '';
  }
  if (payload.target !== undefined) {
    const target = coerceString(payload.target, 'target', { required: true });
    if (!TARGETS.has(target)) throw new Error('Invalid deployment target');
    project.target = target;
  }
  if (payload.port !== undefined) {
    if (payload.port === null || payload.port === '') {
      project.port = null;
    } else {
      const num = Number(payload.port);
      if (!Number.isInteger(num) || num <= 0) {
        throw new Error('Port must be a positive integer');
      }
      project.port = num;
    }
  }

  if (payload.env !== undefined) {
    const envInput = normalizeEnvInput(payload.env) || [];
    const existingEnv = Array.isArray(existing.env) ? existing.env : [];
    const existingMap = new Map(existingEnv.map((entry) => [entry.key, entry]));
    const sanitizedEnv = [];
    for (const entry of envInput) {
      const key = coerceString(entry?.key, 'env key', { required: true });
      const prev = existingMap.get(key);
      const requestedSecret = entry?.isSecret === true;
      const isSecret = requestedSecret || prev?.isSecret || false;
      if (prev?.isSecret && entry?.isSecret === false) {
        throw new Error(`Cannot convert secret env ${key} to non-secret`);
      }
      const sanitizedEntry = { key, isSecret };
      if (isSecret) {
        const hasValue = entry?.value !== undefined && entry.value !== null && entry.value !== '';
        if (hasValue) {
          sanitizedEntry.value = String(entry.value);
        } else if (!prev?.encryptedValue) {
          throw new Error(`Secret env ${key} requires a value`);
        }
      } else {
        const value = coerceString(entry?.value, `env ${key}`, { required: true });
        sanitizedEntry.value = value;
      }
      sanitizedEnv.push(sanitizedEntry);
      existingMap.delete(key);
    }
    project.env = sanitizedEnv;
  } else if (!partial && !existing.env) {
    project.env = [];
  }

  return { project, repoMeta };
}

module.exports = {
  BRANCH_PATTERN,
  TARGETS,
  RUNTIMES,
  parseGitHubRepo,
  resolveDeployPath,
  normalizeEnvInput,
  validateProjectPayload
};
