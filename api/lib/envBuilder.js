const { decryptSecret } = require('./secrets');

const buildEnvMaps = (envEntries = []) => {
  const plainEnv = {};
  const secretEnv = {};
  const secretKeys = [];
  for (const entry of envEntries) {
    if (!entry || !entry.key) continue;
    if (entry.isSecret) {
      secretKeys.push(entry.key);
      if (entry.encryptedValue) {
        secretEnv[entry.key] = decryptSecret(entry.encryptedValue);
      } else if (entry.value) {
        secretEnv[entry.key] = entry.value;
      } else {
        throw new Error(`Secret env ${entry.key} does not have an encrypted value`);
      }
    } else if (entry.value !== undefined) {
      plainEnv[entry.key] = entry.value;
    }
  }
  return { plainEnv, secretEnv, secretKeys };
};

module.exports = {
  buildEnvMaps
};
