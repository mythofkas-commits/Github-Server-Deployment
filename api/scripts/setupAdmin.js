#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', '.env');
const SALT_ROUNDS = 12;

const stdoutWrite = process.stdout.write.bind(process.stdout);
const mutedStdout = new Writable({
  write(chunk, encoding, callback) {
    if (!mutedStdout.muted) {
      stdoutWrite(chunk, encoding);
    }
    callback();
  },
});

const rl = readline.createInterface({
  input: process.stdin,
  output: mutedStdout,
  terminal: true,
});

rl.on('SIGINT', () => {
  stdoutWrite('\nSetup aborted by user.\n');
  process.exit(1);
});

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    return '';
  }
  return fs.readFileSync(ENV_PATH, 'utf8');
}

function getEnvValue(content, key) {
  const regex = new RegExp(`^${key}=(.*)$`, 'm');
  const match = content.match(regex);
  return match ? match[1] : '';
}

function upsertEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  const needsNewline = content.length && !content.endsWith('\n');
  return `${content}${needsNewline ? '\n' : ''}${line}\n`;
}

function ask(question, defaultValue = '') {
  const prompt = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

function askYesNo(question, defaultToYes = false) {
  const suffix = defaultToYes ? ' [Y/n] ' : ' [y/N] ';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}`, (answer) => {
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultToYes);
        return;
      }
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    mutedStdout.muted = true;
    rl.question(`${question}: `, (answer) => {
      mutedStdout.muted = false;
      stdoutWrite('\n');
      resolve(answer.trim());
    });
  });
}

function ensureSessionSecret(secret) {
  if (secret && secret.length >= 16) {
    return secret;
  }
  return crypto.randomBytes(32).toString('hex');
}

async function collectPassword(existingHash) {
  if (existingHash) {
    const replace = await askYesNo('An admin password already exists. Replace it?', false);
    if (!replace) {
      return existingHash;
    }
  }

  while (true) {
    const password = await askHidden('Enter new admin password');
    if (!password) {
      stdoutWrite('Password cannot be empty.\n');
      continue;
    }
    const confirm = await askHidden('Confirm password');
    if (password !== confirm) {
      stdoutWrite('Passwords do not match. Try again.\n');
      continue;
    }
    return bcrypt.hashSync(password, SALT_ROUNDS);
  }
}

async function main() {
  stdoutWrite('\nDeployment Dashboard Admin Setup\n');
  stdoutWrite('--------------------------------\n');
  stdoutWrite('This wizard updates api/.env with secure admin credentials.\n\n');

  let envContent = readEnvFile();
  const existingUsername = getEnvValue(envContent, 'ADMIN_USERNAME') || 'admin';
  const existingHash = getEnvValue(envContent, 'ADMIN_PASSWORD_HASH');
  const existingSessionSecret = getEnvValue(envContent, 'SESSION_SECRET');

  const username = await ask('Admin username', existingUsername);
  const passwordHash = await collectPassword(existingHash);

  let sessionSecret = existingSessionSecret;
  if (sessionSecret) {
    const regenerate = await askYesNo('Keep existing SESSION_SECRET?', true);
    if (!regenerate) {
      sessionSecret = '';
    }
  }
  sessionSecret = ensureSessionSecret(sessionSecret);

  envContent = upsertEnvValue(envContent, 'ADMIN_USERNAME', username);
  envContent = upsertEnvValue(envContent, 'ADMIN_PASSWORD_HASH', passwordHash);
  envContent = upsertEnvValue(envContent, 'SESSION_SECRET', sessionSecret);

  fs.writeFileSync(ENV_PATH, envContent, 'utf8');

  stdoutWrite('\nAdmin credentials updated successfully!\n');
  stdoutWrite(`- ADMIN_USERNAME set to "${username}"\n`);
  stdoutWrite('- ADMIN_PASSWORD_HASH refreshed\n');
  stdoutWrite('- SESSION_SECRET ensured to be strong\n');
  stdoutWrite(`\nStored in ${ENV_PATH}\n`);

  rl.close();
}

main().catch((err) => {
  console.error('\nFailed to complete setup:', err);
  process.exit(1);
});
