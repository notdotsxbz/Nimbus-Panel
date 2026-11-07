"use client";

import { api } from "@/lib/api";
import { LIGHT_DARK_PAIRS, type ThemeColors } from "@nimbus/shared";

/**
 * Theme engine. Themes are token maps applied as CSS variables — never
 * arbitrary CSS. The resolved appearance is cached in localStorage so the
 * inline script in the document <head> can apply it BEFORE first paint
 * (no layout shift, no flash), then re-synced from the API.
 */

const VAR_MAP: Record<keyof ThemeColors, string> = {
  bg: "--nb-bg",
  surface: "--nb-surface",
  surfaceRaised: "--nb-surface-raised",
  border: "--nb-border",
  text: "--nb-text",
  textMuted: "--nb-text-muted",
  primary: "--nb-primary",
  primaryText: "--nb-primary-text",
  secondary: "--nb-secondary",
  sidebarBg: "--nb-sidebar-bg",
  sidebarText: "--nb-sidebar-text",
  navbarBg: "--nb-navbar-bg",
  inputBg: "--nb-input-bg",
  inputBorder: "--nb-input-border",
  modalBg: "--nb-modal-bg",
  statusOnline: "--nb-status-online",
  statusPending: "--nb-status-pending",
  statusError: "--nb-status-error",
  chart1: "--nb-chart-1",
  chart2: "--nb-chart-2",
  chart3: "--nb-chart-3",
};

export const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function hexToRgb(hex: string): string {
  const v = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return "255, 255, 255";
  return `${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  return `rgba(${hexToRgb(hex)}, ${alpha})`;
}

export function applyThemeColors(colors: ThemeColors): void {
  const root = document.documentElement;
  for (const [token, cssVar] of Object.entries(VAR_MAP)) {
    const value = colors[token as keyof ThemeColors];
    if (value) root.style.setProperty(cssVar, value);
  }
  root.style.setProperty("--nb-primary-rgb", hexToRgb(colors.primary));
  // Glass surfaces derive from the theme's text color — works in both modes.
  root.style.setProperty("--nb-glass-bg", hexToRgba(colors.text, 0.055));
  root.style.setProperty("--nb-glass-2", hexToRgba(colors.text, 0.035));
  root.style.setProperty("--nb-glass-3", hexToRgba(colors.text, 0.09));
  root.dataset.colorMode = colors.bg && relativeLum(colors.bg) > 0.5 ? "light" : "dark";
}

function relativeLum(hex: string): number {
  const v = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return 0;
  const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export interface AnimationConfig {
  enabled: boolean;
  speed: number;
  intensity: number;
  effects: Record<string, boolean>;
}

export function applyAnimationConfig(cfg: AnimationConfig): void {
  const root = document.documentElement;
  const off = !cfg.enabled || cfg.effects === undefined;
  root.dataset.animations = off ? "off" : "on";
  root.style.setProperty("--nb-anim-speed", String(cfg.speed ?? 1));
  root.style.setProperty("--nb-anim-intensity", String(cfg.intensity ?? 0.8));
  // Reduced-motion users always get the static experience.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.dataset.animations = "off";
  }
}

export interface AppearanceSnapshot {
  themeKey: string;
  colors: ThemeColors;
  animation: AnimationConfig;
}

const CACHE_KEY = "nimbus.appearance";

export function cachedAppearance(): AppearanceSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppearanceSnapshot) : null;
  } catch {
    return null;
  }
}

export function persistAppearance(snap: AppearanceSnapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snap));
  } catch {
    /* storage unavailable */
  }
}

/** Applies a snapshot to the live document and caches it. */
export function applySnapshot(snap: AppearanceSnapshot): void {
  applyThemeColors(snap.colors);
  applyAnimationConfig(snap.animation);
  persistAppearance(snap);
}

interface PublicSettings {
  defaultThemeKey: string;
  defaultAnimationPreset: string;
  animationsEnabled: boolean;
  allowCustomerThemes: boolean;
  allowCustomerAnimations: boolean;
}

interface MeAppearance {
  themeKey: string;
  colorMode: string;
  animationsEnabled: boolean;
  reducedMotion: boolean;
  animationPreset: string;
}

interface ThemeRow {
  key: string;
  name: string;
  colors: ThemeColors;
  mode: "light" | "dark";
  isBuiltIn: boolean;
}

/**
 * Re-syncs appearance from the API: user preference → published theme →
 * color-mode pairing → global animation settings. Falls back to the cache
 * on any failure so the UI never renders unthemed.
 */
export async function syncAppearance(): Promise<void> {
  try {
    const token = localStorage.getItem("nimbus.token");
    const [settings, themes] = await Promise.all([
      api.get<PublicSettings>("/appearance/public-settings"),
      api.get<{ items?: ThemeRow[] } | ThemeRow[]>("/appearance/themes"),
    ]);
    const themeRows = Array.isArray(themes) ? themes : themes.items ?? [];

    let me: MeAppearance | null = null;
    if (token) {
      me = await api.get<MeAppearance>("/appearance/me");
    }

    let themeKey = me?.themeKey ?? settings.defaultThemeKey;
    // Color-mode pairing for built-in light/dark counterparts.
    if (me && (me.colorMode === "light" || me.colorMode === "dark")) {
      const current = themeRows.find((t) => t.key === themeKey);
      if (current && current.mode !== me.colorMode) {
        const pair = LIGHT_DARK_PAIRS[current.key];
        if (pair) themeKey = pair;
      }
    }

    const theme = themeRows.find((t) => t.key === themeKey) ?? themeRows[0];
    if (!theme) return;

    const presetId = me?.animationPreset ?? settings.defaultAnimationPreset;
    const preset = await api.get<{ id: string; speed: number; intensity: number; effects: Record<string, boolean> }[]>(
      "/appearance/presets",
    ).then((rows) => (Array.isArray(rows) ? rows : []).find((p) => p.id === presetId)).catch(() => undefined);

    applySnapshot({
      themeKey: theme.key,
      colors: theme.colors,
      animation: {
        enabled: settings.animationsEnabled && (me?.animationsEnabled ?? true),
        speed: preset?.speed ?? 1,
        intensity: preset?.intensity ?? 0.8,
        effects: preset?.effects ?? {},
      },
    });
  } catch {
    const cached = cachedAppearance();
    if (cached) applySnapshot(cached);
  }
}

/** Inlined into <head> in layout.tsx — applies the cached theme pre-paint. */
export const NO_FLASH_SCRIPT = `(function(){try{var a=JSON.parse(localStorage.getItem("nimbus.appearance"));if(!a||!a.colors)return;var m={"bg":"--nb-bg","surface":"--nb-surface","surfaceRaised":"--nb-surface-raised","border":"--nb-border","text":"--nb-text","textMuted":"--nb-text-muted","primary":"--nb-primary","primaryText":"--nb-primary-text","secondary":"--nb-secondary","sidebarBg":"--nb-sidebar-bg","sidebarText":"--nb-sidebar-text","navbarBg":"--nb-navbar-bg","inputBg":"--nb-input-bg","inputBorder":"--nb-input-border","modalBg":"--nb-modal-bg","statusOnline":"--nb-status-online","statusPending":"--nb-status-pending","statusError":"--nb-status-error","chart1":"--nb-chart-1","chart2":"--nb-chart-2","chart3":"--nb-chart-3"};for(var k in m){if(a.colors[k])document.documentElement.style.setProperty(m[k],a.colors[k])}if(a.animation){document.documentElement.dataset.animations=a.animation.enabled===false?"off":"on";if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.dataset.animations="off"}}catch(e){}})();`;
