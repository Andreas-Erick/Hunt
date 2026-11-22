import type { QuestAccent } from "./domainTypes";

export interface QuestAccentStyle {
  label: string;
  /** Token holding this colour's "R G B" channels; changes with the look (ADR-0005). */
  cssVar: string;
  border: string;
  bg: string;
  bgSubtle: string;
  text: string;
  glow: string;
  badge: string;
  dot: string;
}

export const QUEST_ACCENT_STYLES: Record<QuestAccent | "slate", QuestAccentStyle> = {
  cyan: {
    label: "Cyan",
    cssVar: "--q-cyan",
    border: "border-q-cyan/40",
    bg: "bg-q-cyan",
    bgSubtle: "bg-q-cyan/10",
    text: "text-q-cyan",
    glow: "shadow-neon-cyan",
    badge: "border-q-cyan/40 bg-q-cyan/10 text-q-cyan",
    dot: "bg-q-cyan",
  },
  emerald: {
    label: "Emerald",
    cssVar: "--q-emerald",
    border: "border-q-emerald/40",
    bg: "bg-q-emerald",
    bgSubtle: "bg-q-emerald/10",
    text: "text-q-emerald",
    glow: "shadow-neon-emerald",
    badge: "border-q-emerald/40 bg-q-emerald/10 text-q-emerald",
    dot: "bg-q-emerald",
  },
  amber: {
    label: "Amber",
    cssVar: "--q-amber",
    border: "border-q-amber/40",
    bg: "bg-q-amber",
    bgSubtle: "bg-q-amber/10",
    text: "text-q-amber",
    glow: "shadow-neon-amber",
    badge: "border-q-amber/40 bg-q-amber/10 text-q-amber",
    dot: "bg-q-amber",
  },
  purple: {
    label: "Purple",
    cssVar: "--q-purple",
    border: "border-q-purple/40",
    bg: "bg-q-purple",
    bgSubtle: "bg-q-purple/10",
    text: "text-q-purple",
    glow: "shadow-neon-purple",
    badge: "border-q-purple/40 bg-q-purple/10 text-q-purple",
    dot: "bg-q-purple",
  },
  rose: {
    label: "Rose",
    cssVar: "--q-rose",
    border: "border-q-rose/40",
    bg: "bg-q-rose",
    bgSubtle: "bg-q-rose/10",
    text: "text-q-rose",
    glow: "shadow-neon-rose",
    badge: "border-q-rose/40 bg-q-rose/10 text-q-rose",
    dot: "bg-q-rose",
  },
  sky: {
    label: "Sky",
    cssVar: "--q-sky",
    border: "border-q-sky/40",
    bg: "bg-q-sky",
    bgSubtle: "bg-q-sky/10",
    text: "text-q-sky",
    glow: "shadow-neon-sky",
    badge: "border-q-sky/40 bg-q-sky/10 text-q-sky",
    dot: "bg-q-sky",
  },
  orange: {
    label: "Orange",
    cssVar: "--q-orange",
    border: "border-q-orange/40",
    bg: "bg-q-orange",
    bgSubtle: "bg-q-orange/10",
    text: "text-q-orange",
    glow: "shadow-neon-orange",
    badge: "border-q-orange/40 bg-q-orange/10 text-q-orange",
    dot: "bg-q-orange",
  },
  lime: {
    label: "Lime",
    cssVar: "--q-lime",
    border: "border-q-lime/40",
    bg: "bg-q-lime",
    bgSubtle: "bg-q-lime/10",
    text: "text-q-lime",
    glow: "shadow-neon-lime",
    badge: "border-q-lime/40 bg-q-lime/10 text-q-lime",
    dot: "bg-q-lime",
  },
  slate: {
    label: "Other",
    cssVar: "--q-slate",
    border: "border-white/15",
    bg: "bg-slate-500",
    bgSubtle: "bg-white/[0.04]",
    text: "text-neutral-400",
    glow: "",
    badge: "border-white/10 bg-white/[0.03] text-neutral-400",
    dot: "bg-neutral-500",
  },
};

function isAccentStyleKey(key: unknown): key is keyof typeof QUEST_ACCENT_STYLES {
  return (
    typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(QUEST_ACCENT_STYLES, key)
  );
}

/**
 * Style for a data-driven accent key (quest accent or time-log snapshot).
 * Anything that is not an own key of QUEST_ACCENT_STYLES (unknown colour,
 * missing field, "__proto__", "toString", a number) falls back to slate, so a
 * bad synced row cannot crash a render.
 */
export function accentStyle(key: unknown): QuestAccentStyle {
  return isAccentStyleKey(key) ? QUEST_ACCENT_STYLES[key] : QUEST_ACCENT_STYLES.slate;
}

/**
 * CSS colour for inline styles and SVG, following the current look.
 * `alpha` is 0-1.
 */
export function accentColor(style: Pick<QuestAccentStyle, "cssVar">, alpha = 1): string {
  return alpha >= 1 ? `rgb(var(${style.cssVar}))` : `rgb(var(${style.cssVar}) / ${alpha})`;
}
