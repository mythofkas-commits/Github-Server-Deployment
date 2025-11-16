const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { runCommand } = require('./command');

function renderStaticConfig({ domain, deployPath }) {
  return `
server {
    listen 80;
    server_name ${domain || '_'};

    root ${deployPath};
    index index.html;

    location / {
        try_files $uri /index.html;
    }
}
`.trim();
}

function renderProxyConfig({ domain, proxyPort }) {
  return `
server {
    listen 80;
    server_name ${domain || '_'};

    location / {
        proxy_pass http://127.0.0.1:${proxyPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
`.trim();
}

async function writeConfig(projectId, options, logStream, dryRun = false) {
  if (options.runtime === 'node' && !options.runtimePort) {
    throw new Error('runtimePort is required for node runtime');
  }
  const availablePath = path.join(config.NGINX_SITES_AVAILABLE, `deployer-${projectId}.conf`);
  const enabledPath = path.join(config.NGINX_SITES_ENABLED, `deployer-${projectId}.conf`);
  const content = options.runtime === 'node'
    ? renderProxyConfig({ domain: options.domain, proxyPort: options.runtimePort })
    : renderStaticConfig({ domain: options.domain, deployPath: options.deployPath });

  if (logStream) logStream.write(`Writing nginx config ${availablePath}\n`);
  if (!dryRun) {
    await fs.mkdir(config.NGINX_SITES_AVAILABLE, { recursive: true });
    await fs.mkdir(config.NGINX_SITES_ENABLED, { recursive: true });
    await fs.writeFile(availablePath, content);
    await fs.symlink(availablePath, enabledPath).catch(async (err) => {
      if (err.code === 'EEXIST') {
        const target = await fs.readlink(enabledPath).catch(() => null);
        if (target !== availablePath) {
          await fs.unlink(enabledPath);
          await fs.symlink(availablePath, enabledPath);
        }
        return;
      }
      throw err;
    });
  }

  await runCommand('nginx', ['-t'], {}, logStream, dryRun);
  await runCommand('systemctl', ['reload', 'nginx'], {}, logStream, dryRun);
}

module.exports = {
  writeConfig
};
