import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#000000",
        paper: "#FFFFFF",
        muted: "#A3A3A3",
        surface: "#151515",
        glass: "rgba(255,255,255,0.055)",
        "glass-2": "rgba(255,255,255,0.035)",
        "glass-3": "rgba(255,255,255,0.09)",
        line: "rgba(255,255,255,0.15)",
        hi: "rgba(255,255,255,0.18)",
        ok: "#4ADE80",
        warn: "#FBBF24",
        err: "#F87171",
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
