/**
 * @nimbus/shared — appearance system
 * Theme tokens, built-in themes, animation presets, validation.
 * Used by the API (seeding + validation) and the web app (CSS variable
 * application). Themes are strictly token maps — never raw CSS.
 */

/** Whitelisted color tokens — anything else is rejected on input. */
export const THEME_TOKENS = [
  "bg",
  "surface",
  "surfaceRaised",
  "border",
  "text",
  "textMuted",
  "primary",
  "primaryText",
  "secondary",
  "sidebarBg",
  "sidebarText",
  "navbarBg",
  "inputBg",
  "inputBorder",
  "modalBg",
  "statusOnline",
  "statusPending",
  "statusError",
  "chart1",
  "chart2",
  "chart3",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeColors = Record<ThemeToken, string>;

export interface ThemeDefinition {
  id: string;
  name: string;
  description?: string;
  colors: ThemeColors;
  /** Native mode — used for light/dark/system pairing. */
  mode: "light" | "dark";
  isBuiltIn: boolean;
}

export const isValidHex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

/** Relative luminance (WCAG) of a #rrggbb color. */
export function relativeLuminance(hexColor: string): number {
  const v = hexColor.replace("#", "");
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ThemeValidation {
  ok: boolean;
  errors: string[];
  colors?: ThemeColors;
}

/**
 * Validates and normalizes a theme color payload:
 *  - unknown keys rejected (prevents arbitrary CSS injection)
 *  - only #rrggbb hex accepted
 *  - minimum contrast for text/background pairs enforced
 *  - payload size bounded
 */
export function validateThemeColors(input: unknown): ThemeValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["colors must be an object"] };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, errors: ["colors must not be empty"] };
  if (entries.length > THEME_TOKENS.length) {
    errors.push(`colors has too many keys (max ${THEME_TOKENS.length})`);
  }
  const colors: Partial<ThemeColors> = {};
  for (const [key, value] of entries) {
    if (!(THEME_TOKENS as readonly string[]).includes(key)) {
      errors.push(`unknown color token "${key}"`);
      continue;
    }
    if (!isValidHex(value)) {
      errors.push(`"${key}" must be a #rrggbb hex color`);
      continue;
    }
    colors[key as ThemeToken] = value.toLowerCase();
  }
  if (errors.length > 0) return { ok: false, errors };

  // Required base tokens — a theme without them would render unreadably.
  for (const required of ["bg", "surface", "text", "border"] as const) {
    if (!colors[required]) errors.push(`missing required token "${required}"`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const c = colors as ThemeColors;
  // Readability guards — text must be readable on its backgrounds (WCAG-ish 3:1).
  // Border contrast is deliberately NOT enforced: subtle decorative borders on
  // light surfaces are legitimate design.
  const pairs: [string, number][] = [
    ["text on bg", contrastRatio(c.text, c.bg)],
    ["text on surface", contrastRatio(c.text, c.surface)],
  ];
  for (const [label, ratio] of pairs) {
    if (ratio < 3) errors.push(`unreadable combination: ${label} (contrast ${ratio.toFixed(2)} < 3)`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], colors: c };
}

const t = (
  bg: string, surface: string, surfaceRaised: string, border: string,
  text: string, textMuted: string, primary: string, primaryText: string,
  secondary: string,
): ThemeColors => ({
  bg, surface, surfaceRaised, border, text, textMuted,
  primary, primaryText, secondary,
  sidebarBg: surface, sidebarText: text,
  navbarBg: surface, inputBg: surfaceRaised, inputBorder: border,
  modalBg: surfaceRaised,
  statusOnline: "#4ade80", statusPending: "#fbbf24", statusError: "#f87171",
  chart1: primary, chart2: secondary, chart3: textMuted,
});

/** The ten professional built-in themes (PRD §6). */
export const BUILT_IN_THEMES: ThemeDefinition[] = [
  {
    id: "nimbus-dark", name: "Nimbus Dark", mode: "dark", isBuiltIn: true,
    description: "The original NIMBUS Liquid Glass look — black canvas, white light.",
    colors: t("#000000", "#141414", "#1c1c1c", "#262626", "#ffffff", "#a3a3a3", "#ffffff", "#000000", "#8b8b8b"),
  },
  {
    id: "nimbus-light", name: "Nimbus Light", mode: "light", isBuiltIn: true,
    description: "Daylight edition of the classic NIMBUS look.",
    colors: t("#f5f6f8", "#ffffff", "#ffffff", "#d4d4d8", "#18181b", "#71717a", "#18181b", "#ffffff", "#3f3f46"),
  },
  {
    id: "pure-black", name: "Pure Black", mode: "dark", isBuiltIn: true,
    description: "Maximum contrast, zero warmth.",
    colors: t("#000000", "#0a0a0a", "#111111", "#222222", "#fafafa", "#737373", "#fafafa", "#000000", "#525252"),
  },
  {
    id: "pure-white", name: "Pure White", mode: "light", isBuiltIn: true,
    description: "Clinical white surfaces with dark ink text.",
    colors: t("#ffffff", "#ffffff", "#fafafa", "#e5e5e5", "#0a0a0a", "#6b7280", "#0a0a0a", "#ffffff", "#404040"),
  },
  {
    id: "liquid-glass", name: "Liquid Glass", mode: "dark", isBuiltIn: true,
    description: "Frosted translucency with soft highlights.",
    colors: t("#0b0d10", "#151a21", "#1d242e", "#2c3642", "#e8edf4", "#8b98a9", "#7cc4ff", "#071018", "#4f6b84"),
  },
  {
    id: "midnight-glass", name: "Midnight Glass", mode: "dark", isBuiltIn: true,
    description: "Deep indigo glass for late-night operations.",
    colors: t("#0a0a14", "#141428", "#1c1c38", "#2b2b4d", "#e6e6f5", "#9090b8", "#9d8cff", "#0a0a14", "#5c5c8f"),
  },
  {
    id: "ocean-blue", name: "Ocean Blue", mode: "dark", isBuiltIn: true,
    description: "Deep-sea blues with cyan accents.",
    colors: t("#04121f", "#0a1f33", "#0f2b45", "#1d3d5c", "#dbeeff", "#7fa3c0", "#38bdf8", "#04121f", "#0e7490"),
  },
  {
    id: "forest-green", name: "Forest Green", mode: "dark", isBuiltIn: true,
    description: "Calm woodland greens.",
    colors: t("#071410", "#0e211a", "#143026", "#204035", "#ddf3ea", "#7ba898", "#34d399", "#071410", "#166534"),
  },
  {
    id: "hacker-blue", name: "Hacker Blue", mode: "dark", isBuiltIn: true,
    description: "Terminal-inspired blues on black.",
    colors: t("#000000", "#050b14", "#081018", "#12314f", "#c9f0ff", "#5f8fb0", "#00a3ff", "#000000", "#0369a1"),
  },
  {
    id: "minimal-gray", name: "Minimal Gray", mode: "light", isBuiltIn: true,
    description: "Neutral gray surfaces, no distractions.",
    colors: t("#ececee", "#f9f9fa", "#ffffff", "#c9c9cf", "#27272a", "#8e8e96", "#3f3f46", "#ffffff", "#71717a"),
  },
];

export const BUILT_IN_THEME_IDS = BUILT_IN_THEMES.map((theme) => theme.id);

/** Built-in light/dark counterparts used by the color-mode switch. */
export const LIGHT_DARK_PAIRS: Record<string, string> = {
  "nimbus-dark": "nimbus-light",
  "nimbus-light": "nimbus-dark",
  "pure-black": "pure-white",
  "pure-white": "pure-black",
};

// ── Animation presets ─────────────────────────────────────────────

export interface AnimationPreset {
  id: string;
  name: string;
  description: string;
  /** Base duration multiplier (1 = default). */
  speed: number;
  intensity: number;
  effects: {
    pageTransitions: boolean;
    sidebarTransitions: boolean;
    modalAnimations: boolean;
    buttonHover: boolean;
    cardHover: boolean;
    chartAnimations: boolean;
    loadingAnimations: boolean;
    notificationAnimations: boolean;
    skeletonLoading: boolean;
    dropdownAnimations: boolean;
  };
}

export const ANIMATION_PRESETS: AnimationPreset[] = [
  {
    id: "minimal", name: "Minimal", speed: 1.25, intensity: 0.4,
    description: "Barely-there motion — fastest, most focused.",
    effects: { pageTransitions: false, sidebarTransitions: true, modalAnimations: true, buttonHover: true, cardHover: false, chartAnimations: false, loadingAnimations: true, notificationAnimations: false, skeletonLoading: true, dropdownAnimations: true },
  },
  {
    id: "smooth", name: "Smooth", speed: 1, intensity: 0.6,
    description: "Balanced default — subtle and professional.",
    effects: { pageTransitions: true, sidebarTransitions: true, modalAnimations: true, buttonHover: true, cardHover: true, chartAnimations: true, loadingAnimations: true, notificationAnimations: true, skeletonLoading: true, dropdownAnimations: true },
  },
  {
    id: "premium", name: "Premium", speed: 0.9, intensity: 0.8,
    description: "Slower, more deliberate glass motion.",
    effects: { pageTransitions: true, sidebarTransitions: true, modalAnimations: true, buttonHover: true, cardHover: true, chartAnimations: true, loadingAnimations: true, notificationAnimations: true, skeletonLoading: true, dropdownAnimations: true },
  },
  {
    id: "liquid-glass", name: "Liquid Glass", speed: 0.8, intensity: 1,
    description: "Signature NIMBUS feel — fluid surface motion.",
    effects: { pageTransitions: true, sidebarTransitions: true, modalAnimations: true, buttonHover: true, cardHover: true, chartAnimations: true, loadingAnimations: true, notificationAnimations: true, skeletonLoading: true, dropdownAnimations: true },
  },
  {
    id: "motion-rich", name: "Motion Rich", speed: 0.7, intensity: 1.2,
    description: "The most expressive preset — for showcase panels.",
    effects: { pageTransitions: true, sidebarTransitions: true, modalAnimations: true, buttonHover: true, cardHover: true, chartAnimations: true, loadingAnimations: true, notificationAnimations: true, skeletonLoading: true, dropdownAnimations: true },
  },
];

export const ANIMATION_PRESET_IDS = ANIMATION_PRESETS.map((p) => p.id);

export const isValidPresetId = (id: unknown): id is string =>
  typeof id === "string" && (ANIMATION_PRESET_IDS as string[]).includes(id);
