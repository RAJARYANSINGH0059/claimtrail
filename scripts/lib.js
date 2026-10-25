'use strict';
// Shared helper for smoke scripts: starts the real server as a child process on a free port with a throwaway data file.
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer({ dataFile } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimtrail-smoke-'));
  const file = dataFile || path.join(dir, 'state.json');
  const logs = [];
  const spawnIt = () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAIMTRAIL_DATA: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(String(d)));
    child.stderr.on('data', (d) => logs.push('[stderr] ' + d));
    return child;
  };
  let child = spawnIt();
  const url = `http://127.0.0.1:${port}`;
  const waitUp = async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(url + '/api/health')).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start:\n' + logs.join(''));
  };
  await waitUp();
  const stop = () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
  return {
    url, file, logs, stop,
    async restart() { await stop(); child = spawnIt(); await waitUp(); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function reporter(title) {
  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
    catch (e) { results.push({ name, ok: false, err: e }); console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`); }
  };
  const done = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${title}: ${results.length - failed.length}/${results.length} steps passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
    return failed.length ? 1 : 0;
  };
  return { step, done, results };
}

module.exports = { startServer, reporter, freePort };
