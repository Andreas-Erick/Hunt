import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    // QUEST_ACCENT_STYLES (src/lib/db.ts) holds class names used nowhere else.
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        void: {
          DEFAULT: "#07080a",
          950: "#050608",
          900: "#0a0c10",
          800: "#0f131a",
          700: "#161c26",
          600: "#1f2937",
        },
        hud: {
          cyan: "#00f0ff",
          emerald: "#00ff9d",
          amber: "#ffb800",
          purple: "#b388ff",
          rose: "#ff6b9d",
          sky: "#38bdf8",
          orange: "#ff8547",
          lime: "#a3e635",
          crimson: "#ff2a5f",
          slate: "#64748b",
          // Slate-tinted secondary text / placeholders: >= 5.9:1 (WCAG AA) on #0b0c0e, #0d0f14, #111318 and #14171f.
          muted: "#8c96a8",
          border: "rgba(0, 240, 255, 0.18)",
        },
      },
      fontFamily: {
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-space-grotesk)", "sans-serif"],
      },
      boxShadow: {
        "neon-cyan": "0 0 15px rgba(0, 240, 255, 0.28), inset 0 0 12px rgba(0, 240, 255, 0.08)",
        "neon-cyan-strong": "0 0 25px rgba(0, 240, 255, 0.5), inset 0 0 15px rgba(0, 240, 255, 0.15)",
        "neon-emerald": "0 0 15px rgba(0, 255, 157, 0.28), inset 0 0 12px rgba(0, 255, 157, 0.08)",
        "neon-amber": "0 0 15px rgba(255, 184, 0, 0.28), inset 0 0 12px rgba(255, 184, 0, 0.08)",
        "neon-purple": "0 0 15px rgba(179, 136, 255, 0.28), inset 0 0 12px rgba(179, 136, 255, 0.08)",
        "neon-rose": "0 0 15px rgba(255, 107, 157, 0.28), inset 0 0 12px rgba(255, 107, 157, 0.08)",
        "neon-sky": "0 0 15px rgba(56, 189, 248, 0.28), inset 0 0 12px rgba(56, 189, 248, 0.08)",
        "neon-orange": "0 0 15px rgba(255, 133, 71, 0.28), inset 0 0 12px rgba(255, 133, 71, 0.08)",
        "neon-lime": "0 0 15px rgba(163, 230, 53, 0.28), inset 0 0 12px rgba(163, 230, 53, 0.08)",
        "neon-crimson": "0 0 15px rgba(255, 42, 95, 0.35), inset 0 0 12px rgba(255, 42, 95, 0.1)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "scanline": "scanline 8s linear infinite",
      },
      keyframes: {
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(1000%)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
