"use client";

import React, { useId, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  Compass,
  FlaskConical,
  ListChecks,
  Repeat,
  X,
} from "lucide-react";
import { accentStyle } from "@/lib/questAccents";
import { useCommandStore } from "@/store/useCommandStore";
import { hudAudio } from "@/lib/hudAudio";
import {
  GUIDE_TABS,
  QUEST_PRINCIPLES,
  RHYTHM_STEPS,
  TASK_PRINCIPLES,
  type GuideTabId,
  type SciencePrinciple,
} from "@/lib/questScienceContent";
import { GuideLabSection } from "./GuideLabSection";

const PRESSABLE =
  "transition-colors duration-150 ease-out active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/70";

function TabIcon({ id }: { id: GuideTabId }) {
  if (id === "quests") return <Compass className="h-4 w-4 shrink-0" aria-hidden="true" />;
  if (id === "tasks") return <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true" />;
  if (id === "system") return <Repeat className="h-4 w-4 shrink-0" aria-hidden="true" />;
  return <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />;
}

function PrincipleCard({ principle }: { principle: SciencePrinciple }) {
  const style = accentStyle(principle.accent);
  return (
    <article
      data-testid={`principle-${principle.id}`}
      className="cq-card flex min-w-0 flex-col justify-between rounded-2xl border border-white/[0.08] bg-surface p-5 sm:p-7"
    >
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 font-mono text-xs text-hud-muted">
            <span className={`h-2 w-2 rounded-full ${style.bg}`} aria-hidden="true" />
            <span>Principle {principle.number}</span>
          </span>
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-0.5 text-[11px] text-hud-muted">
            {principle.citation}
          </span>
        </div>

        <h2 className="mt-3 text-lg font-medium tracking-tight text-white">
          {principle.title}
        </h2>

        <p className="mt-2.5 max-w-[68ch] text-sm leading-relaxed text-neutral-300">
          {principle.science}
        </p>

        <div className="mt-4 rounded-xl border border-white/[0.06] bg-base px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-hud-cyan">
            In Hunt
          </div>
          <p className="mt-1 max-w-[68ch] text-xs leading-relaxed text-neutral-200">
            {principle.inHunt}
          </p>
        </div>
      </div>

      {/* Side-by-side Avoid vs. Aim For (adapts via @container query on PrincipleCard) */}
      <div className="cq-two-col mt-5">
        <div className="rounded-xl border border-hud-crimson/20 bg-hud-crimson/[0.04] p-3.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-hud-crimson">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Avoid</span>
          </div>
          <p className="mt-1.5 break-words text-xs leading-relaxed text-neutral-300">
            {principle.avoid}
          </p>
        </div>

        <div className="rounded-xl border border-hud-emerald/25 bg-hud-emerald/[0.05] p-3.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-hud-emerald">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Aim for</span>
          </div>
          <p className="mt-1.5 break-words text-xs leading-relaxed text-neutral-200">
            {principle.aimFor}
          </p>
        </div>
      </div>
    </article>
  );
}

export function GuideView() {
  const setActiveView = useCommandStore((s) => s.setActiveView);
  const [activeTab, setActiveTab] = useState<GuideTabId>("quests");
  const tabRefs = useRef<Partial<Record<GuideTabId, HTMLButtonElement | null>>>({});
  const ids = useId();

  const selectTab = (next: GuideTabId, moveFocus = false) => {
    hudAudio.playClick();
    setActiveTab(next);
    if (moveFocus) {
      tabRefs.current[next]?.focus();
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = GUIDE_TABS.length;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      selectTab(GUIDE_TABS[(index + 1) % count].id, true);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      selectTab(GUIDE_TABS[(index - 1 + count) % count].id, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      selectTab(GUIDE_TABS[0].id, true);
    } else if (e.key === "End") {
      e.preventDefault();
      selectTab(GUIDE_TABS[count - 1].id, true);
    }
  };

  const panelId = `${ids}-panel-${activeTab}`;
  const tabId = (id: GuideTabId) => `${ids}-tab-${id}`;

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
      {/* Page Heading */}
      <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-hud-cyan/25 bg-hud-cyan/[0.06] px-3 py-1 text-xs text-hud-cyan">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Behavioral &amp; Cognitive Science</span>
          </div>
          <h1 className="text-[clamp(1.625rem,2.2vw+1rem,2.25rem)] font-medium leading-tight tracking-tight text-white">
            Quest &amp; Task Guide
          </h1>
          <p className="mt-2 max-w-[68ch] text-sm text-hud-muted">
            Learn how to set focused Quests and friction-free tasks grounded in goal-setting,
            attention, and motivation research — then test your own drafts live.
          </p>
        </div>

        {activeTab !== "workshop" && (
          <button
            type="button"
            onClick={() => selectTab("workshop")}
            className={`inline-flex shrink-0 items-center gap-2 rounded-xl bg-hud-cyan px-4 py-2.5 text-xs font-semibold text-black hover:bg-white ${PRESSABLE}`}
          >
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
            <span>Open Workshop &amp; Audit</span>
          </button>
        )}
      </div>

      {/* Accessible Chapter Tabs */}
      <div
        role="tablist"
        aria-label="Guide sections"
        className="mb-8 grid grid-cols-[repeat(auto-fit,minmax(min(100%,11.5rem),1fr))] gap-2.5 sm:grid-cols-4"
      >
        {GUIDE_TABS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${ids}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              className={`flex flex-col items-start rounded-2xl border px-4 py-3.5 text-left ${PRESSABLE} ${
                selected
                  ? "border-hud-cyan/40 bg-white/[0.08] text-white"
                  : "border-white/[0.07] bg-surface text-neutral-300 hover:border-white/20 hover:text-white"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className={selected ? "text-hud-cyan" : "text-hud-muted"}>
                  <TabIcon id={tab.id} />
                </span>
                <span>{tab.label}</span>
              </div>
              <span className="mt-1 text-xs text-hud-muted">{tab.shortDesc}</span>
            </button>
          );
        })}
      </div>

      {/* Active Tab Panel */}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(activeTab)}
      >
        {activeTab === "quests" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {QUEST_PRINCIPLES.map((principle) => (
                <PrincipleCard key={principle.id} principle={principle} />
              ))}
            </div>

            <div className="flex flex-col justify-between gap-4 rounded-2xl border border-white/[0.08] bg-surface p-6 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-base font-medium text-white">
                  Ready to turn Quests into friction-free daily steps?
                </h3>
                <p className="mt-1 text-xs text-hud-muted">
                  Next, learn why concrete verbs and single-sitting sizing eliminate procrastination.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => selectTab("tasks")}
                  className={`inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-xs font-medium text-black hover:bg-neutral-200 ${PRESSABLE}`}
                >
                  <span>Next: Crafting Tasks</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    hudAudio.playClick();
                    setActiveView("quests");
                  }}
                  className={`rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-xs text-neutral-200 hover:border-white/25 hover:text-white ${PRESSABLE}`}
                >
                  Go to Quests
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "tasks" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {TASK_PRINCIPLES.map((principle) => (
                <PrincipleCard key={principle.id} principle={principle} />
              ))}
            </div>

            <div className="flex flex-col justify-between gap-4 rounded-2xl border border-white/[0.08] bg-surface p-6 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-base font-medium text-white">
                  Put your own tasks through the science check
                </h3>
                <p className="mt-1 text-xs text-hud-muted">
                  Test a task draft or audit your live Hunt queue in the Workshop.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => selectTab("workshop")}
                  className={`inline-flex items-center gap-1.5 rounded-xl bg-hud-cyan px-4 py-2 text-xs font-semibold text-black hover:bg-white ${PRESSABLE}`}
                >
                  <span>Try the Workshop</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => selectTab("system")}
                  className={`rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-xs text-neutral-200 hover:border-white/25 hover:text-white ${PRESSABLE}`}
                >
                  See Weekly System
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "system" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {RHYTHM_STEPS.map((item) => {
                const style = accentStyle(item.accent);
                return (
                  <article
                    key={item.id}
                    className="flex flex-col justify-between rounded-2xl border border-white/[0.08] bg-surface p-6"
                  >
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`font-mono text-xs font-medium ${style.text}`}>
                          {item.step}
                        </span>
                        <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-0.5 text-[11px] text-hud-muted">
                          {item.citation}
                        </span>
                      </div>
                      <h2 className="mt-3 text-lg font-medium text-white">{item.title}</h2>
                      <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-neutral-300">
                        {item.summary}
                      </p>
                      <p className="mt-3 rounded-xl border border-white/[0.06] bg-base px-3.5 py-2.5 text-xs leading-relaxed text-neutral-200">
                        <strong className="font-medium text-white">Practice: </strong>
                        {item.practice}
                      </p>
                    </div>

                    <div className="mt-5">
                      <button
                        type="button"
                        onClick={() => {
                          hudAudio.playClick();
                          setActiveView(item.view);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs text-neutral-200 hover:border-white/25 hover:text-white ${PRESSABLE}`}
                      >
                        <span>{item.viewLabel}</span>
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            {/* Quick Pre-Flight Checklist */}
            <section className="rounded-2xl border border-white/[0.08] bg-surface p-6">
              <h3 className="text-base font-medium text-white">
                30-second pre-flight checklist
              </h3>
              <ul className="mt-4 grid grid-cols-1 gap-3 text-xs text-neutral-300 sm:grid-cols-2">
                {[
                  "Do I have 1 to 3 active Quests (not 6+)?",
                  "Is my combined weekly target realistic (roughly 12–25 h/wk)?",
                  "Does today's #1 task start with a concrete physical verb?",
                  "Can I finish today's #1 task in a single 20–90 minute bout?",
                ].map((q) => (
                  <li
                    key={q}
                    className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-base px-3.5 py-3"
                  >
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-hud-emerald" aria-hidden="true" />
                    <span>{q}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {activeTab === "workshop" && <GuideLabSection />}
      </div>
    </div>
  );
}
