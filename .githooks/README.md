# .githooks — pre-commit security scan

This directory holds a static security check that runs **before a commit is created**.

## Enable it (required, once per clone)

```bash
git config core.hooksPath .githooks
```

Git does **not** run committed hooks automatically — it only looks in `.git/hooks`
unless `core.hooksPath` is set. Until you run this command, the hook does nothing.

On Windows (Git Bash / WSL) the same command applies. If the hook does not execute,
make sure it is executable:

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
