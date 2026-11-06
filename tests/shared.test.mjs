import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubdomain, canTransition, DEFAULT_PORT_RANGE, isStaff } from "../packages/shared/src/index.ts";

test("subdomain patterns per service type", () => {
  assert.equal(buildSubdomain("minecraft", "Steve", "nimbushost.com"), "play-steve.nimbushost.com");
  assert.equal(buildSubdomain("website", "Alice", "nimbushost.com"), "alice.nimbushost.com");
  assert.equal(buildSubdomain("backend", "Bob", "nimbushost.com"), "api-bob.nimbushost.com");
  assert.equal(buildSubdomain("discord", "Carol", "nimbushost.com"), "bot-carol.nimbushost.com");
});

test("power transitions follow the state machine", () => {
  assert.ok(canTransition("offline", "start"));
  assert.ok(canTransition("online", "stop"));
  assert.ok(canTransition("online", "restart"));
  assert.ok(canTransition("error", "reinstall"));
  assert.ok(!canTransition("suspended", "start"), "suspended services cannot start");
  assert.ok(!canTransition("restarting", "stop"), "no conflicting operations mid-transition");
  assert.ok(!canTransition("installing", "start"), "no operations while installing");
});

test("port range default matches the PRD", () => {
  assert.deepEqual(DEFAULT_PORT_RANGE, [4001, 4050]);
});

test("staff role check", () => {
  assert.ok(isStaff("owner"));
  assert.ok(isStaff("staff"));
  assert.ok(!isStaff("customer"));
});
