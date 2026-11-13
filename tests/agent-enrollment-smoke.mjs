/**
 * Node enrollment + agent authentication live test.
 * Requires the API running with AGENT_SHARED_SECRET matching this env.
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4100/api/v1";
const AGENT_SECRET = process.env.AGENT_SHARED_SECRET;
if (!AGENT_SECRET) { console.error("set AGENT_SHARED_SECRET"); process.exit(1); }

import crypto from "node:crypto";

let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, { headers: { "content-type": "application/json", ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined, method: o.method ?? "GET" });
  let b = {}; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};

(async () => {
  // login as owner
  const login = await j("/auth/test-login", { method: "POST", body: { identifier: "admin@gmail.com", password: "admin" } });
  const tok = login.body?.token;
  check("owner login", login.status === 200 && !!tok);
  const H = { authorization: "Bearer " + tok };

  // create node → enrollment token
  const node = await j("/nodes", { method: "POST", headers: H, body: { name: "smoke-node-" + Date.now().toString(36), ip: "192.0.2.77", sshPort: 22, sshUsername: "root", os: "ubuntu", location: "test", cpuCores: 4, ramTotalMb: 8192, diskTotalGb: 100 } });
  check("node created, enrollment token issued", node.status === 201 && !!node.body?.enrollmentToken, "status=" + node.status);
  const nodeId = node.body?.node?._id;
  const enrollTok = node.body?.enrollmentToken;
  if (!nodeId || !enrollTok) process.exit(1);

  // decode the enrollment token (same format the Go agent parses)
  const payload = JSON.parse(Buffer.from(enrollTok.split(".")[1], "base64url").toString("utf8"));
  check("enrollment token carries nodeId + jti", payload.nid === nodeId && !!payload.jti && payload.exp > Date.now() / 1000);

  // agent completes enrollment
  const enroll = await j("/nodes/agent/enroll", { method: "POST", body: { nodeId, jti: payload.jti } });
  check("agent enrollment returns permanent credential", enroll.status === 201 && !!enroll.body?.agentToken, "status=" + enroll.status);
  const agentTok = enroll.body?.agentToken;
  if (!agentTok) process.exit(1);

  // replay rejected (single-use)
  const replay = await j("/nodes/agent/enroll", { method: "POST", body: { nodeId, jti: payload.jti } });
  check("enrollment replay rejected (single-use)", replay.status === 400, "status=" + replay.status);

  // agent heartbeat with per-node credential
  const hb = await j("/nodes/agent/heartbeat", {
    method: "PUT",
    headers: { "x-nimbus-node": nodeId, authorization: "Bearer " + agentTok },
    body: { cpuPercent: 12.5, ramUsedBytes: 1073741824, ramTotalBytes: 8589934592, diskUsedBytes: 10737418240, diskTotalBytes: 107374182400, containersRunning: 0, uptimeSeconds: 3600, agentVersion: "1.0.0" },
  });
  check("agent heartbeat accepted", hb.status === 200, "status=" + hb.status);

  // heartbeat with WRONG credential rejected
  const bad = await j("/nodes/agent/heartbeat", {
    method: "PUT",
    headers: { "x-nimbus-node": nodeId, authorization: "Bearer " + crypto.randomBytes(32).toString("hex") },
    body: { cpuPercent: 1 },
  });
  check("agent heartbeat with forged credential rejected", bad.status === 400 || bad.status === 401 || bad.status === 403, "status=" + bad.status);

  // node shows online with telemetry
  const nodes = await j("/nodes", { headers: H });
  const n = (nodes.body?.items ?? nodes.body)?.find?.((x) => x._id === nodeId);
  check("node online with telemetry stored", !!n && n.online === true && !!n.lastHeartbeat, n ? `cpu=${n.lastHeartbeat?.cpuPercent}%` : "");

  // capacity planner sees the node
  const cap = await j("/nodes/capacity", { headers: H });
  check("capacity planner lists node", cap.status === 200 && (cap.body ?? []).some?.((c) => c.nodeId === nodeId));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("harness error:", e.message); process.exit(1); });
