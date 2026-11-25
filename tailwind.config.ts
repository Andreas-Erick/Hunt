import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

// Every colour resolves to a token in src/app/globals.css (ADR-0005), so the
// Neon and Dawn looks repaint by swapping one attribute on <html>.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const quest = (key: string) => ({ DEFAULT: token(`q-${key}`), hi: token(`q-${key}-hi`) });

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    // QUEST_ACCENT_STYLES (src/lib/questAccents.ts) holds class names used nowhere else.
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        white: token("c-ink"),
        black: token("c-black"),
        neutral: {
          100: token("c-neutral-100"),
          200: token("c-neutral-200"),
          300: token("c-neutral-300"),
          400: token("c-neutral-400"),
          500: token("c-neutral-500"),
          600: token("c-neutral-600"),
        },
        slate: {
          100: token("c-neutral-100"),
          200: token("c-slate-200"),
          300: token("c-slate-300"),
          400: token("c-slate-400"),
          500: token("c-slate-500"),
        },
        // Grounds, darkest to lightest
        void: token("c-void"),
        base: token("c-base"),
        sunken: token("c-sunken"),
        surface: token("c-surface"),
        raised: { DEFAULT: token("c-raised"), 2: token("c-raised-2") },
        edge: { DEFAULT: token("c-edge"), 2: token("c-edge-2") },
        // Roles
        accent: { DEFAULT: token("c-accent"), hi: token("c-accent-hi") },
        success: { DEFAULT: token("c-success"), hi: token("c-success-hi") },
        warning: { DEFAULT: token("c-warning"), hi: token("c-warning-hi") },
        danger: token("c-danger"),
        now: token("c-now"),
        // Quest colours, keyed like the stored accentColor values
        q: {
          cyan: quest("cyan"),
          emerald: quest("emerald"),
          amber: quest("amber"),
          purple: quest("purple"),
          rose: quest("rose"),
          sky: quest("sky"),
          orange: quest("orange"),
          lime: quest("lime"),
          slate: token("q-slate"),
        },
        hud: {
          cyan: token("c-accent"),
          emerald: token("c-success"),
          amber: token("c-warning"),
          crimson: token("c-danger"),
          purple: token("q-purple"),
          rose: token("q-rose"),
          sky: token("q-sky"),
          orange: token("q-orange"),
          lime: token("q-lime"),
          slate: token("q-slate"),
          // Secondary text / placeholders: >= 5.0:1 (WCAG AA) on void through raised-2 in both
          // looks; ~4.4:1 on edge, so never use it as text on an `edge` fill.
          muted: token("c-muted"),
          border: "rgb(var(--c-accent) / 0.18)",
        },
      },
      fontFamily: {
        sans: ["var(--font-body)"],
        mono: ["var(--font-numeric)"],
        display: ["var(--font-heading)"],
        chrono: ["var(--font-chrono)"],
      },
      boxShadow: {
        "neon-cyan": "var(--glow-cyan)",
        "neon-cyan-strong": "var(--glow-cyan-strong)",
        "neon-emerald": "var(--glow-emerald)",
        "neon-amber": "var(--glow-amber)",
        "neon-purple": "var(--glow-purple)",
        "neon-rose": "var(--glow-rose)",
        "neon-sky": "var(--glow-sky)",
        "neon-orange": "var(--glow-orange)",
        "neon-lime": "var(--glow-lime)",
        "neon-crimson": "var(--glow-crimson)",
        "dot-success": "var(--glow-dot-success)",
        "dot-now": "var(--glow-dot-now)",
        "card-accent": "var(--glow-card-accent)",
        "card-success": "var(--glow-card-success)",
        "card-warning": "var(--glow-card-warning)",
        "lift-success": "var(--glow-lift-success)",
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
    // `text-base` must stay the 16px font size only. With the `base` ground in the text
    // colours it also painted text in the page background colour (invisible wherever the
    // generated colour rule outranked the element's own text colour).
    textColor: ({ theme }) => {
      const { base: _base, ...colors } = theme("colors");
      return colors;
    },
  },
  plugins: [
    // Touch tablets: `coarse:` raises targets toward 44px; `hoverless:` reveals
    // controls that mouse users only see on hover.
    plugin(({ addVariant }) => {
      addVariant("coarse", "@media (pointer: coarse)");
      addVariant("hoverless", "@media (hover: none)");
    }),
  ],
};

export default config;
