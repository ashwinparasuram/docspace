#!/usr/bin/env node
// Runs the API server (watch mode, port 4000) and the Vite dev server (port 5173) together.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  ['server', spawn(npm, ['run', 'dev', '-w', 'apps/server'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })],
  ['web', spawn(npm, ['run', 'dev', '-w', 'apps/web'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })],
];

for (const [name, p] of procs) {
  const prefix = name === 'server' ? '\x1b[36m[server]\x1b[0m ' : '\x1b[35m[web]\x1b[0m    ';
  const pipe = (stream, out) => stream.on('data', (d) => out.write(String(d).split('\n').filter(Boolean).map((l) => prefix + l).join('\n') + '\n'));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    for (const [, other] of procs) if (other !== p) other.kill();
    process.exit(code ?? 0);
  });
}

console.log('\nDocSpace dev: open http://localhost:5173 (API on http://localhost:4000)\n');
process.on('SIGINT', () => procs.forEach(([, p]) => p.kill()));
