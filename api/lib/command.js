const { spawn } = require('child_process');

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const redactText = (text, keys = []) => {
  if (!keys || keys.length === 0) return text;
  let result = text;
  for (const key of keys) {
    if (!key) continue;
    const pattern = new RegExp(`${escapeRegExp(key)}=([^\\s]+)`, 'gi');
    result = result.replace(pattern, `${key}=[redacted]`);
  }
  return result;
};

function runCommand(cmd, args = [], options = {}, logStream, dryRun = false) {
  const { redactKeys = [], ...spawnOptions } = options || {};
  const commandString = [cmd, ...args].join(' ');
  const safeCommand = redactText(commandString, redactKeys);
  if (dryRun) {
    if (logStream) logStream.write(`[dry-run] ${safeCommand}\n`);
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      shell: false
    });
    let stdout = '';
    let stderr = '';

    const write = (data) => {
      const text = redactText(data.toString(), redactKeys);
      if (logStream) logStream.write(text);
      return text;
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      write(data);
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      write(data);
    });
    child.on('error', (err) => {
      if (logStream) logStream.write(`Command failed: ${safeCommand}\n${err.stack || err}\n`);
      reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error(`Command "${safeCommand}" exited with code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function runShellCommand(script, options = {}, logStream, dryRun = false) {
  return runCommand('bash', ['-lc', script], options, logStream, dryRun);
}

module.exports = {
  runCommand,
  runShellCommand
};
