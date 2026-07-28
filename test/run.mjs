/**
 * Test runner: gives each suite a throwaway server on its own port and its own
 * SQLite file, so suites never see each other's data.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const suites = ['base.e2e.mjs', 'multisite.e2e.mjs'];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return true;
    } catch {}
    await wait(150);
  }
  return false;
}

let failures = 0;

for (const [i, suite] of suites.entries()) {
  const port = 3100 + i;
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdesk-test-'));

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), QDESK_DATA_DIR: dataDir },
    stdio: 'ignore',
  });

  console.log(`\n▶ ${suite}`);
  const up = await waitForHealth(base);
  if (!up) {
    console.log('  ❌ server did not start');
    failures++;
    server.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
    continue;
  }

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, suite)], {
      cwd: ROOT,
      env: { ...process.env, BASE: base },
      stdio: 'inherit',
    });
    child.on('exit', resolve);
  });

  if (code !== 0) failures++;
  server.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} suite(s) failed` : '\n✓ all suites passed');
process.exit(failures ? 1 : 0);
