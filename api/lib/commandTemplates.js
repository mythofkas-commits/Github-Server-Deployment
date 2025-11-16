const commandTemplates = {
  'node-app': {
    id: 'node-app',
    label: 'Node App (npm)',
    description: 'Runs npm ci, npm run build, and npm start for a typical Node/React app.',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    testCommand: null,
    startCommand: 'npm start'
  },
  'static-spa': {
    id: 'static-spa',
    label: 'Static SPA (npm)',
    description: 'Installs dependencies and builds a static bundle for nginx hosting.',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    testCommand: null,
    startCommand: null
  }
};

const getTemplate = (id) => {
  if (!id) return null;
  return commandTemplates[id] || null;
};

const listTemplates = () =>
  Object.values(commandTemplates).map(({ id, label, description }) => ({ id, label, description }));

module.exports = {
  commandTemplates,
  getTemplate,
  listTemplates
};
