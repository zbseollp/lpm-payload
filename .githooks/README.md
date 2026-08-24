# .githooks — pre-commit security scan

This directory holds a static security check that runs **before a commit is created**.

## Enabling it

Git has **no post-clone hook** and cannot enable hooks by itself from repository
contents — if it could, cloning any untrusted repo would be remote code execution. So
something has to run once. There are three ways, in order of convenience.

### 1. Automatic on `npm install` (default here)

`package.json` has:

```json
"scripts": { "prepare": "node .githooks/install.mjs" }
```

npm runs `prepare` automatically after `npm install` / `npm ci`, which is the first thing
most people do after cloning. That script points `core.hooksPath` at `.githooks` and the
hook is live. It fails soft and will never break your install.

You should see, once:

```
security: git hooks enabled (core.hooksPath=.githooks)
```

This does not cover `npm install --ignore-scripts`, or a clone where you never install.

### 2. Manual, per clone

```bash
git config core.hooksPath .githooks
```

### 3. Machine-wide, covers every repo you ever clone

Set a global hooks directory once per machine, with a dispatcher that delegates to each
repo's own `.githooks/pre-commit` when present:

```bash
mkdir -p ~/.git-global-hooks
cat > ~/.git-global-hooks/pre-commit <<'EOF'
#!/bin/sh
# Delegate to the repository's own hook when it ships one.
if [ -x .githooks/pre-commit ]; then exec .githooks/pre-commit "$@"; fi
if [ -f .githooks/pre-commit ]; then exec sh .githooks/pre-commit "$@"; fi
exit 0
EOF
chmod +x ~/.git-global-hooks/pre-commit
git config --global core.hooksPath ~/.git-global-hooks
```

This is the strongest option: it applies to repos you clone in the future, with no
per-repo setup. Note a global `core.hooksPath` overrides per-repo hook directories, which
is exactly why the dispatcher above forwards to the repo's own hook.

If the hook does not execute, make sure it is executable:

```bash
chmod +x .githooks/pre-commit
```

## What it does

On `git commit`, it reads the **staged** contents of source files
(`.mjs`, `.cjs`, `.js`, `.mts`, `.cts`, `.ts`, `.jsx`, `.tsx`) straight out of the git
index and pattern-matches them as text.

It looks for injected/obfuscated code: obfuscator string tables (`_0x…`), payloads
appended after a config's export, long runs of space padding used to hide code
off-screen, `\uXXXX`/`\xNN` escape hiding, `createRequire(import.meta.url)` inside an
Astro/Vite config, blockchain-RPC payload loaders (EtherHiding), and known supply-chain
worm markers.

If anything blocking is found, the commit is refused with a per-file explanation.

**It never executes repository code** — no `npm install`, no build, no importing of the
files it inspects. Only `git` plumbing is invoked, to read the staged blobs.

Skipped: `node_modules`, `dist`, `build`, `.astro`, `.next`, `.cache`, plus committed
third-party assets (`wp-content`, `wp-includes`, `jquery`, `swiper`, `elementor`,
`vendor/`, any `*.min.js`).

## Run it manually

```bash
node .githooks/security-scan.mjs --staged     # what is staged right now
node .githooks/security-scan.mjs              # the whole working tree
node .githooks/security-scan.mjs --self-test  # prove the detector still works
```

## If it blocks you

1. Open the reported file and **scroll right** — this payload hides behind hundreds of
   spaces, so the line looks normal in an editor.
2. Remove the injected block *and* the `createRequire` import/declaration.
3. Re-stage and commit.

Do not reach for `git commit --no-verify`. If it is genuinely a false positive, change
the rule in `.githooks/security-scan.mjs` as a reviewed change so everyone benefits.

## Limitations — read this

- **Opt-in per clone.** A machine that never ran the `git config` command is unprotected.
- **Bypassable.** `git commit --no-verify` skips it entirely.
- **Local only.** It does not protect against anything pushed from CI, a bot, or a
  machine you do not control.

It is a fast first line of defence, not an enforcement boundary. Enforcement needs a
server-side required check or a scan stage in the build pipeline before `npm run build`.
