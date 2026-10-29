/**
 * Paste into Cloudflare dashboard → Worker "lpm-payload-secrets" → Save and Deploy.
 *
 * GET /v1/secrets?role=payload|github
 * Authorization: Bearer SECRETS_ACCESS_TOKEN
 *   github role: SECRETS_GITHUB_TOKEN if set, else SECRETS_ACCESS_TOKEN (no IP check)
 *
 * payload requires ALLOWED_IPS. GitHub Actions uses role=github (token only).
 */
var PAYLOAD_KEYS = [
  "PAYLOAD_SECRET",
  "PAYLOAD_PUBLIC_SERVER_URL",
  "PAYLOAD_INTERNAL_URL",
  "PAYLOAD_API_KEY",
  "PAYLOAD_SDK_TIMEOUT_MS",
  "PAYLOAD_COOKIE_SECURE",
  "PAYLOAD_ALLOWED_ORIGINS",
  "PAYLOAD_TOTP_ISSUER",
  "PAYLOAD_DEBUG_API",
  "PAYLOAD_DEBUG_AUTH",
  "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
  "DATABASE_URI",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_URL",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "PLATFORM_GIT_BRANCH",
  "EXTERNAL_REPO_GITHUB_TOKEN",
  "DEPLOY_REPORT_TOKEN",
  "CREDENTIALS_ENCRYPTION_KEY"
];
var GITHUB_KEYS = [
  "PAYLOAD_PUBLIC_SERVER_URL",
  "PAYLOAD_API_KEY",
  "DEPLOY_REPORT_TOKEN",
  "EXTERNAL_REPO_GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "PLATFORM_GIT_BRANCH",
  "R2_PUBLIC_URL"
];
function pick(env, keys) {
  const out = {};
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}
function githubValues(env) {
  const values = pick(env, GITHUB_KEYS);
  if (!values.PAYLOAD_URL && values.PAYLOAD_PUBLIC_SERVER_URL) {
    values.PAYLOAD_URL = values.PAYLOAD_PUBLIC_SERVER_URL;
  }
  return values;
}
function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP")?.trim();
  if (cf) return cf;
  return null;
}
function parseAllowlist(raw) {
  return (raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}
function expandIpv6(ip) {
  let raw = ip.toLowerCase().trim();
  if (raw.includes(".")) return null;
  if (!raw.includes(":")) return null;
  const [head, tail] = raw.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail !== void 0 && tail !== "" ? tail.split(":").filter(Boolean) : [];
  if (raw.includes("::")) {
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    raw = [...headParts, ...Array(missing).fill("0"), ...tailParts].join(":");
  }
  const parts = raw.split(":");
  if (parts.length !== 8) return null;
  return parts.map((p) => p.padStart(4, "0")).join(":");
}
function ipv6PrefixMatch(ip, cidr) {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = expandIpv6(ip);
  const b = expandIpv6(base ?? "");
  if (!a || !b || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const hexA = a.replace(/:/g, "");
  const hexB = b.replace(/:/g, "");
  const fullNibbles = Math.floor(bits / 4);
  if (hexA.slice(0, fullNibbles) !== hexB.slice(0, fullNibbles)) return false;
  const rem = bits % 4;
  if (rem === 0) return true;
  const mask = 15 << 4 - rem;
  const na = parseInt(hexA[fullNibbles] ?? "0", 16);
  const nb = parseInt(hexB[fullNibbles] ?? "0", 16);
  return (na & mask) === (nb & mask);
}
function ipAllowed(ip, rules) {
  const ipLower = ip.toLowerCase();
  const ip6 = expandIpv6(ip);
  for (const rule of rules) {
    if (rule.includes("/")) {
      const [base, bitsRaw] = rule.split("/");
      const bits = Number(bitsRaw);
      const ipInt = ipv4ToInt(ip);
      const baseInt = ipv4ToInt(base ?? "");
      if (ipInt != null && baseInt != null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : ~0 << 32 - bits >>> 0;
        if ((ipInt & mask) === (baseInt & mask)) return true;
        continue;
      }
      if (ipv6PrefixMatch(ip, rule)) return true;
      continue;
    }
    if (rule.toLowerCase() === ipLower) return true;
    const rule6 = expandIpv6(rule);
    if (ip6 && rule6 && ip6 === rule6) return true;
  }
  return false;
}
function forbidden(message, extra) {
  return new Response(JSON.stringify({ ok: false, error: message, ...extra }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(JSON.stringify({ ok: true, service: "lpm-payload-secrets" }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (request.method !== "GET" || url.pathname !== "/v1/secrets") {
      return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }
    const role = url.searchParams.get("role");
    const isGithub = role === "github" || role === "github_actions";
    const isPayload = role === "payload";
    if (!isGithub && !isPayload) {
      return new Response(JSON.stringify({ ok: false, error: "role must be payload or github" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (!isGithub) {
      const allow = parseAllowlist(env.ALLOWED_IPS);
      if (allow.length === 0) {
        return forbidden("ALLOWED_IPS is not configured on the Worker.");
      }
      const ip = clientIp(request);
      if (!ip || !ipAllowed(ip, allow)) {
        return forbidden("IP not allowlisted", ip ? { ip } : {});
      }
    }
    const githubToken = env.SECRETS_GITHUB_TOKEN?.trim();
    const expected = isGithub && githubToken ? githubToken : env.SECRETS_ACCESS_TOKEN?.trim();
    const got = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!expected || !got || got !== expected) {
      return unauthorized();
    }
    const roleKeys = isPayload ? PAYLOAD_KEYS : GITHUB_KEYS;
    const values = isPayload ? pick(env, PAYLOAD_KEYS) : githubValues(env);
    const missing = roleKeys.filter((key) => !values[key]);
    return new Response(
      JSON.stringify({
        ok: true,
        role: isGithub ? "github" : role,
        keys: Object.keys(values),
        missing,
        values
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store"
        }
      }
    );
  }
};
