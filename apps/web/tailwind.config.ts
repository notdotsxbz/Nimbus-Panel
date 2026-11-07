import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Theme-aware tokens — every utility (bg-ink, text-muted, glass…)
        // follows the active theme via CSS variables (set by the
        // appearance system; defaults come from Nimbus Dark).
        ink: "var(--nb-bg)",
        paper: "var(--nb-text)",
        muted: "var(--nb-text-muted)",
        surface: "var(--nb-surface)",
        glass: "var(--nb-glass-bg)",
        "glass-2": "var(--nb-glass-2)",
        "glass-3": "var(--nb-glass-3)",
        line: "var(--nb-border)",
        hi: "var(--nb-border-strong)",
        ok: "var(--nb-status-online)",
        warn: "var(--nb-status-pending)",
        err: "var(--nb-status-error)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: { xl: "1rem", "2xl": "1.25rem" },
    },
  },
  plugins: [],
};

export default config;
