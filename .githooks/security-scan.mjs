#!/usr/bin/env node
/**
 * Static supply-chain / injected-payload scanner.
 *
 * Reads source files as TEXT and matches patterns. It never imports, requires,
 * evaluates, executes, installs or builds anything from the repository.
 *
 *   node .github/scripts/security-scan.mjs            scan the working tree
 *   node .github/scripts/security-scan.mjs --self-test verify detection works
 *   node .github/scripts/security-scan.mjs --strict    also fail on warnings
 *
 * Exit 0 = clean, exit 1 = blocking finding, exit 2 = self-test failed.
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');
const SELFTEST = process.argv.includes('--self-test');
const STAGED = process.argv.includes('--staged');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.astro', '.next', '.cache',
  'out', 'coverage', '.wrangler', '.vercel', '.netlify', 'vendor',
]);
const SCAN_EXT = /\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/i;
const SELF = 'security-scan.mjs';
const MAX_BYTES = 3_000_000;

// Third-party / build-output assets that are committed but not project source.
// These are minified by nature and are not where this injection lands.
const VENDOR_PATH = /(?:^|\/)(?:wp-content|wp-includes|jquery|swiper|elementor)[-/]|\.min\.(?:js|mjs|cjs|ts)$|(?:^|\/)vendor[-/]/i;

/* ------------------------------------------------------------------ rules -- */
/* BLOCK rules indicate code injection or deliberate obfuscation. They are chosen
   to not fire on ordinary build/scrape/migration scripts. */

const BLOCK = [
  {
    id: 'obfuscator-string-table',
    desc: 'Obfuscator string-table alias (const _0xNNNN = _0xNNNN)',
    test: s => /\b(?:const|let|var)\s+_0x[0-9a-f]{4,}\s*=\s*_0x[0-9a-f]{4,}\b/.test(s),
  },
  {
    id: 'obfuscator-identifier-density',
    desc: 'High density of _0xNNNN obfuscated identifiers',
    test: s => (s.match(/_0x[0-9a-f]{4,}/g) || []).length >= 12,
  },
  {
    id: 'global-assign-literal',
    desc: 'Top-level assignment of a string literal onto `global` (payload marker)',
    test: s => /^[^\n]{0,400}?\bglobal\.[A-Za-z_$][\w$]*\s*=\s*["'][^"'\n]{4,}["']\s*;/m.test(s),
  },
  {
    id: 'global-require-publish',
    desc: 'Publishing require/module onto global scope',
    test: s => /\bglobal\s*\[[^\]]+\]\s*=\s*(?:require|module)\b/.test(s),
  },
  {
    id: 'createrequire-in-config',
    desc: 'createRequire(import.meta.url) inside an Astro/Vite config',
    test: (s, f) => /(?:astro|vite|astro\.config|vite\.config)[^/\\]*\.(?:mjs|js|ts)$/i.test(basename(f))
      && /createRequire\s*\(\s*import\.meta\.url\s*\)/.test(s),
  },
  {
    id: 'payload-after-config-close',
    desc: 'Code appended after the config export closes (hidden payload)',
    test: (s, f) => {
      if (!/config\.(?:mjs|js|ts)$/i.test(basename(f))) return false;
      const m = /^\s*(?:\}\)\s*;|\}\s*;?)\s*$/m;
      const lines = s.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // A line that closes the export but then carries much more content.
        if (/^\s*\}\)\s*;/.test(lines[i]) && lines[i].replace(/\s+$/, '').length > 200) return true;
      }
      return m && false;
    },
  },
  {
    id: 'hidden-long-line',
    // A minified bundle is long lines throughout. An injected payload is a normal,
    // short-lined source file with ONE enormous outlier line. Only the latter fires,
    // so committed vendor/minified assets do not trip this rule.
    desc: 'Long payload line hidden inside an otherwise normally-formatted file',
    test: s => {
      const lines = s.split('\n');
      const long = lines.filter(l => l.length >= 500 && /[;=(]/.test(l) && !/^\s*(?:\/\/|\*|import\s)/.test(l));
      if (long.length === 0) return false;
      const short = lines.filter(l => l.trim() && l.length < 200);
      // outlier: a handful of huge lines amid many ordinary ones
      return long.length <= 3 && short.length >= 5;
    },
  },
  {
    id: 'space-padded-tail',
    desc: 'Long run of spaces followed by code (off-screen hiding trick)',
    test: s => /[^\s]\x20{80,}\S/.test(s),
  },
  {
    id: 'unicode-escape-hiding',
    desc: 'Long run of \\uXXXX escapes hiding a string literal',
    test: s => /(?:\\u00[0-9a-fA-F]{2}){8,}/.test(s),
  },
  {
    id: 'hex-escape-hiding',
    desc: 'Long run of \\xNN escapes hiding a string literal',
    test: s => /(?:\\x[0-9a-fA-F]{2}){20,}/.test(s),
  },
  {
    id: 'etherhiding',
    desc: 'EtherHiding loader: blockchain RPC used to retrieve a payload',
    test: s => /eth_(?:getTransaction|getBlockByNumber|blockNumber)/.test(s)
      && /(?:drpc\.org|publicnode\.com|blastapi\.io|1rpc\.io|blockscout\.com|infura|alchemy)/i.test(s),
  },
  {
    id: 'supply-chain-worm',
    desc: 'Known supply-chain worm indicator (Shai-Hulud family)',
    test: s => /shai.?hulud|bun_environment|setup_bun/i.test(s),
  },
  {
    id: 'eval-of-decoded-data',
    desc: 'eval / new Function applied to decoded or fetched data',
    test: s => /(?:eval|new\s+Function)\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent|[\w$]*(?:decode|inflate|gunzip))/i.test(s),
  },
  {
    id: 'module-loader-tampering',
    desc: 'Node module-loader tampering',
    test: s => /require\.cache\s*\[|process\.binding\s*\(|Module\._load\s*=/.test(s),
  },
];

/* WARN rules are legitimate in build tooling; reported, non-blocking unless --strict. */
const WARN = [
  { id: 'child-process', desc: 'Spawns processes (normal for build/git scripts)',
    test: s => /from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)/.test(s) },
  { id: 'reads-secrets', desc: 'Reads credential material from env/files',
    test: s => /process\.env\.(?:GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY)\b|\.npmrc|\.git-credentials|id_rsa/.test(s) },
  { id: 'env-bulk-harvest', desc: 'Serialises the whole environment',
    test: s => /JSON\.stringify\s*\(\s*process\.env\s*\)/.test(s) },
];

/* ------------------------------------------------------------------ walk --- */

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && SCAN_EXT.test(e.name)) {
      if (e.name === SELF) continue;               // don't flag this scanner
      const rel = relative(ROOT, full).split(sep).join('/');
      if (VENDOR_PATH.test(rel)) continue;         // committed third-party assets
      yield full;
    }
  }
}

/* Staged-content mode: read what is actually about to be committed (the git index),
   not the working tree. Only git plumbing is invoked - never repository code. */
function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function stagedContent(path) {
  // ':path' addresses the staged blob, so amendments to the working tree are ignored.
  return execFileSync('git', ['show', `:${path}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function isScannable(rel) {
  const name = rel.split('/').pop();
  if (name === SELF) return false;
  if (!SCAN_EXT.test(name)) return false;
  if (VENDOR_PATH.test(rel)) return false;
  return !rel.split('/').some(seg => SKIP_DIRS.has(seg));
}

function scanText(text, file) {
  const blocking = [], warnings = [];
  for (const r of BLOCK) { try { if (r.test(text, file)) blocking.push(r); } catch {} }
  for (const r of WARN) { try { if (r.test(text, file)) warnings.push(r); } catch {} }
  return { blocking, warnings };
}

/* -------------------------------------------------------------- self-test -- */

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'secscan-'));
  const B = String.fromCharCode(92);
  const cases = [
    { name: 'astro.config.mjs', mustBlock: true,
      body: 'import { defineConfig } from "astro/config";\n'
        + "import { createRequire } from 'module';\n"
        + 'const require = createRequire(import.meta.url);\n'
        + 'export default defineConfig({ site: "https://x.nl" });'
        + ' '.repeat(507)
        + 'global.i="A8-2591-1";const _0xb40cd9=_0x4963;(function(_0x28261c){var _0x1f55f0=_0x4963;})();' },
    { name: 'clean-astro.config.mjs', mustBlock: false,
      body: 'import { defineConfig } from "astro/config";\nexport default defineConfig({ site: "https://x.nl" });\n' },
    { name: 'legit-scrape.mjs', mustBlock: false,
      body: 'import fs from "node:fs";\n'
        + 'const r = await fetch("https://api.coingecko.com/api/v3/simple/price");\n'
        + 'fs.writeFileSync("out.json", JSON.stringify(await r.json()));\n' },
    { name: 'legit-git.mjs', mustBlock: false,
      body: 'import { execFileSync } from "node:child_process";\n'
        + 'const t = process.env.GH_TOKEN;\nexecFileSync("git", ["clone", "repo"]);\n' },
    { name: 'etherhiding.mjs', mustBlock: true,
      body: 'const r = await fetch("https://eth.drpc.org", {method:"POST",'
        + 'body: JSON.stringify({method:"eth_getTransactionByHash"})});\n' },
  ];
  let pass = 0, fail = 0;
  for (const c of cases) {
    const p = join(dir, c.name);
    writeFileSync(p, c.body);
    const { blocking } = scanText(readFileSync(p, 'utf8'), p);
    const blocked = blocking.length > 0;
    if (blocked === c.mustBlock) { pass++; console.log(`  PASS  ${c.name} (${c.mustBlock ? 'blocked' : 'allowed'})`); }
    else { fail++; console.log(`  FAIL  ${c.name}: expected ${c.mustBlock ? 'block' : 'allow'}, got ${blocked ? 'block' : 'allow'} [${blocking.map(b => b.id).join(',')}]`); }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

/* ------------------------------------------------------------------ main --- */

export { scanText, BLOCK, WARN, walk };

const IS_MAIN = process.argv[1] ? import.meta.url.endsWith(basename(process.argv[1])) : false;
if (!IS_MAIN) { /* imported for testing: do not scan */ }
else if (SELFTEST) {
  process.exit(selfTest() ? 0 : 2);
}

else {
let scanned = 0;
const blockingFindings = [], warningFindings = [];

if (STAGED) {
  let files;
  try { files = stagedFiles(); }
  catch (e) { console.error('security-scan: could not read the git index:', e.message); process.exit(1); }
  for (const rel of files.filter(isScannable)) {
    let text;
    try { text = stagedContent(rel); } catch { continue; }
    if (text.length > MAX_BYTES) continue;
    scanned++;
    const { blocking, warnings } = scanText(text, rel);
    for (const r of blocking) blockingFindings.push({ rel, r });
    for (const r of warnings) warningFindings.push({ rel, r });
  }
  console.log(`security-scan: ${scanned} staged source file(s) analysed statically`);
} else {
  for (const file of walk(ROOT)) {
    let st;
    try { st = statSync(file); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    scanned++;
    const rel = relative(ROOT, file).split(sep).join('/');
    const { blocking, warnings } = scanText(text, file);
    for (const r of blocking) blockingFindings.push({ rel, r });
    for (const r of warnings) warningFindings.push({ rel, r });
  }
  console.log(`security-scan: ${scanned} source file(s) analysed statically (node_modules excluded)`);
}

if (warningFindings.length) {
  console.log(`\n::group::${warningFindings.length} informational warning(s)`);
  for (const { rel, r } of warningFindings) console.log(`  [warn] ${rel}: ${r.desc}`);
  console.log('::endgroup::');
}

if (blockingFindings.length) {
  console.log('');
  console.log('='.repeat(72));
  console.log('SECURITY SCAN FAILED - malicious or obfuscated code detected');
  console.log('='.repeat(72));
  const byFile = new Map();
  for (const { rel, r } of blockingFindings) {
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(r);
  }
  for (const [rel, rules] of byFile) {
    console.log(`\n  FILE: ${rel}`);
    for (const r of rules) {
      console.log(`    - [${r.id}] ${r.desc}`);
      // Workflow-command annotations only make sense inside GitHub Actions.
      if (process.env.GITHUB_ACTIONS === 'true')
        console.log(`::error file=${rel},title=Malicious code detected::[${r.id}] ${r.desc}`);
    }
  }
  console.log(`
${'='.repeat(72)}
${byFile.size} file(s) contain blocking findings. ${STAGED ? 'This commit is blocked.' : 'This push/merge is blocked.'}

This pattern matches an injected loader previously found across these repos:
an obfuscated payload appended to astro.config.mjs behind a long run of spaces,
with an unused createRequire(import.meta.url) added among the imports.

What to do:
  1. Open the file(s) above and scroll RIGHT - the payload hides off-screen.
  2. Remove the injected block AND the createRequire import/declaration.
  3. Re-stage the file and commit again.
  4. If you believe this is a false positive, do not bypass with --no-verify;
     adjust .githooks/security-scan.mjs in a reviewed change instead.
${'='.repeat(72)}`);
  process.exit(1);
}

if (STRICT && warningFindings.length) {
  console.log('\nSECURITY SCAN FAILED - --strict: warnings treated as errors');
  process.exit(1);
}

console.log('security-scan: OK - no malicious or obfuscated code detected');
process.exit(0);
}
