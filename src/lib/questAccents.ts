import type { QuestAccent } from "./domainTypes";

export interface QuestAccentStyle {
  label: string;
  hex: string;
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
    hex: "#00f0ff",
    border: "border-[#00f0ff]/40",
    bg: "bg-[#00f0ff]",
    bgSubtle: "bg-[#00f0ff]/10",
    text: "text-[#00f0ff]",
    glow: "shadow-neon-cyan",
    badge: "border-[#00f0ff]/40 bg-[#00f0ff]/10 text-[#00f0ff]",
    dot: "bg-[#00f0ff]",
  },
  emerald: {
    label: "Emerald",
    hex: "#00ff9d",
    border: "border-[#00ff9d]/40",
    bg: "bg-[#00ff9d]",
    bgSubtle: "bg-[#00ff9d]/10",
    text: "text-[#00ff9d]",
    glow: "shadow-neon-emerald",
    badge: "border-[#00ff9d]/40 bg-[#00ff9d]/10 text-[#00ff9d]",
    dot: "bg-[#00ff9d]",
  },
  amber: {
    label: "Amber",
    hex: "#ffb800",
    border: "border-[#ffb800]/40",
    bg: "bg-[#ffb800]",
    bgSubtle: "bg-[#ffb800]/10",
    text: "text-[#ffb800]",
    glow: "shadow-neon-amber",
    badge: "border-[#ffb800]/40 bg-[#ffb800]/10 text-[#ffb800]",
    dot: "bg-[#ffb800]",
  },
  purple: {
    label: "Purple",
    hex: "#b388ff",
    border: "border-[#b388ff]/40",
    bg: "bg-[#b388ff]",
    bgSubtle: "bg-[#b388ff]/10",
    text: "text-[#b388ff]",
    glow: "shadow-neon-purple",
    badge: "border-[#b388ff]/40 bg-[#b388ff]/10 text-[#b388ff]",
    dot: "bg-[#b388ff]",
  },
  rose: {
    label: "Rose",
    hex: "#ff6b9d",
    border: "border-[#ff6b9d]/40",
    bg: "bg-[#ff6b9d]",
    bgSubtle: "bg-[#ff6b9d]/10",
    text: "text-[#ff6b9d]",
    glow: "shadow-neon-rose",
    badge: "border-[#ff6b9d]/40 bg-[#ff6b9d]/10 text-[#ff6b9d]",
    dot: "bg-[#ff6b9d]",
  },
  sky: {
    label: "Sky",
    hex: "#38bdf8",
    border: "border-[#38bdf8]/40",
    bg: "bg-[#38bdf8]",
    bgSubtle: "bg-[#38bdf8]/10",
    text: "text-[#38bdf8]",
    glow: "shadow-neon-sky",
    badge: "border-[#38bdf8]/40 bg-[#38bdf8]/10 text-[#38bdf8]",
    dot: "bg-[#38bdf8]",
  },
  orange: {
    label: "Orange",
    hex: "#ff8547",
    border: "border-[#ff8547]/40",
    bg: "bg-[#ff8547]",
    bgSubtle: "bg-[#ff8547]/10",
    text: "text-[#ff8547]",
    glow: "shadow-neon-orange",
    badge: "border-[#ff8547]/40 bg-[#ff8547]/10 text-[#ff8547]",
    dot: "bg-[#ff8547]",
  },
  lime: {
    label: "Lime",
    hex: "#a3e635",
    border: "border-[#a3e635]/40",
    bg: "bg-[#a3e635]",
    bgSubtle: "bg-[#a3e635]/10",
    text: "text-[#a3e635]",
    glow: "shadow-neon-lime",
    badge: "border-[#a3e635]/40 bg-[#a3e635]/10 text-[#a3e635]",
    dot: "bg-[#a3e635]",
  },
  slate: {
    label: "Other",
    hex: "#64748b",
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
