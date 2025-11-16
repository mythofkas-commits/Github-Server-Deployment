#!/usr/bin/env node
/**
 * Secrets Doctor
 *
 * Manual test plan:
 * 1. Ensure SECRETS_MASTER_KEY is set (e.g. export SECRETS_MASTER_KEY=...).
 * 2. Import or configure a project with both plain and secret env vars.
 * 3. Run `node api/scripts/secretsDoctor.js` – it should report all envs OK.
 * 4. Optionally corrupt a stored encryptedValue to confirm doctor reports an error.
 */

const config = require('../lib/config');
const projectStore = require('../lib/projectStore');
const { decryptSecret } = require('../lib/secrets');

const warn = (msg) => console.warn(`[doctor] ${msg}`);
const log = (msg) => console.log(msg);

async function main() {
  const projects = await projectStore.listProjects();
  const summary = {
    projectsChecked: projects.length,
    envChecked: 0,
    issues: 0
  };

  log('=== Secrets Doctor ===');
  log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  if (!config.SECRETS_MASTER_KEY) {
    warn('SECRETS_MASTER_KEY is not set – secret env vars cannot be decrypted.');
  } else if (config.SECRETS_MASTER_KEY === 'test-master-key') {
    warn('SECRETS_MASTER_KEY is set to "test-master-key" – do not use this in production.');
  } else {
    log('SECRETS_MASTER_KEY present.');
  }
  log(`Projects detected: ${projects.length}`);

  for (const project of projects) {
    log(`\nProject ${project.id}${project.name ? ` (${project.name})` : ''}:`);
    const envEntries = Array.isArray(project.env) ? project.env : [];
    if (!envEntries.length) {
      log('  (no env vars)');
      continue;
    }
    for (const entry of envEntries) {
      summary.envChecked += 1;
      if (!entry || !entry.key) {
        warn('  Encountered env entry with no key.');
        summary.issues += 1;
        continue;
      }
      if (entry.isSecret) {
        if (!entry.encryptedValue) {
          warn(`  ENV ${entry.key}: ERROR – secret is missing encryptedValue`);
          summary.issues += 1;
          continue;
        }
        try {
          decryptSecret(entry.encryptedValue);
          log(`  ENV ${entry.key}: secret OK`);
        } catch (error) {
          warn(`  ENV ${entry.key}: ERROR – could not decrypt (${error.message})`);
          summary.issues += 1;
        }
      } else if (entry.value == null) {
        warn(`  ENV ${entry.key}: ERROR – non-secret env missing value`);
        summary.issues += 1;
      } else {
        log(`  ENV ${entry.key}: non-secret OK`);
      }
    }
  }

  log('\n=== Summary ===');
  log(`Projects checked: ${summary.projectsChecked}`);
  log(`Env vars checked: ${summary.envChecked}`);
  if (summary.issues === 0) {
    log('All checks passed ✅');
  } else {
    warn(`${summary.issues} issue(s) detected. See details above.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[doctor] Unexpected error:', error);
  process.exit(1);
});
