/**
 * Bind Jenkins Secret text credentials if they exist, then run the closure.
 * Does not call CredentialsProvider.getId (blocked by Script Security sandbox).
 *
 * When LPM_SECRETS_URL is set, only the bootstrap token is bound;
 * load-cloudflare-secrets.sh overwrites the rest from the Worker.
 *
 * Usage from a Jenkinsfile:
 *   def secrets = load 'jenkins/withJobSecrets.groovy'
 *   secrets.withJobSecrets { sh 'bash jenkins/scripts/tenant-deploy.sh' }
 */

/** credentialId → env var name (same names the Cloudflare Worker returns). */
def credentialEnvPairs() {
  return [
    ['lpm-secrets-token', 'LPM_SECRETS_TOKEN'],
    ['astropayload-secrets-token', 'ASTROPAYLOAD_SECRETS_TOKEN'],
    ['astropayload-payload-url', 'PAYLOAD_URL'],
    ['astropayload-deploy-report-token', 'DEPLOY_REPORT_TOKEN'],
    ['astropayload-external-repo-github-token', 'EXTERNAL_REPO_GITHUB_TOKEN'],
    ['astropayload-platform-github-token', 'PLATFORM_GIT_TOKEN'],
    ['astropayload-cloudflare-api-token', 'CLOUDFLARE_API_TOKEN'],
    ['astropayload-cloudflare-account-id', 'CLOUDFLARE_ACCOUNT_ID'],
  ]
}

def isMissingCredential(err) {
  def msg = "${err}"
  return msg.contains('CredentialNotFound') ||
    msg.contains('could not find credentials') ||
    msg.contains('Could not find credentials')
}

/** Bind each Secret text id if present; skip missing ids without failing the job. */
def bindOptionalStrings(List pairs, Closure body) {
  if (!pairs) {
    if (env.PLATFORM_GIT_TOKEN) {
      env.GH_TOKEN = env.PLATFORM_GIT_TOKEN
      env.GITHUB_TOKEN = env.PLATFORM_GIT_TOKEN
    }
    body()
    return
  }
  def id = pairs[0][0]
  def envName = pairs[0][1]
  def rest = pairs.drop(1)
  try {
    withCredentials([string(credentialsId: id, variable: envName)]) {
      echo "Bound Jenkins credential ${id} → ${envName}"
      bindOptionalStrings(rest, body)
    }
  } catch (err) {
    if (isMissingCredential(err)) {
      bindOptionalStrings(rest, body)
    } else {
      throw err
    }
  }
}

def withJobSecrets(Closure body) {
  def pairs = credentialEnvPairs()
  if (env.LPM_SECRETS_URL?.trim() || env.ASTROPAYLOAD_SECRETS_URL?.trim()) {
    echo 'Cloudflare secrets Worker URL is set — binding bootstrap token only (if present).'
    pairs = [
      ['lpm-secrets-token', 'LPM_SECRETS_TOKEN'],
      ['astropayload-secrets-token', 'ASTROPAYLOAD_SECRETS_TOKEN'],
    ]
  }
  bindOptionalStrings(pairs, body)
}

return this
