/**
 * NIMBUS API smoke test — requires a running API and MongoDB.
 *
 *   set MONGODB_URI=mongodb://127.0.0.1:27017/nimbus-smoke
 *   set JWT_SECRET=<random> && set AGENT_SHARED_SECRET=<random> && set API_PORT=4100
 *   node apps/api/dist/main.js &
 *   node tests/api-smoke.mjs
 *
 * Uses the bootstrap credentials from env (defaults admin@gmail.com/admin).
 * Exits non-zero if any assertion fails.
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4100/api/v1";
const ADMIN_ID = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@gmail.com";
const ADMIN_PW = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "admin";

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json };
}

(async () => {
  console.log(`NIMBUS API smoke test against ${BASE}\n`);

  // Health / auth boundary
  const anon = await call("/auth/me");
  check("unauthenticated /auth/me rejected", anon.status === 401, `status=${anon.status}`);

  const bad = await call("/auth/login", { method: "POST", body: { identifier: ADMIN_ID, password: "definitely-wrong" } });
  check("wrong password rejected", bad.status === 401, `status=${bad.status}`);

  const login = await call("/auth/login", { method: "POST", body: { identifier: ADMIN_ID, password: ADMIN_PW } });
  check(
    "bootstrap admin login",
    login.status === 200 && !!login.body?.token && login.body?.redirect === "/admin",
    login.body?.user ? `role=${login.body.user.role} mustChangePassword=${login.body.user.mustChangePassword}` : JSON.stringify(login.body).slice(0, 100),
  );
  const owner = login.body?.token;
  if (!owner) process.exit(1);

  const me = await call("/auth/me", { token: owner });
  check("authenticated /auth/me", me.status === 200 && !!me.body?.username, `username=${me.body?.username}`);

  // Users CRUD + RBAC
  const users = await call("/users", { token: owner });
  check("owner lists users", users.status === 200 && users.body?.total >= 1, `total=${users.body?.total}`);

  const suffix = Date.now().toString(36);
  const created = await call("/users", {
    method: "POST",
    token: owner,
    body: { email: `smoke-${suffix}@example.com`, username: `smoke${suffix}`, password: "smokepass123", role: "customer" },
  });
  check("owner creates customer", created.status === 201, `status=${created.status}`);

  const dup = await call("/users", {
    method: "POST",
    token: owner,
    body: { email: `other-${suffix}@example.com`, username: `SMOKE${suffix}`, password: "password123", role: "customer" },
  });
  check("duplicate username rejected (case-insensitive)", dup.status === 409, `status=${dup.status}`);

  const short = await call("/users", {
    method: "POST",
    token: owner,
    body: { email: `short-${suffix}@example.com`, username: `short${suffix}`, password: "short", role: "customer" },
  });
  check("weak password rejected", short.status === 400, `status=${short.status}`);

  const custLogin = await call("/auth/login", {
    method: "POST",
    body: { identifier: `smoke${suffix}`, password: "smokepass123" },
  });
  check(
    "customer login routes to customer dashboard",
    custLogin.status === 200 && custLogin.body?.redirect === "/dashboard",
    `redirect=${custLogin.body?.redirect}`,
  );
  const cust = custLogin.body?.token;

  const forbidden = await call("/users", { token: cust });
  check("RBAC: customer blocked from /users", forbidden.status === 403, `status=${forbidden.status}`);

  const own = await call("/services", { token: cust });
  check("customer reads own (empty) services", own.status === 200 && Array.isArray(own.body) && own.body.length === 0);

  // Allocations validation (no node needed for validation errors)
  const badPort = await call("/allocations", { method: "POST", token: owner, body: { nodeId: "000000000000000000000000", ip: "127.0.0.1", port: 80, protocol: "tcp" } });
  check("allocation validation reachable", [400, 403, 404, 500].includes(badPort.status) === false || badPort.status === 400, `status=${badPort.status}`);

  // Domains: custom domain issues TXT verification
  const dom = await call("/domains/custom", { method: "POST", token: cust, body: { hostname: `smoke-${suffix}.example.com` } });
  check(
    "custom domain issues TXT verification token",
    dom.status === 201 && !!dom.body?.domain?.verificationToken,
    dom.body?.domain?.verificationToken ? "token issued" : JSON.stringify(dom.body).slice(0, 100),
  );

  const takeover = await call("/domains/custom", { method: "POST", token: owner, body: { hostname: `smoke-${suffix}.example.com` } });
  check("domain takeover prevented (duplicate claim)", takeover.status === 409, `status=${takeover.status}`);

  // Logout
  const out = await call("/auth/logout", { method: "POST", token: owner });
  check("logout", out.status === 200);

  // ── Appearance system ───────────────────────────────────────────
  // Re-login (previous token cleared server-side is cookie-only; bearer stays valid)
  const relogin = await call("/auth/login", { method: "POST", body: { identifier: ADMIN_ID, password: ADMIN_PW } });
  const ownerToken = relogin.body?.token ?? owner;
  const custToken = cust;

  const pubThemes = await call("/appearance/themes", { token: custToken });
  check(
    "customer sees only published themes (10 built-ins seeded)",
    pubThemes.status === 200 && Array.isArray(pubThemes.body) && pubThemes.body.length >= 10,
    `count=${Array.isArray(pubThemes.body) ? pubThemes.body.length : "?"}`,
  );

  const pubSettings = await call("/appearance/public-settings", { token: custToken });
  check("public settings reachable", pubSettings.status === 200 && typeof pubSettings.body?.defaultThemeKey === "string");

  const suffix2 = Date.now().toString(36);
  const badTheme = await call("/appearance/themes", {
    method: "POST", token: ownerToken,
    body: { name: `Bad ${suffix2}`, colors: { bg: "#000000", surface: "#111111", text: "url(javascript:alert(1))", border: "#222222" } },
  });
  check("invalid color rejected (CSS injection guard)", badTheme.status === 400, `status=${badTheme.status}`);

  const newTheme = await call("/appearance/themes", {
    method: "POST", token: ownerToken,
    body: {
      name: `Smoke Theme ${suffix2}`,
      description: "created by api smoke test",
      mode: "dark",
      colors: { bg: "#000000", surface: "#141414", surfaceRaised: "#1c1c1c", border: "#262626", text: "#ffffff", textMuted: "#a3a3a3", primary: "#7cc4ff", primaryText: "#000000", secondary: "#4f6b84" },
    },
  });
  check("admin creates theme", newTheme.status === 201 && !!newTheme.body?.key, `status=${newTheme.status}`);
  const themeKey = newTheme.body?.key;

  const unpubPick = await call("/appearance/me", {
    method: "PUT", token: custToken, body: { themeKey },
  });
  check("customer cannot pick an unpublished theme", unpubPick.status === 403, `status=${unpubPick.status}`);

  await call(`/appearance/themes/${themeKey}/publish`, { method: "POST", token: ownerToken, body: { published: true } });
  const custPick = await call("/appearance/me", { method: "PUT", token: custToken, body: { themeKey } });
  check("customer picks published theme", custPick.status === 200 && custPick.body?.themeKey === themeKey, `status=${custPick.status}`);

  const resolved = await call("/appearance/me", { token: custToken });
  check("resolved appearance returns theme + preset", resolved.status === 200 && !!resolved.body?.themeKey && !!resolved.body?.animationPreset);

  const rbacSettings = await call("/appearance/settings", { method: "PATCH", token: custToken, body: { animationsEnabled: false } });
  check("RBAC: customer cannot change global appearance settings", rbacSettings.status === 403, `status=${rbacSettings.status}`);

  const rbacCreate = await call("/appearance/themes", { method: "POST", token: custToken, body: { name: "Nope", colors: { bg: "#000000", surface: "#111111", text: "#ffffff", border: "#222222" } } });
  check("RBAC: customer cannot create themes", rbacCreate.status === 403, `status=${rbacCreate.status}`);

  // Lock themes down — customer pick must now be forced back to default
  await call("/appearance/settings", { method: "PATCH", token: ownerToken, body: { allowCustomerThemes: false } });
  const locked = await call("/appearance/me", { token: custToken });
  check("admin lock forces customer back to default theme", locked.status === 200 && locked.body?.themeKey !== themeKey, `resolved=${locked.body?.themeKey}`);
  const lockedPick = await call("/appearance/me", { method: "PUT", token: custToken, body: { themeKey } });
  check("customer pick rejected while themes locked", lockedPick.status === 403, `status=${lockedPick.status}`);
  await call("/appearance/settings", { method: "PATCH", token: ownerToken, body: { allowCustomerThemes: true } });

  const badImport = await call("/appearance/themes/import", { method: "POST", token: ownerToken, body: { payload: { name: "Evil", colors: { bg: "#000000", surface: "#111111", text: "#ffffff", border: "#222222", inject: "position:fixed" } } } });
  check("invalid theme import rejected", badImport.status === 400, `status=${badImport.status}`);

  const goodImport = await call("/appearance/themes/import", {
    method: "POST", token: ownerToken,
    body: { payload: JSON.stringify({ name: `Imported ${suffix2}`, mode: "dark", colors: { bg: "#04121f", surface: "#0a1f33", surfaceRaised: "#0f2b45", border: "#1d3d5c", text: "#dbeeff", textMuted: "#7fa3c0", primary: "#38bdf8", primaryText: "#04121f", secondary: "#0e7490" } }) },
  });
  check("valid theme import succeeds", goodImport.status === 201, `status=${goodImport.status}`);

  const animPref = await call("/appearance/me", { method: "PUT", token: custToken, body: { reducedMotion: true } });
  check("customer sets reduced motion", animPref.status === 200 && animPref.body?.reducedMotion === true);

  const resetPrefs = await call("/appearance/me/reset", { method: "POST", token: custToken });
  check("customer resets appearance preferences", resetPrefs.status === 200 || resetPrefs.status === 201, `status=${resetPrefs.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("smoke test harness error:", e.message);
  process.exit(1);
});
