#!/usr/bin/env node
/**
 * Enables the repo's shared git hooks.
 *
 * Wired to package.json's "prepare" script, so it runs automatically on
 * `npm install` / `npm ci` -- which is the first thing anyone does after cloning.
 * Git itself has no post-clone hook and cannot self-enable hooks from repo
 * contents (that would be remote code execution), so this is the closest
 * practical equivalent.
 *
 * Deliberately fails soft: it must never break `npm install`. If git is absent,
 * or this is a tarball rather than a checkout, it exits 0 quietly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const DESIRED = '.githooks';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

try {
  // Only act inside a real checkout that actually carries the hooks.
  try { git(['rev-parse', '--is-inside-work-tree']); }
  catch { process.exit(0); }                       // not a git checkout (tarball, CI cache)
  if (!existsSync(DESIRED)) process.exit(0);       // hooks not present in this repo

  let current = '';
  try { current = git(['config', '--get', 'core.hooksPath']); } catch { /* unset */ }

  if (current === DESIRED) process.exit(0);        // already enabled, stay quiet

  git(['config', 'core.hooksPath', DESIRED]);
  console.log(`security: git hooks enabled (core.hooksPath=${DESIRED})`);
  if (current) console.log(`security: note - previous core.hooksPath was "${current}"`);
} catch {
  // Never fail the install over this.
  process.exit(0);
}
