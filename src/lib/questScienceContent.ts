import type { QuestAccent } from "./domainTypes";

export type GuideTabId = "quests" | "tasks" | "system" | "workshop";

export interface SciencePrinciple {
  id: string;
  number: string;
  title: string;
  citation: string;
  accent: QuestAccent;
  science: string;
  inHunt: string;
  avoid: string;
  aimFor: string;
}

export interface RhythmStep {
  id: string;
  step: string;
  title: string;
  view: "quests" | "plan" | "command" | "telemetry";
  viewLabel: string;
  accent: QuestAccent;
  citation: string;
  summary: string;
  practice: string;
}

export interface TaskWorkshopPreset {
  id: string;
  label: string;
  kind: "weak" | "strong";
  title: string;
  notes: string;
}

export interface QuestWorkshopPreset {
  id: string;
  label: string;
  kind: "weak" | "strong";
  title: string;
  description: string;
  targetWeeklyHours: number;
  accent: QuestAccent;
}

export const GUIDE_TABS: ReadonlyArray<{
  id: GuideTabId;
  label: string;
  shortDesc: string;
}> = [
  { id: "quests", label: "Quests", shortDesc: "Designing high-level goals" },
  { id: "tasks", label: "Tasks", shortDesc: "Writing friction-free steps" },
  { id: "system", label: "Weekly System", shortDesc: "The 4-step calm rhythm" },
  { id: "workshop", label: "Workshop & Audit", shortDesc: "Test drafts & check your setup" },
];

export const QUEST_PRINCIPLES: ReadonlyArray<SciencePrinciple> = [
  {
    id: "goal-shielding",
    number: "01",
    title: "Cap active Quests at 1 to 3",
    citation: "Goal Shielding · Shah, Friedman & Kruglanski (2002); Cowan (2001)",
    accent: "cyan",
    science:
      "Working memory holds roughly 3 to 4 active chunks. When you commit to 1–3 focal goals, your brain automatically suppresses competing distractions (goal shielding). Tracking 6+ priorities at once fragments commitment and triggers decision paralysis.",
    inHunt:
      "Keep 1 to 3 active Quests with distinct color identities. Everything else belongs in Other work or waits until a slot opens.",
    avoid: "7 vague life buckets: Career, Health, Finance, Reading, Social, Side Hustle, Admin",
    aimFor: "3 clear Quests: Launch my idea (12h), Write every week (5h), Run a half marathon (4h)",
  },
  {
    id: "input-over-output",
    number: "02",
    title: "Measure weekly input hours, not distant outcomes",
    citation: "Goal-Setting Theory · Locke & Latham (2002); Self-Efficacy · Bandura (1997)",
    accent: "emerald",
    science:
      "Distant outcome goals ('get 10,000 users') suffer from delayed, noisy feedback outside your direct control. Calibrating a realistic weekly input target (hours of deliberate work) produces frequent mastery wins that compound self-efficacy through plateaus.",
    inHunt:
      "Set each Quest's weekly target (h/wk) to a sustainable deep-work budget — usually 12 to 25 hours combined across all Quests.",
    avoid: "Become a bestselling author this year (zero weekly signal you control)",
    aimFor: "Write every week — 5 h/wk of focused drafting and editing",
  },
  {
    id: "intrinsic-anchor",
    number: "03",
    title: "Anchor every Quest to intrinsic meaning",
    citation: "Self-Determination Theory · Deci & Ryan (2000)",
    accent: "amber",
    science:
      "Goals fueled by autonomy (chosen by you), competence (visible craft growth), and personal purpose outperform external 'should' obligations on persistence and well-being — especially once initial novelty fades.",
    inHunt:
      "Use the Quest Description to state why this pursuit matters to you and what concrete kind of work actually moves it forward.",
    avoid: "Empty description, or 'Because I should work harder'",
    aimFor: "Primary product engineering and shipping v1 so I master building software end-to-end.",
  },
  {
    id: "protect-deep-work",
    number: "04",
    title: "Separate Quest work from Maintenance ('Other')",
    citation: "Attention Residue · Leroy (2009); Deep Work · Newport (2016)",
    accent: "cyan",
    science:
      "Shallow admin tasks (invoices, inbox replies, errands) close fast and deliver quick relief, silently crowding out cognitively demanding creative work when both are counted in the same bucket.",
    inHunt:
      "Tag operational chores as Other (slate). Check your Quest vs. Other ratio in Review each week so Quest hours stay honest.",
    avoid: "Logging tax emails and receipt filing under your 'Launch my idea' Quest",
    aimFor: "Tagging 'Reconcile monthly cloud invoices' under Other so deep work is measured cleanly",
  },
];

export const TASK_PRINCIPLES: ReadonlyArray<SciencePrinciple> = [
  {
    id: "implementation-intentions",
    number: "01",
    title: "Start with a concrete physical verb",
    citation: "Implementation Intentions · Gollwitzer (1999); Gollwitzer & Sheeran (2006)",
    accent: "cyan",
    science:
      "Across 94 studies (effect size d ≈ 0.65), specifying the exact observable action shifts execution from fragile willpower to automatic cue-response. Ambiguous nouns force you to plan before you can start — the #1 trigger for procrastination.",
    inHunt:
      "Phrase every task so the first 30 seconds are unmistakable the moment you press Focus.",
    avoid: "Website · Essay · Work on marathon prep",
    aimFor: "Sketch 3 hero layout wireframes on paper · Draft the opening 400 words of essay #4",
  },
  {
    id: "single-sitting-scope",
    number: "02",
    title: "Size tasks to one focus bout (20–90 min)",
    citation: "Zeigarnik Effect · Masicampo & Baumeister (2011); Flow · Csikszentmihalyi",
    accent: "emerald",
    science:
      "Oversized, open-ended items create intrusive mental tension ('Zeigarnik residue') and feel intimidating to begin. Deep focus peaks in 25–90 minute bouts; anything spanning days is a hidden project that needs slicing.",
    inHunt:
      "Break milestones into single-sitting actions. If a task sits untouched for two days, split it in half until starting feels easy.",
    avoid: "Build entire authentication, onboarding, and billing system",
    aimFor: "Implement password-reset token validation and add boundary tests",
  },
  {
    id: "clear-done-line",
    number: "03",
    title: "Define a visible 'Done' line",
    citation: "Progress Principle · Amabile & Kramer (2011); Locke & Latham (2002)",
    accent: "amber",
    science:
      "Visible daily progress on meaningful work is the strongest driver of sustained motivation. Without a clear finish line, your brain never registers completion — leaving you fatigued even after hours of effort.",
    inHunt:
      "Include a crisp boundary in the title or add a 1-line Definition of Done in the task Notes drawer before you hit Start.",
    avoid: "Research marketing strategies (infinite rabbit hole)",
    aimFor: "Read 3 competitor pricing pages and summarize 5 takeaways in Notes",
  },
  {
    id: "single-task-sequence",
    number: "04",
    title: "Rank and execute one task at a time",
    citation: "Task-Switching Cost · Rubinstein, Meyer & Evans (2001); Leroy (2009)",
    accent: "cyan",
    science:
      "Switching between unfinished tasks can cost 20–40% in executive-control overhead and leaves attention residue from the prior task. Sequential single-tasking beats parallel juggling on both speed and depth.",
    inHunt:
      "Order your top 3–5 priorities on Home, enter distraction-free Focus, and let completed bursts build Today's Done-List.",
    avoid: "Keeping 8 'urgent' tasks half-open across tabs all afternoon",
    aimFor: "Lock onto rank #1 in Focus until finished or intentionally paused",
  },
];

export const RHYTHM_STEPS: ReadonlyArray<RhythmStep> = [
  {
    id: "step-quests",
    step: "Step 1",
    title: "Choose 1–3 Quests & weekly hour targets",
    view: "quests",
    viewLabel: "Open Quests",
    accent: "cyan",
    citation: "Goal Shielding & Self-Efficacy",
    summary:
      "Set a focused roster of 1–3 Quests with honest weekly input budgets (typically 12–25 h/wk total deep work).",
    practice:
      "Keep descriptions centered on why the Quest matters and what high-leverage work moves it forward.",
  },
  {
    id: "step-plan",
    step: "Step 2",
    title: "Sketch 2–4 concrete steps per day",
    view: "plan",
    viewLabel: "Open Plan",
    accent: "amber",
    citation: "Planning Fallacy · Kahneman & Tversky (1979)",
    summary:
      "Rigid hour-by-hour calendars shatter on the first unexpected interruption. A light daily list of 2–4 well-scoped tasks absorbs real-world variance without guilt.",
    practice:
      "Spend 5 minutes the evening before picking tomorrow's concrete #1 step so you start with zero friction.",
  },
  {
    id: "step-focus",
    step: "Step 3",
    title: "Single-task in Focus & build a Done-List",
    view: "command",
    viewLabel: "Open Home",
    accent: "emerald",
    citation: "Implementation Intentions & Progress Principle",
    summary:
      "Work top-down from rank #1 in distraction-free Focus. Instead of judging yourself against an idealized schedule, watch your completed blocks form an honest Done-List timeline.",
    practice:
      "When resistance spikes, commit to just 10 minutes on the first concrete verb — initiation breaks inertia.",
  },
  {
    id: "step-review",
    step: "Step 4",
    title: "Review ratios & recalibrate weekly",
    view: "telemetry",
    viewLabel: "Open Review",
    accent: "cyan",
    citation: "Feedback Loops & Abstinence-Violation Guard",
    summary:
      "Once a week, compare logged Quest hours against targets and inspect your Quest vs. Other balance. Missing a target is calibration data, not moral failure.",
    practice:
      "If you miss a weekly target two weeks in a row, lower the target by 20% to rebuild reliable momentum.",
  },
];

export const TASK_LAB_PRESETS: ReadonlyArray<TaskWorkshopPreset> = [
  {
    id: "weak-vague",
    label: "Weak: Vague noun",
    kind: "weak",
    title: "Website",
    notes: "",
  },
  {
    id: "weak-project",
    label: "Weak: Hidden project",
    kind: "weak",
    title: "Work on entire launch and marketing and docs",
    notes: "",
  },
  {
    id: "strong-writing",
    label: "Strong: Writing",
    kind: "strong",
    title: "Draft 500 words for the intro section of essay #4",
    notes: "Done when the hook, core thesis, and 1 concrete example are written.",
  },
  {
    id: "strong-coding",
    label: "Strong: Building",
    kind: "strong",
    title: "Implement CSV export button and verify 3 edge cases",
    notes: "Test empty table, commas in titles, and UTF-8 characters.",
  },
];

export const QUEST_LAB_PRESETS: ReadonlyArray<QuestWorkshopPreset> = [
  {
    id: "weak-overbooked",
    label: "Weak: Vague & overbooked",
    kind: "weak",
    title: "Be successful",
    description: "",
    targetWeeklyHours: 45,
    accent: "cyan",
  },
  {
    id: "strong-craft",
    label: "Strong: Calibrated craft",
    kind: "strong",
    title: "Ship v1 of my audio plugin",
    description:
      "Build core DSP engine, minimal UI, and beta test with 5 musicians to master real-time audio engineering.",
    targetWeeklyHours: 10,
    accent: "emerald",
  },
];
