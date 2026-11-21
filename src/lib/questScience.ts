import type { Quest, Task } from "./domainTypes";

export type CheckStatus = "pass" | "warn" | "fail";
export type DraftVerdict = "empty" | "weak" | "fair" | "strong";

export interface ScienceCheck {
  id: string;
  label: string;
  status: CheckStatus;
  principle: string;
  detail: string;
}

export interface DraftEvaluation {
  verdict: DraftVerdict;
  score: number;
  maxScore: number;
  summary: string;
  checks: ScienceCheck[];
}

export interface QuestDraftInput {
  title: string;
  description?: string;
  targetWeeklyHours: number;
  existingQuestCount?: number;
  existingWeeklyHours?: number;
}

export interface TaskAuditSuggestion {
  taskId: string;
  title: string;
  questId: string | null;
  verdict: Exclude<DraftVerdict, "empty">;
  topTip: string;
}

export interface WorkspaceAudit {
  activeQuestCount: number;
  questLoadStatus: "empty" | "optimal" | "stretched";
  questLoadMessage: string;
  weeklyBudgetHours: number;
  budgetStatus: "none" | "sustainable" | "ambitious" | "overbooked";
  budgetMessage: string;
  openTaskCount: number;
  questTaskCount: number;
  otherTaskCount: number;
  strongTaskCount: number;
  clarityPct: number;
  tasksToSharpen: TaskAuditSuggestion[];
}

/** Upper bound on inspected characters to guarantee O(1)-bounded work on huge strings. */
const MAX_ANALYZED_CHARS = 1000;
const MAX_SUGGESTIONS = 5;

const CONCRETE_VERBS: ReadonlySet<string> = new Set([
  "add", "analyze", "answer", "apply", "archive", "arrange", "assemble", "audit",
  "backup", "benchmark", "bike", "book", "brainstorm", "build", "buy",
  "calculate", "calibrate", "call", "cancel", "capture", "check", "clean", "clear",
  "close", "code", "collect", "compare", "compile", "complete", "compose", "configure",
  "confirm", "connect", "contact", "convert", "cook", "copy", "correct", "create", "cut",
  "debug", "decline", "define", "delete", "deliver", "deploy", "design", "diagnose",
  "document", "download", "draft", "draw", "edit", "email", "enable", "estimate",
  "evaluate", "export", "extract", "file", "fill", "filter", "finalize", "find",
  "finish", "fix", "follow", "format", "gather", "generate", "group", "implement",
  "import", "improve", "inspect", "install", "integrate", "interview", "invite",
  "jog", "journal", "launch", "learn", "lift", "link", "list", "log",
  "mail", "make", "map", "measure", "meditate", "merge", "message", "migrate", "mock",
  "model", "monitor", "move", "name", "negotiate", "note", "open", "optimize", "order",
  "organize", "outline", "pack", "paint", "parse", "patch", "pay", "perform", "pick",
  "pitch", "plan", "play", "polish", "post", "practice", "prepare", "present", "print",
  "prioritize", "profile", "proofread", "prototype", "prune", "publish", "pull", "push",
  "query", "read", "rebuild", "reconcile", "record", "refactor", "refine", "register",
  "release", "remove", "rename", "repair", "replace", "reply", "report", "request",
  "research", "reset", "resolve", "restructure", "review", "revise", "rewrite", "run",
  "save", "scan", "schedule", "scope", "score", "script", "search", "select", "send",
  "set", "setup", "share", "ship", "shop", "sign", "simplify", "sketch", "slice",
  "solve", "sort", "spec", "split", "start", "stretch", "structure", "study", "submit",
  "summarize", "swim", "sync", "tag", "take", "talk", "teach", "test", "tidy", "time",
  "trace", "track", "train", "transcribe", "translate", "trim", "troubleshoot", "tune",
  "type", "unblock", "update", "upgrade", "upload", "validate", "verify", "visit",
  "walk", "warm", "watch", "wire", "wireframe", "write",
]);

const VAGUE_STARTERS: ReadonlyArray<string> = [
  "work on",
  "think about",
  "look into",
  "figure out",
  "deal with",
  "handle",
  "try to",
  "do some",
  "do ",
  "stuff",
  "misc",
  "things",
  "various",
  "continue",
];

const OVERSIZED_PHRASES: ReadonlyArray<string> = [
  "entire",
  "whole",
  "everything",
  "all of",
  "complete overhaul",
  "from scratch",
  "redesign all",
  "finish all",
];

const WISH_STARTERS: ReadonlyArray<string> = [
  "be ",
  "become ",
  "get rich",
  "get famous",
  "be better",
  "be successful",
  "be happy",
  "do more",
  "have more",
];

function safeNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function normalizeWords(text: string): string[] {
  const sample = text.slice(0, MAX_ANALYZED_CHARS).trim();
  if (!sample) return [];
  return sample.split(/\s+/).filter(Boolean);
}

function stripLeadingPunct(word: string): string {
  return word.replace(/^[^A-Za-z0-9\u00C0-\u024F]+|[^A-Za-z0-9\u00C0-\u024F]+$/g, "");
}

function isAsciiLatinWord(word: string): boolean {
  return /^[A-Za-z]+$/.test(word);
}

function verdictFromScore(score: number, maxScore: number): Exclude<DraftVerdict, "empty"> {
  if (score >= maxScore - 1) return "strong";
  if (score >= Math.ceil(maxScore / 2)) return "fair";
  return "weak";
}

function scoreChecks(checks: ReadonlyArray<ScienceCheck>): { score: number; maxScore: number } {
  const maxScore = checks.length * 2;
  let score = 0;
  for (const c of checks) {
    if (c.status === "pass") score += 2;
    else if (c.status === "warn") score += 1;
  }
  return { score, maxScore };
}

/**
 * Evaluates a task draft against behavioral & cognitive science principles:
 * Implementation Intentions, Specificity, Single-Sitting Scope, and Clear Done Line.
 */
export function evaluateTaskDraft(title: string, notes = ""): DraftEvaluation {
  const trimmed = typeof title === "string" ? title.trim() : "";
  const trimmedNotes = typeof notes === "string" ? notes.trim() : "";

  if (!trimmed) {
    return {
      verdict: "empty",
      score: 0,
      maxScore: 8,
      summary: "Type a task draft or pick an example to see science-backed feedback.",
      checks: [],
    };
  }

  const words = normalizeWords(trimmed);
  const lower = trimmed.slice(0, MAX_ANALYZED_CHARS).toLowerCase();
  const firstToken = stripLeadingPunct(words[0] ?? "").toLowerCase();

  // 1. Concrete physical action verb (Implementation Intentions)
  const startsVague = VAGUE_STARTERS.some(
    (phrase) => lower === phrase.trim() || lower.startsWith(phrase)
  );
  let verbCheck: ScienceCheck;
  if (startsVague) {
    verbCheck = {
      id: "verb",
      label: "Concrete starting verb",
      status: "fail",
      principle: "Implementation Intentions",
      detail:
        "Starts with a vague filler phrase. Replace it with a physical action (e.g., Draft, Sketch, Implement, Run, Read).",
    };
  } else if (CONCRETE_VERBS.has(firstToken)) {
    verbCheck = {
      id: "verb",
      label: "Concrete starting verb",
      status: "pass",
      principle: "Implementation Intentions",
      detail: `Opens with an observable action ("${words[0]}"), removing initiation friction.`,
    };
  } else if (firstToken && !isAsciiLatinWord(firstToken)) {
    verbCheck = {
      id: "verb",
      label: "Concrete starting verb",
      status: words.length >= 3 ? "pass" : "warn",
      principle: "Implementation Intentions",
      detail:
        words.length >= 3
          ? "Multi-word phrasing detected — ensure the opening word is a concrete physical action."
          : "Add a concrete starting verb so the first 30 seconds are unmistakable.",
    };
  } else {
    verbCheck = {
      id: "verb",
      label: "Concrete starting verb",
      status: "fail",
      principle: "Implementation Intentions",
      detail:
        "Reads like a topic or noun rather than an action. Start with a concrete verb (Draft, Build, Fix, Review, Run).",
    };
  }

  // 2. Specific, scannable scope (Specificity)
  let specificityCheck: ScienceCheck;
  if (words.length < 3) {
    specificityCheck = {
      id: "specificity",
      label: "Specific next step",
      status: "fail",
      principle: "Goal Specificity",
      detail:
        "Too brief to clarify what you are acting on. Name the specific section, artifact, or route.",
    };
  } else if (trimmed.length > 120 || words.length > 20) {
    specificityCheck = {
      id: "specificity",
      label: "Specific next step",
      status: "warn",
      principle: "Cognitive Load",
      detail:
        "Long title — keep the headline punchy and move supporting details into Notes.",
    };
  } else {
    specificityCheck = {
      id: "specificity",
      label: "Specific next step",
      status: "pass",
      principle: "Goal Specificity",
      detail: "Specific enough to act on immediately without re-planning.",
    };
  }

  // 3. Single-sitting focus size (Zeigarnik & Ultradian Focus)
  const bundleSeparators = (lower.match(/\band\b|&|;/g) ?? []).length;
  const hasOversizedPhrase = OVERSIZED_PHRASES.some((p) => lower.includes(p));
  let sizeCheck: ScienceCheck;
  if (hasOversizedPhrase || bundleSeparators >= 2) {
    sizeCheck = {
      id: "size",
      label: "Single-sitting size (20–90m)",
      status: "fail",
      principle: "Zeigarnik Effect",
      detail:
        "Looks like a bundled mini-project. Split it into separate single-sitting tasks you can finish in one focus bout.",
    };
  } else if (bundleSeparators === 1 && words.length > 10) {
    sizeCheck = {
      id: "size",
      label: "Single-sitting size (20–90m)",
      status: "warn",
      principle: "Zeigarnik Effect",
      detail:
        "Contains two joined clauses — verify both fit comfortably inside one 20–90 minute focus session.",
    };
  } else {
    sizeCheck = {
      id: "size",
      label: "Single-sitting size (20–90m)",
      status: "pass",
      principle: "Zeigarnik Effect",
      detail: "Focused on one cohesive action rather than a sprawling multi-day project.",
    };
  }

  // 4. Visible finish line (Progress Principle)
  const hasQuantity = /\b\d+\b/.test(lower);
  const hasBoundaryWord =
    /\b(intro|section|chapter|draft|wireframe|prototype|tests?|bug|fix|page|email|km|miles?|minutes?|min|hours?|summary|outline|notes|checklist|pr|review|v1)\b/.test(
      lower
    );
  const hasNotesDoneLine = trimmedNotes.length >= 12;
  let doneCheck: ScienceCheck;
  if (hasNotesDoneLine || (hasQuantity && words.length >= 3)) {
    doneCheck = {
      id: "done-line",
      label: "Clear finish line",
      status: "pass",
      principle: "Progress Principle",
      detail: hasNotesDoneLine
        ? "Clear completion criteria captured in Notes — you'll know exactly when to mark it Done."
        : "Includes a measurable boundary so your brain gets a clean completion signal.",
    };
  } else if (hasBoundaryWord && words.length >= 4) {
    doneCheck = {
      id: "done-line",
      label: "Clear finish line",
      status: "pass",
      principle: "Progress Principle",
      detail: "Names a concrete deliverable you can cleanly check off when finished.",
    };
  } else {
    doneCheck = {
      id: "done-line",
      label: "Clear finish line",
      status: "warn",
      principle: "Progress Principle",
      detail:
        "Add a quantity (e.g., '3 wireframes', '500 words', '5 km') or jot a 1-line Definition of Done in Notes.",
    };
  }

  const checks = [verbCheck, specificityCheck, sizeCheck, doneCheck];
  const { score, maxScore } = scoreChecks(checks);
  const verdict = verdictFromScore(score, maxScore);

  const summary =
    verdict === "strong"
      ? "Ready for Focus — clear action, realistic scope, and an unmistakable finish line."
      : verdict === "fair"
      ? "Good start — tighten the highlighted items so starting feels effortless."
      : "Too ambiguous or oversized — sharpen the starting verb and narrow it to one sitting.";

  return { verdict, score, maxScore, summary, checks };
}

/**
 * Evaluates a Quest draft against Goal Shielding, Weekly Input Calibration,
 * Identity Clarity, and Self-Determination Theory.
 */
export function evaluateQuestDraft(input: QuestDraftInput): DraftEvaluation {
  const trimmed = typeof input.title === "string" ? input.title.trim() : "";
  const trimmedDesc = typeof input.description === "string" ? input.description.trim() : "";

  if (!trimmed) {
    return {
      verdict: "empty",
      score: 0,
      maxScore: 8,
      summary: "Draft a Quest title, purpose, and weekly hours to test its design.",
      checks: [],
    };
  }

  const words = normalizeWords(trimmed);
  const lower = trimmed.slice(0, MAX_ANALYZED_CHARS).toLowerCase();
  const targetHours = Number(input.targetWeeklyHours);
  const existingCount = Math.floor(safeNonNegative(input.existingQuestCount ?? 0));
  const existingHours = safeNonNegative(input.existingWeeklyHours ?? 0);
  const projectedCount = existingCount + 1;

  // 1. Active Quest Cap (Goal Shielding)
  let capCheck: ScienceCheck;
  if (projectedCount <= 3) {
    capCheck = {
      id: "quest-cap",
      label: "Goal shielding (1–3 Quests)",
      status: "pass",
      principle: "Goal Shielding",
      detail: `Fits within the 1–3 active Quest sweet spot (${projectedCount} total).`,
    };
  } else if (projectedCount === 4) {
    capCheck = {
      id: "quest-cap",
      label: "Goal shielding (1–3 Quests)",
      status: "warn",
      principle: "Goal Shielding",
      detail:
        "You already have 3 active Quests. Adding a 4th can dilute attention unless another Quest is wrapping up.",
    };
  } else {
    capCheck = {
      id: "quest-cap",
      label: "Goal shielding (1–3 Quests)",
      status: "fail",
      principle: "Goal Shielding",
      detail: `${projectedCount} active Quests exceeds working-memory limits. Retire or pause an existing Quest first.`,
    };
  }

  // 2. Realistic Weekly Input Hours (Locke & Latham / Planning Fallacy)
  let hoursCheck: ScienceCheck;
  if (!Number.isFinite(targetHours) || targetHours < 1) {
    hoursCheck = {
      id: "weekly-hours",
      label: "Calibrated weekly input",
      status: "fail",
      principle: "Planning Fallacy",
      detail: "Set a realistic weekly target of at least 1 hour so progress is measurable.",
    };
  } else {
    const projectedTotal = existingHours + targetHours;
    if (targetHours <= 20 && projectedTotal <= 30) {
      hoursCheck = {
        id: "weekly-hours",
        label: "Calibrated weekly input",
        status: "pass",
        principle: "Goal-Setting Theory",
        detail: `${targetHours} h/wk (${projectedTotal.toFixed(0)} h/wk total) sits in a sustainable deep-work range.`,
      };
    } else if (targetHours <= 30 && projectedTotal <= 40) {
      hoursCheck = {
        id: "weekly-hours",
        label: "Calibrated weekly input",
        status: "warn",
        principle: "Planning Fallacy",
        detail: `${projectedTotal.toFixed(0)} h/wk combined deep work is ambitious — ensure it leaves room for Other work and rest.`,
      };
    } else {
      hoursCheck = {
        id: "weekly-hours",
        label: "Calibrated weekly input",
        status: "fail",
        principle: "Planning Fallacy",
        detail: `${targetHours} h/wk (${projectedTotal.toFixed(0)} h/wk total) risks chronic missed targets. Lower to a pace you can hit 4 weeks straight.`,
      };
    }
  }

  // 3. Clear, Concrete Quest Identity
  const isWishOnly = WISH_STARTERS.some((p) => lower.startsWith(p));
  let identityCheck: ScienceCheck;
  if (isWishOnly) {
    identityCheck = {
      id: "identity",
      label: "Actionable Quest identity",
      status: "fail",
      principle: "Process vs. Outcome",
      detail:
        "Phrased as an abstract wish. Frame it around a concrete pursuit or craft (e.g., 'Launch my idea', 'Write every week').",
    };
  } else if (words.length < 2) {
    identityCheck = {
      id: "identity",
      label: "Actionable Quest identity",
      status: "warn",
      principle: "Goal Specificity",
      detail:
        "A single word can feel like a generic category. Give it a memorable 2–6 word mission name.",
    };
  } else if (trimmed.length > 70) {
    identityCheck = {
      id: "identity",
      label: "Actionable Quest identity",
      status: "warn",
      principle: "Cognitive Load",
      detail: "Trim the title to a crisp headline and keep the details in Description.",
    };
  } else {
    identityCheck = {
      id: "identity",
      label: "Actionable Quest identity",
      status: "pass",
      principle: "Goal Specificity",
      detail: "Memorable, concrete mission title that anchors daily task choices.",
    };
  }

  // 4. Intrinsic Meaning / Scope Description (Self-Determination Theory)
  let purposeCheck: ScienceCheck;
  if (trimmedDesc.length >= 24) {
    purposeCheck = {
      id: "purpose",
      label: "Intrinsic purpose & scope",
      status: "pass",
      principle: "Self-Determination Theory",
      detail: "Clearly articulates what moves this Quest forward and why it matters.",
    };
  } else if (trimmedDesc.length > 0) {
    purposeCheck = {
      id: "purpose",
      label: "Intrinsic purpose & scope",
      status: "warn",
      principle: "Self-Determination Theory",
      detail:
        "Add a bit more context: what kind of work counts toward this Quest, and why does it matter to you?",
    };
  } else {
    purposeCheck = {
      id: "purpose",
      label: "Intrinsic purpose & scope",
      status: "fail",
      principle: "Self-Determination Theory",
      detail:
        "Missing description. Writing why this Quest matters strengthens follow-through when motivation dips.",
    };
  }

  const checks = [capCheck, hoursCheck, identityCheck, purposeCheck];
  const { score, maxScore } = scoreChecks(checks);
  const verdict = verdictFromScore(score, maxScore);

  const summary =
    verdict === "strong"
      ? "Well-calibrated Quest — focused scope, realistic weekly budget, and clear intrinsic purpose."
      : verdict === "fair"
      ? "Solid foundation — review the suggestions below to make this Quest stick long-term."
      : "High risk of friction or burnout — narrow the scope, calibrate hours, and state why it matters.";

  return { verdict, score, maxScore, summary, checks };
}

/**
 * Pure workspace audit over the user's real quests and tasks.
 * Never mutates input arrays; caps rendered task suggestions at MAX_SUGGESTIONS.
 */
export function auditWorkspace(
  quests: readonly Quest[],
  tasks: readonly Task[]
): WorkspaceAudit {
  const activeQuests = quests.filter((q) => !q.archived);
  const activeQuestCount = activeQuests.length;

  const questLoadStatus: WorkspaceAudit["questLoadStatus"] =
    activeQuestCount === 0
      ? "empty"
      : activeQuestCount <= 3
      ? "optimal"
      : "stretched";

  const questLoadMessage =
    questLoadStatus === "empty"
      ? "No active Quests yet — start with 1 to 3 meaningful pursuits."
      : questLoadStatus === "optimal"
      ? "Right in the 1–3 Quest goal-shielding sweet spot."
      : "More than 3 active Quests can split attention; consider focusing on your top 3.";

  const weeklyBudgetHours = Number(
    activeQuests
      .reduce((acc, q) => acc + safeNonNegative(q.targetWeeklyHours), 0)
      .toFixed(1)
  );

  const budgetStatus: WorkspaceAudit["budgetStatus"] =
    weeklyBudgetHours === 0
      ? "none"
      : weeklyBudgetHours <= 25
      ? "sustainable"
      : weeklyBudgetHours <= 35
      ? "ambitious"
      : "overbooked";

  const budgetMessage =
    budgetStatus === "none"
      ? "Add weekly input targets once you create a Quest."
      : budgetStatus === "sustainable"
      ? "Realistic deep-work budget with space for Other work and recovery."
      : budgetStatus === "ambitious"
      ? "Ambitious weekly load — check Review weekly to verify it stays sustainable."
      : "Over 35 h/wk of pure deep work often triggers the Planning Fallacy; consider trimming targets.";

  const openTasks = tasks.filter((t) => t.status === "queued" || t.status === "active");
  const openTaskCount = openTasks.length;
  let questTaskCount = 0;
  let otherTaskCount = 0;
  let strongTaskCount = 0;
  const tasksToSharpen: TaskAuditSuggestion[] = [];

  for (const task of openTasks) {
    if (task.questId !== null) questTaskCount += 1;
    else otherTaskCount += 1;

    const evaluation = evaluateTaskDraft(task.title, task.notes);
    if (evaluation.verdict === "strong") {
      strongTaskCount += 1;
    } else if (
      evaluation.verdict !== "empty" &&
      tasksToSharpen.length < MAX_SUGGESTIONS
    ) {
      const firstIssue =
        evaluation.checks.find((c) => c.status === "fail") ??
        evaluation.checks.find((c) => c.status === "warn");
      if (firstIssue) {
        tasksToSharpen.push({
          taskId: task.id,
          title: task.title,
          questId: task.questId,
          verdict: evaluation.verdict,
          topTip: firstIssue.detail,
        });
      }
    }
  }

  const clarityPct =
    openTaskCount > 0 ? Math.round((strongTaskCount / openTaskCount) * 100) : 100;

  return {
    activeQuestCount,
    questLoadStatus,
    questLoadMessage,
    weeklyBudgetHours,
    budgetStatus,
    budgetMessage,
    openTaskCount,
    questTaskCount,
    otherTaskCount,
    strongTaskCount,
    clarityPct,
    tasksToSharpen,
  };
}
