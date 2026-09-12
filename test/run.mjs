/**
 * Test runner. Unit suites run standalone; the API suite gets a throwaway
 * server on its own port with its own database.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const suites = [
  { file: 'indicators.test.mjs', server: false },
  { file: 'source.test.mjs', server: false },
  { file: 'strategy.test.mjs', server: false },
  { file: 'backtest.test.mjs', server: false },
  { file: 'tracker.test.mjs', server: false },
  { file: 'probability.test.mjs', server: false },
  { file: 'quality.test.mjs', server: false },
  { file: 'analytics.test.mjs', server: false },
  { file: 'funding.test.mjs', server: false },
  { file: 'static.test.mjs', server: false },
  { file: 'api.e2e.mjs', server: true },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(base + '/api/status');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await wait(150);
  }
  return false;
}

function runFile(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code));
  });
}

let failures = 0;

for (const suite of suites) {
  console.log(`\n▶ ${suite.file}`);

  if (!suite.server) {
    // Unit suites must never touch a live exchange.
    if (await runFile(suite.file, { COINSCOPE_SOURCE: 'synthetic', COINSCOPE_SYNTHETIC_ANCHOR: 'fixed' }) !== 0) failures++;
    continue;
  }

  const port = 3210;
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinscope-test-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      COINSCOPE_DATA_DIR: dataDir,
      COINSCOPE_SOURCE: 'synthetic',
      COINSCOPE_SYNTHETIC_ANCHOR: 'fixed', // deterministic candles for assertions
      COINSCOPE_NO_LOOP: '1', // the suite drives scans explicitly
    },
    stdio: 'ignore',
  });

  if (!(await waitForHealth(base))) {
    console.log('  ❌ server did not start');
    failures++;
  } else if (await runFile(suite.file, { BASE: base, COINSCOPE_SYNTHETIC_ANCHOR: 'fixed' }) !== 0) {
    failures++;
  }

  server.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} suite(s) failed` : '\n✓ all suites passed');
process.exit(failures ? 1 : 0);
