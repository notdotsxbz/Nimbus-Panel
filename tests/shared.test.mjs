import { test } from "node:test";
import assert from "node:assert/strict";
// Tests run against the COMPILED shared package (dist) — Node cannot execute
// TypeScript directly. `npm run test --workspace @nimbus/shared` builds first.
import { buildSubdomain, canTransition, DEFAULT_PORT_RANGE, isStaff } from "../packages/shared/dist/index.js";
import {
  BUILT_IN_THEMES,
  ANIMATION_PRESETS,
  ANIMATION_PRESET_IDS,
  THEME_TOKENS,
  contrastRatio,
  validateThemeColors,
  isValidPresetId,
} from "../packages/shared/dist/index.js";

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

// ── Appearance system ─────────────────────────────────────────────

test("all 10 built-in themes pass their own validator", () => {
  assert.equal(BUILT_IN_THEMES.length, 10);
  const ids = new Set(BUILT_IN_THEMES.map((t) => t.id));
  assert.equal(ids.size, 10, "theme ids must be unique");
  for (const theme of BUILT_IN_THEMES) {
    const result = validateThemeColors(theme.colors);
    assert.deepEqual(
      { id: theme.id, ok: result.ok, errors: result.errors },
      { id: theme.id, ok: true, errors: [] },
    );
    // every token used must be whitelisted
    for (const key of Object.keys(theme.colors)) {
      assert.ok((THEME_TOKENS).includes(key), `unexpected token ${key} in ${theme.id}`);
    }
  }
});

test("theme validation rejects invalid input", () => {
  assert.equal(validateThemeColors("not-an-object").ok, false);
  assert.equal(validateThemeColors({}).ok, false, "empty colors rejected");
  assert.equal(
    validateThemeColors({ bg: "#000000", surface: "#111111", text: "#ffffff", border: "#222222", evil: "url(javascript:alert(1))" }).ok,
    false,
    "unknown token rejected (CSS injection guard)",
  );
  assert.equal(
    validateThemeColors({ bg: "#000000", surface: "#111111", text: "red", border: "#222222" }).ok,
    false,
    "non-hex color rejected",
  );
  assert.equal(
    validateThemeColors({ bg: "#000000", surface: "#111111", text: "#101010", border: "#111111" }).ok,
    false,
    "unreadable text/background contrast rejected",
  );
});

test("contrast ratio math is WCAG-correct", () => {
  assert.equal(contrastRatio("#000000", "#ffffff") > 20, true, "black vs white >= 21");
  assert.equal(Math.round(contrastRatio("#000000", "#777777") * 10) / 10 >= 3, true);
  assert.equal(contrastRatio("#000000", "#000000"), 1, "same color = 1");
});

test("animation presets are complete and sane", () => {
  assert.equal(ANIMATION_PRESETS.length, 5);
  const ids = new Set(ANIMATION_PRESETS.map((p) => p.id));
  assert.equal(ids.size, 5);
  for (const preset of ANIMATION_PRESETS) {
    assert.equal(typeof preset.speed, "number");
    assert.equal(typeof preset.intensity, "number");
    assert.equal(Object.keys(preset.effects).length, 10, "all 10 effect switches present");
    assert.equal(isValidPresetId(preset.id), true);
  }
  assert.equal(isValidPresetId("bouncy-hyper"), false, "unknown preset rejected");
});
