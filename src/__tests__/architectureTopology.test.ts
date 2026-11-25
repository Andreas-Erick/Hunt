import React from "react";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId, toLocalDateKey } from "@/lib/dateUtils";
import {
  SYNC_TOKEN_STORAGE_KEY,
  fromFocusSession,
  toFocusSession,
  type Habit,
  type Task,
} from "@/lib/domainTypes";
import { closeDesktopWindow } from "@/lib/desktopWindow";
import { createEmptySyncPayload, type SyncPayload } from "@/lib/syncTypes";
import { useTodayDateKey } from "@/components/useTodayDateKey";
import {
  SYNC_DEBOUNCE_MS,
  disposeCommandStoreScheduler,
  sessionLogId,
  useCommandStore,
} from "@/store/useCommandStore";

const SRC_ROOT = path.resolve(process.cwd(), "src");

function walkProductionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProductionSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function resolveInternalImport(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(SRC_ROOT, candidate).replace(/\\/g, "/");
    }
  }
  return null;
}

interface ModuleEdges {
  internal: string[];
  external: string[];
}

function buildModuleGraph(): Map<string, ModuleEdges> {
  const graph = new Map<string, ModuleEdges>();
  for (const absFile of walkProductionSources(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, absFile).replace(/\\/g, "/");
    const source = fs.readFileSync(absFile, "utf8");
    const sf = ts.createSourceFile(
      absFile,
      source,
      ts.ScriptTarget.Latest,
      true,
      absFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const internal = new Set<string>();
    const external = new Set<string>();

    const recordSpec = (spec: string) => {
      const target = resolveInternalImport(absFile, spec);
      if (target) internal.add(target);
      else external.add(spec);
    };

    for (const stmt of sf.statements) {
      if (
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        recordSpec(stmt.moduleSpecifier.text);
      }
    }
    graph.set(rel, {
      internal: Array.from(internal).sort(),
      external: Array.from(external).sort(),
    });
  }
  return graph;
}

function findCycles(graph: Map<string, ModuleEdges>): string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const dfs = (node: string) => {
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const dep of graph.get(node)?.internal ?? []) {
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (active.has(dep)) {
        const idx = stack.indexOf(dep);
        cycles.push([...stack.slice(idx), dep]);
      }
    }
    stack.pop();
    active.delete(node);
  };

  for (const node of Array.from(graph.keys())) {
    if (!visited.has(node)) dfs(node);
  }
  return cycles;
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeHabit(id: string, overrides: Partial<Habit> = {}): Habit {
  return {
    id,
    title: `Habit ${id}`,
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("Macro Architecture & State Topology Invariants", () => {
  describe("Module DAG & Strict Dependency Direction", () => {
    const graph = buildModuleGraph();

    it("maintains zero circular dependencies (runtime or type-level) across all production modules", () => {
      expect(findCycles(graph)).toEqual([]);
    });

    it("keeps pure domain modules free of Dexie, React, Zustand, and UI imports", () => {
      const pureDomainFiles = [
        "lib/domainTypes.ts",
        "lib/dateUtils.ts",
        "lib/habitDay.ts",
        "lib/habitKind.ts",
        "lib/habitCount.ts",
        "lib/habitAvoid.ts",
        "lib/questProgress.ts",
        "lib/focusSession.ts",
        "lib/taskQueue.ts",
        "lib/pendingTicks.ts",
        "lib/reminders.ts",
        "lib/reminderPlan.ts",
        "mobile/huntCore.ts",
        "lib/questAccents.ts",
        "lib/reviewAnalytics.ts",
        "lib/questScience.ts",
        "lib/questScienceContent.ts",
        "lib/syncTypes.ts",
        "lib/widgetSnapshot.ts",
        "lib/widgetStats.ts",
      ];

      for (const mod of pureDomainFiles) {
        const edges = graph.get(mod);
        expect(edges, `expected ${mod} in module graph`).toBeDefined();
        expect(edges!.external, `${mod} external imports`).toEqual([]);
        for (const dep of edges!.internal) {
          expect(dep, `${mod} -> ${dep}`).not.toBe("lib/db.ts");
          expect(dep.startsWith("components/"), `${mod} -> ${dep}`).toBe(false);
          expect(dep.startsWith("store/"), `${mod} -> ${dep}`).toBe(false);
          expect(dep.startsWith("app/"), `${mod} -> ${dep}`).toBe(false);
        }
      }
    });

    it("prevents upward imports from src/lib/* into src/components/* or src/app/*, and keeps desktopWindow decoupled from store", () => {
      for (const [mod, edges] of Array.from(graph.entries())) {
        if (!mod.startsWith("lib/")) continue;
        for (const dep of edges.internal) {
          expect(dep.startsWith("components/"), `${mod} -> ${dep}`).toBe(false);
          expect(dep.startsWith("app/"), `${mod} -> ${dep}`).toBe(false);
        }
      }

      const desktopWindowDeps = graph.get("lib/desktopWindow.ts")?.internal ?? [];
      expect(desktopWindowDeps.some((d) => d.startsWith("store/"))).toBe(false);
    });

    it("keeps views off the database module: reads go through lib/reads.ts, writes through the store", () => {
      for (const [mod, edges] of Array.from(graph.entries())) {
        if (!mod.startsWith("components/")) continue;
        expect(edges.internal, mod).not.toContain("lib/db.ts");
      }
    });
  });

  describe("Explicit FocusSession State Machine", () => {
    it("enforces valid idle, paused, and running states and demotes impossible flag combinations", () => {
      expect(
        toFocusSession({
          activeTaskId: null,
          isRunning: true,
          sessionStartedAt: 5000,
          updatedAt: 10,
        })
      ).toEqual({ status: "idle", updatedAt: 10 });

      expect(
        toFocusSession({
          activeTaskId: "tsk-1",
          isRunning: true,
          sessionStartedAt: null,
          updatedAt: 20,
        })
      ).toEqual({ status: "paused", taskId: "tsk-1", updatedAt: 20 });

      expect(
        toFocusSession({
          activeTaskId: "tsk-1",
          isRunning: true,
          sessionStartedAt: 0,
          updatedAt: 25,
        })
      ).toEqual({ status: "paused", taskId: "tsk-1", updatedAt: 25 });

      const running = toFocusSession({
        activeTaskId: "tsk-1",
        isRunning: true,
        sessionStartedAt: 1_700_000_000_000,
        updatedAt: 30,
      });
      expect(running).toEqual({
        status: "running",
        taskId: "tsk-1",
        sessionStartedAt: 1_700_000_000_000,
        updatedAt: 30,
      });
      expect(fromFocusSession(running)).toEqual({
        activeTaskId: "tsk-1",
        isRunning: true,
        sessionStartedAt: 1_700_000_000_000,
        updatedAt: 30,
      });
    });
  });

  describe("Single Source of Truth: Snapshot Import Focus & Habit Reconciliation", () => {
    beforeEach(async () => {
      await Promise.all([
        db.quests.clear(),
        db.tasks.clear(),
        db.timeLogs.clear(),
        db.habits.clear(),
      ]);
      window.localStorage.clear();
      disposeCommandStoreScheduler();
      useCommandStore.setState(useCommandStore.getInitialState(), true);
    });

    afterEach(() => {
      cleanup();
      disposeCommandStoreScheduler();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("flushes a losing local running burst (R4), adopts newer snapshot focus, and materializes imported habits", async () => {
      const now = 1_760_000_120_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      const localStart = now - 120_000; // started 120s ago on laptop
      const remoteStart = now - 45_000; // phone switched focus 45s ago (so laptop burst = 75s)

      await db.tasks.put(
        makeTask("tsk-laptop", {
          status: "active",
          accumulatedSeconds: 10,
          updatedAt: localStart,
        })
      );
      useCommandStore.setState({
        activeTaskId: "tsk-laptop",
        isRunning: true,
        sessionStartedAt: localStart,
        focusUpdatedAt: localStart,
      });

      const snapshot: SyncPayload = {
        ...createEmptySyncPayload(),
        tasks: [
          makeTask("tsk-phone", {
            status: "active",
            updatedAt: remoteStart,
          }),
        ],
        habits: [makeHabit("hab-morning", { title: "Morning Mobility" })],
        activeFocus: {
          activeTaskId: "tsk-phone",
          isRunning: true,
          sessionStartedAt: remoteStart,
          updatedAt: remoteStart,
        },
        lastSyncedAt: remoteStart,
      };

      const res = await useCommandStore
        .getState()
        .importSnapshot(JSON.stringify(snapshot));
      expect(res.ok).toBe(true);

      // 1. Losing local burst was flushed up to remoteStart (75s), not dropped or over-counted to now
      const flushedLog = await db.timeLogs.get(sessionLogId("tsk-laptop", localStart));
      expect(flushedLog).toBeDefined();
      expect(flushedLog?.durationSeconds).toBe(75);
      const laptopTask = await db.tasks.get("tsk-laptop");
      expect(laptopTask?.status).toBe("queued");
      expect(laptopTask?.accumulatedSeconds).toBe(85);

      // 2. Store active focus adopted the newer snapshot session
      const state = useCommandStore.getState();
      expect(state.activeTaskId).toBe("tsk-phone");
      expect(state.isRunning).toBe(true);
      expect(state.sessionStartedAt).toBe(remoteStart);
      expect(state.focusUpdatedAt).toBe(remoteStart);

      // 3. Imported habit materialized today's daily task immediately
      const todayKey = toLocalDateKey(now);
      const materialized = await db.tasks.get(habitTaskId("hab-morning", todayKey));
      expect(materialized?.title).toBe("Morning Mobility");
      expect(materialized?.scheduledDate).toBe(todayKey);
    });

    it("clears local focus when an imported snapshot marks the focused task completed", async () => {
      const now = 1_760_000_200_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      await db.tasks.put(
        makeTask("tsk-shared", {
          status: "active",
          updatedAt: now - 60_000,
        })
      );
      useCommandStore.setState({
        activeTaskId: "tsk-shared",
        isRunning: false,
        sessionStartedAt: null,
        focusUpdatedAt: now - 60_000,
      });

      const snapshot: SyncPayload = {
        ...createEmptySyncPayload(),
        tasks: [
          makeTask("tsk-shared", {
            status: "completed",
            completedAt: now - 10_000,
            updatedAt: now - 10_000,
          }),
        ],
        activeFocus: {
          activeTaskId: null,
          isRunning: false,
          sessionStartedAt: null,
          updatedAt: now - 9_999,
        },
        lastSyncedAt: now - 9_999,
      };

      const res = await useCommandStore
        .getState()
        .importSnapshot(JSON.stringify(snapshot));
      expect(res.ok).toBe(true);
      expect(useCommandStore.getState().activeTaskId).toBeNull();
      expect(useCommandStore.getState().isRunning).toBe(false);
    });

    it("returns bad_format without throwing or mutating state on malformed snapshots", async () => {
      const res = await useCommandStore.getState().importSnapshot("{not-json");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("bad_format");
      }
    });

    it("rolls useTodayDateKey over automatically across local midnight and cleans up timers on unmount", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 4, 10, 23, 59, 50, 0)); // 2026-05-10 23:59:50 local

      function Probe() {
        const key = useTodayDateKey();
        return React.createElement("div", { "data-testid": "today-probe" }, key);
      }

      const { unmount } = render(React.createElement(Probe));
      expect(screen.getByTestId("today-probe")).toHaveTextContent("2026-05-10");

      act(() => {
        vi.advanceTimersByTime(15_000); // -> 2026-05-11 00:00:05 local
      });
      expect(screen.getByTestId("today-probe")).toHaveTextContent("2026-05-11");

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("deterministically cancels debounced sync timers via disposeCommandStoreScheduler and runs injected window-close sync", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, found: true }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchSpy);

      useCommandStore.getState().requestSync();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      disposeCommandStoreScheduler();
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 3);
      expect(fetchSpy).not.toHaveBeenCalled();

      window.localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, "a".repeat(64));
      let preCloseSynced = false;
      await closeDesktopWindow(async () => {
        preCloseSynced = true;
      });
      expect(preCloseSynced).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
