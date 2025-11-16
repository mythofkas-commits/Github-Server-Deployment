#!/usr/bin/env node
const projectStore = require('../lib/projectStore');
const { buildEnvMaps } = require('../lib/envBuilder');

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error('Usage: node api/scripts/inspectRuntimeEnv.js <project-id>');
    process.exit(1);
  }
  const project = await projectStore.getProject(projectId);
  if (!project) {
    console.error(`Project ${projectId} not found.`);
    process.exit(1);
  }
  const envEntries = Array.isArray(project.env) ? project.env : [];
  let maps;
  try {
    maps = buildEnvMaps(envEntries);
  } catch (error) {
    console.error(`Failed to build env maps: ${error.message}`);
    process.exit(1);
  }
  const keys = new Set(Object.keys(process.env));
  Object.keys(maps.plainEnv || {}).forEach((key) => keys.add(key));
  Object.keys(maps.secretEnv || {}).forEach((key) => keys.add(key));
  if ((project.runtime || 'static') === 'node') {
    keys.add('PORT');
  }
  console.log(`Runtime env keys for project ${projectId}:`);
  Array.from(keys).sort().forEach((key) => console.log(`  - ${key}`));
}

main().catch((error) => {
  console.error('inspectRuntimeEnv failed:', error);
  process.exit(1);
});
