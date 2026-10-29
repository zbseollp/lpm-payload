# Converting GitHub Actions → Jenkins

This guide explains how astropayload maps each `.github/workflows/*.yml` to Jenkins, how to add a **new triggered job**, and how to add a **scheduled (cron) job**.

For one-time Jenkins setup (credentials, Payload `.env`), see [README.md](./README.md).

---

## Architecture (same as GitHub Actions)

```
┌─────────────────┐     buildWithParameters      ┌──────────────────┐
│  Payload CMS    │ ───────────────────────────► │  Jenkins job     │
│  (Publish/      │     (tenant_slug, …)         │  Jenkinsfile     │
│   Import/Deploy)│                              │       │          │
└─────────────────┘                              │       ▼          │
                                                 │  jenkins/scripts │
                                                 │  *.sh (steps)    │
                                                 └────────┬─────────┘
                                                          │
                                                          ▼
                                                 report-deploy → Payload
```

**Rule:** Keep the **Jenkinsfile thin** (parameters, credentials, one `sh` call). Put all steps in **`jenkins/scripts/<job>.sh`**, mirroring the GitHub Actions `steps:` block.

Shared scripts (reuse across jobs):

| Script | Replaces GHA |
|--------|----------------|
| `load-cloudflare-secrets.sh` | `.github/scripts/load-cloudflare-secrets.sh` (`role=jenkins`) |
| `checkout-platform.sh` | `actions/checkout` of platform repo |
| `checkout-client-repo.sh` | `actions/checkout` of client repo |
| `resolve-client-github-token.sh` | `.github/scripts/resolve-client-github-token.sh` |
| `setup-node-pnpm.sh` + `load-node-pnpm.sh` | `pnpm/action-setup` + `actions/setup-node` |
| `normalize-github-repo.sh` | normalize `owner/repo` vs full URL |

---

## GHA concept → Jenkins equivalent

| GitHub Actions | Jenkins |
|----------------|---------|
| `on: workflow_dispatch` + `inputs:` | `parameters { string(...) choice(...) }` |
| `on: schedule` / `cron:` | `triggers { cron('0 * * * *') }` |
| `secrets.*` | Cloudflare Worker via `load-cloudflare-secrets.sh`, or `credentials('astropayload-…')` fallback |
| `env:` at job level | `environment { VAR = '...' }` or export in shell script |
| `runs-on: ubuntu-latest` | `agent any` (Linux agent with git + curl) |
| `timeout-minutes: 30` | `options { timeout(time: 30, unit: 'MINUTES') }` |
| `concurrency:` | `options { disableConcurrentBuilds() }` (global) or lock per tenant in script |
| `steps: - run:` | `sh 'bash jenkins/scripts/foo.sh'` |
| `actions/checkout@v4` | `checkout scm` (Pipeline from SCM) or `checkout-platform.sh` |
| `${{ github.event.inputs.tenant_slug }}` | `${params.tenant_slug}` in Jenkinsfile; `$tenant_slug` in shell |
| `${{ secrets.PAYLOAD_URL }}` | `PAYLOAD_URL = credentials('astropayload-payload-url')` |
| Trigger from Payload | `dispatchCiJob()` → Jenkins `buildWithParameters` |

---

## Existing jobs (reference)

| GitHub workflow | Jenkins job | Jenkinsfile | Shell script | Trigger |
|-----------------|-------------|-------------|--------------|---------|
| `tenant-deploy.yml` | `tenant-deploy` | `Jenkinsfile.tenant-deploy` | `tenant-deploy.sh` | Payload Publish / Deploy |
| `tenant-import-blog.yml` | `tenant-import-blog` | `Jenkinsfile.tenant-import-blog` | `tenant-import-blog.sh` | Payload Import blog |
| `tenant-scaffold.yml` | `tenant-scaffold` | `Jenkinsfile.tenant-scaffold` | `tenant-scaffold.sh` | Payload Scaffold |
| `tenant-repo-setup.yml` | `tenant-repo-setup` | `Jenkinsfile.tenant-repo-setup` | `tenant-repo-setup.sh` | Payload repo setup |
| *(was GHA cron)* | `scheduled-publish` | `Jenkinsfile.scheduled-publish` | `scheduled-publish.sh` | **Cron only** (hourly) |

Payload maps logical job keys in `apps/payload/src/lib/ci/types.ts`:

```ts
'tenant-deploy' | 'tenant-import-blog' | 'tenant-repo-setup' | 'tenant-scaffold'
```

Override Jenkins job names with `JENKINS_JOB_DEPLOY`, `JENKINS_JOB_IMPORT`, etc. on the Payload VPS.

---

## A. Add a **triggered** job (from `workflow_dispatch`)

Use this when Payload (or a human) starts the job with parameters — same as GitHub **Run workflow**.

### Step 1 — Copy the GitHub workflow

Example: `.github/workflows/tenant-deploy.yml` defines:

- **Inputs:** `tenant_slug`, `deploy_mode`, `github_repo`, …
- **Secrets:** `PAYLOAD_URL`, `DEPLOY_REPORT_TOKEN`, `CLOUDFLARE_API_TOKEN`, …
- **Steps:** checkout platform → checkout client → pnpm install → sync → build → wrangler deploy

### Step 2 — Create `jenkins/scripts/my-job.sh`

Translate each GHA `step` into bash. Use env vars Jenkins passes in:

```bash
#!/usr/bin/env bash
set -euo pipefail

TENANT="${tenant_slug:-${TENANT:-}}"
# … map other parameters …

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

bash "$SCRIPT_DIR/checkout-platform.sh"
# … same order as GHA steps …
```

Parameter names in Jenkins **must match** what Payload sends in `dispatchCiJob({ parameters: { … } })`.

### Step 3 — Create `jenkins/Jenkinsfile.my-job`

```groovy
pipeline {
  agent any

  options {
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds()  // optional: like GHA concurrency
  }

  parameters {
    string(name: 'tenant_slug', description: 'Tenant slug', trim: true)
    // one parameter per workflow_dispatch input
  }

  environment {
    PAYLOAD_URL = credentials('astropayload-payload-url')
    DEPLOY_REPORT_TOKEN = credentials('astropayload-deploy-report-token')
    // one credentials() per GitHub secret
  }

  stages {
    stage('Run') {
      steps {
        sh '''
          chmod +x jenkins/scripts/*.sh
          bash jenkins/scripts/my-job.sh
        '''
      }
    }
  }
}
```

### Step 4 — Register in Jenkins UI

1. **New Item** → **Pipeline** → name e.g. `tenant-deploy`
2. **Pipeline** → **Pipeline script from SCM**
3. **Git** → repo `astropayload`, branch `jenkins`
4. **Script Path** → `jenkins/Jenkinsfile.tenant-deploy`
5. Save → **Build Now** once (loads parameters from Jenkinsfile)
6. Confirm **Build with Parameters** appears

### Step 5 — Wire Payload (if triggered from CMS)

1. Add job key to `CiJobKey` in `apps/payload/src/lib/ci/types.ts`:

```ts
export type CiJobKey = 'tenant-deploy' | 'my-new-job'

const GITHUB_WORKFLOW = { …, 'my-new-job': 'my-new-job.yml' }
const JENKINS_JOB_ENV = { …, 'my-new-job': 'JENKINS_JOB_MY_NEW' }
```

2. Call from an endpoint or button:

```ts
await dispatchCiJob({
  job: 'my-new-job',
  parameters: { tenant_slug: tenant.slug, … },
}, payload)
```

3. Optional env on Payload VPS: `JENKINS_JOB_MY_NEW=my-new-job`

4. **Globals → Platform settings → CI provider → Jenkins** (or `CI_PROVIDER=jenkins`)

### Step 6 — Test

- **Manual:** Jenkins → job → **Build with Parameters**
- **From Payload:** Publish / Import / Deploy button → check tenant **Deploy status** link

---

## B. Add a **scheduled** job (from `on: schedule`)

Use this when the job runs on a timer — no parameters from Payload.

### GitHub Actions (before)

```yaml
on:
  schedule:
    - cron: '0 * * * *'   # every hour
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm scheduled-publish:run
```

### Jenkins equivalent

**`jenkins/Jenkinsfile.scheduled-publish`:**

```groovy
pipeline {
  agent any

  triggers {
    cron('0 * * * *')   // HOUR MIN DOM MON DOW — same as GHA
  }

  options {
    timeout(time: 15, unit: 'MINUTES')
  }

  environment {
    PAYLOAD_URL = credentials('astropayload-payload-url')
    DEPLOY_REPORT_TOKEN = credentials('astropayload-deploy-report-token')
  }

  stages {
    stage('Scheduled publish') {
      steps {
        sh '''
          chmod +x jenkins/scripts/*.sh
          bash jenkins/scripts/scheduled-publish.sh
        '''
      }
    }
  }
}
```

**`jenkins/scripts/scheduled-publish.sh`** checks out platform, installs Node/pnpm, then:

```bash
cd apps/payload
pnpm run scheduled-publish:run   # POST /api/scheduled-publish/run on CMS
```

That API promotes due scheduled posts and triggers **tenant-deploy** per tenant (via `dispatchCiJob` inside Payload).

### Jenkins UI for scheduled jobs

1. Create Pipeline job → SCM → `jenkins/Jenkinsfile.scheduled-publish`
2. After first run, Jenkins registers the `cron` trigger from the Jenkinsfile
3. Optional: **Configure** → verify **Build Triggers → Build periodically** shows `H * * * *` or your cron
4. No **Build with Parameters** needed

**Do not** run scheduled publish on the Payload VPS cron if Jenkins already runs it — pick one scheduler.

---

## Credentials cheat sheet

Create under **Manage Jenkins → Credentials → System → Global** (Secret text):

| Credential ID | GitHub secret |
|---------------|---------------|
| `astropayload-payload-url` | `PAYLOAD_URL` |
| `astropayload-deploy-report-token` | `DEPLOY_REPORT_TOKEN` |
| `astropayload-external-repo-github-token` | `EXTERNAL_REPO_GITHUB_TOKEN` |
| `astropayload-platform-github-token` | `GITHUB_TOKEN` |
| `astropayload-cloudflare-api-token` | `CLOUDFLARE_API_TOKEN` |
| `astropayload-cloudflare-account-id` | `CLOUDFLARE_ACCOUNT_ID` |

IDs must match Jenkinsfiles exactly.

---

## Payload `.env` (Jenkins mode)

```env
CI_PROVIDER=jenkins
JENKINS_URL=https://jenkins.yourdomain.com
JENKINS_USER=api-user
JENKINS_API_TOKEN=…

JENKINS_JOB_DEPLOY=tenant-deploy
JENKINS_JOB_IMPORT=tenant-import-blog
JENKINS_JOB_SETUP=tenant-repo-setup
JENKINS_JOB_SCAFFOLD=tenant-scaffold
```

Scheduled publish does **not** need a `JENKINS_JOB_*` entry — Jenkins cron calls Payload; Payload then dispatches `tenant-deploy` per tenant.

---

## Checklist: new pipeline

- [ ] GHA workflow read and steps listed
- [ ] `jenkins/scripts/<name>.sh` mirrors GHA steps
- [ ] `jenkins/Jenkinsfile.<name>` with matching `parameters` + `credentials`
- [ ] Jenkins Pipeline job created (SCM, correct Script Path)
- [ ] **Build Now** once (parameterized jobs)
- [ ] Credentials created with correct IDs
- [ ] `CiJobKey` + `dispatchCiJob` in Payload (if CMS-triggered)
- [ ] `JENKINS_JOB_*` env on Payload VPS (if job name differs)
- [ ] Test manual build, then test from Payload admin
- [ ] Disable or remove GHA `on:` triggers when Jenkins is verified

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `job is not parameterized` | Run **Build Now** once so Jenkins loads the Jenkinsfile |
| 403 client repo checkout | Tenant GitHub credential or `EXTERNAL_REPO_GITHUB_TOKEN` |
| `Could not reach Jenkins` | `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN` on Payload |
| Cron never runs | Job must run once; check Jenkins system time/timezone |
| Wrong branch checked out | Set `PLATFORM_GIT_BRANCH=jenkins` on agent or in job env |
| Clone URL malformed | Parameter must be `owner/repo`, not full `https://github.com/…` |

---

## Quick example: tenant-deploy mapping

| GHA | Jenkins |
|-----|---------|
| `inputs.tenant_slug` | `params.tenant_slug` → `$tenant_slug` in shell |
| `secrets.PAYLOAD_URL` | `credentials('astropayload-payload-url')` |
| `actions/checkout` platform | `checkout-platform.sh` |
| `actions/checkout` client | `checkout-client-repo.sh` |
| `pnpm install` + sync + build | `tenant-deploy.sh` |
| `workflow_dispatch` only | Payload `dispatchTenantDeploy()` |

See [Jenkinsfile.tenant-deploy](./Jenkinsfile.tenant-deploy) and [scripts/tenant-deploy.sh](./scripts/tenant-deploy.sh) as the canonical template for new triggered jobs.
