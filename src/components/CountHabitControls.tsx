"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Habit, HabitKind } from "@/lib/domainTypes";
import type { HabitDaySummary } from "@/lib/habitDay";
import {
  countProgressLabel,
  countTargetOf,
  formatCountAmount,
  habitDayAmount,
  habitKindOf,
  parseCountAmount,
} from "@/lib/habitKind";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";

/** How long a press on +1 is held before it opens exact entry instead. */
export const LONG_PRESS_MS = 500;

/** A typed Count target, if usable: a positive number. */
function typedTarget(text: string): number | null {
  const value = parseCountAmount(text);
  return value !== null && value > 0 ? value : null;
}

/**
 * The new-habit form's Habit Kind choice: its picker, whether the form may be
 * submitted (a Count Habit needs a target), the Kind fields to create the
 * Habit with, and a reset for after it was made.
 */
export function useNewHabitKind() {
  const [kind, setKind] = useState<HabitKind>("check");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const countTarget = typedTarget(target);
  return {
    valid: kind !== "count" || countTarget !== null,
    fields: () => (kind === "count" ? { kind, target: countTarget ?? undefined, unit } : { kind }),
    reset: () => {
      setKind("check");
      setTarget("");
      setUnit("");
    },
    picker: (
      <HabitKindPicker
        kind={kind}
        onKindChange={(k) => {
          hudAudio.playClick();
          setKind(k);
        }}
        target={target}
        onTargetChange={setTarget}
        unit={unit}
        onUnitChange={setUnit}
      />
    ),
  };
}

/**
 * The habit edit form's Kind section: the Kind shown read-only (it never
 * changes), and a Count Habit's target and unit, which can.
 */
export function useHabitKindEdit() {
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const isCount = (h: Habit) => habitKindOf(h) === "count";
  return {
    load: (h: Habit) => {
      setTarget(formatCountAmount(countTargetOf(h)));
      setUnit(h.unit ?? "");
    },
    isDirty: (h: Habit) =>
      isCount(h) && (target !== formatCountAmount(countTargetOf(h)) || unit !== (h.unit ?? "")),
    changes: (h: Habit): Partial<Habit> => {
      if (!isCount(h)) return {};
      const countTarget = typedTarget(target);
      return countTarget === null ? { unit } : { unit, target: countTarget };
    },
    fields: (h: Habit) => (
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-xs text-neutral-400">Kind</span>
          <span className="inline-flex min-h-8 items-center rounded-full border border-white/[0.07] px-3 text-xs text-neutral-300">
            {isCount(h) ? "Count Habit" : "Check Habit"}
          </span>
        </div>
        {isCount(h) && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-400">Daily target</span>
              <input
                type="text"
                inputMode="decimal"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="min-h-8 coarse:min-h-11 w-24 rounded-xl border border-white/15 bg-black/40 px-3 text-sm tabular-nums text-white focus:border-accent focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-400">Unit</span>
              <input
                type="text"
                maxLength={40}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="min-h-8 coarse:min-h-11 w-36 rounded-xl border border-white/15 bg-black/40 px-3 text-sm text-white focus:border-accent focus:outline-none"
              />
            </label>
          </>
        )}
      </div>
    ),
  };
}

/**
 * Logs today's total of a Count Habit (+1, or an exact total) through the
 * store, with the completion sound when it reaches the target.
 */
export function useLogHabitAmount(todayKey: string, summaryFor: (habitId: string) => HabitDaySummary) {
  const logHabitAmount = useCommandStore((s) => s.logHabitAmount);
  return async (habit: Habit, amount: number | "+1") => {
    const { doneToday, todayTask } = summaryFor(habit.id);
    const total = amount === "+1" ? habitDayAmount(todayTask) + 1 : amount;
    if (!doneToday && total >= countTargetOf(habit)) hudAudio.playComplete();
    else hudAudio.playClick();
    await logHabitAmount(habit.id, todayKey, amount);
  };
}

/**
 * The Habit Kind choice of the new-habit form (GLOSSARY: Habit Kind): Check or
 * Count, with a Count Habit's daily target and unit. Native radios inside
 * 44px labels on touch, so it works by finger, mouse and keyboard.
 */
export function HabitKindPicker({
  kind,
  onKindChange,
  target,
  onTargetChange,
  unit,
  onUnitChange,
}: {
  kind: HabitKind;
  onKindChange: (kind: HabitKind) => void;
  target: string;
  onTargetChange: (target: string) => void;
  unit: string;
  onUnitChange: (unit: string) => void;
}) {
  const name = useId();
  const options: { value: HabitKind; label: string }[] = [
    { value: "check", label: "Check" },
    { value: "count", label: "Count" },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
      <div role="radiogroup" aria-label="Habit Kind" className="flex items-center gap-1 rounded-full border border-white/[0.07] p-0.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex min-h-8 coarse:min-h-11 cursor-pointer items-center rounded-full px-3 text-xs transition-[color,background-color] duration-150 ease-out has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
              kind === o.value ? "bg-white/[0.08] font-medium text-white" : "text-hud-muted hover:text-neutral-200"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={kind === o.value}
              onChange={() => onKindChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
      {kind === "count" && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={target}
            onChange={(e) => onTargetChange(e.target.value)}
            placeholder="Target"
            aria-label="Daily target"
            className="min-h-8 coarse:min-h-11 w-20 rounded-lg border border-white/15 bg-black/40 px-2 text-xs tabular-nums text-white placeholder:text-hud-muted focus:border-accent focus:outline-none"
          />
          <input
            type="text"
            value={unit}
            maxLength={40}
            onChange={(e) => onUnitChange(e.target.value)}
            placeholder="Unit (e.g. miles)"
            aria-label="Unit"
            className="min-h-8 coarse:min-h-11 w-36 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white placeholder:text-hud-muted focus:border-accent focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Press handlers for a +1 button: a tap adds one, a long press (or the context
 * menu: right-click, or a touch held down) opens exact entry. The click that
 * ends a long press adds nothing.
 */
function useLongPress(onTap: () => void, onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: () => {
      longPressed.current = false;
      clear();
      timer.current = setTimeout(() => {
        longPressed.current = true;
        timer.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      clear();
      if (!longPressed.current) onLongPress();
      longPressed.current = true;
    },
    onClick: () => {
      if (longPressed.current) {
        longPressed.current = false;
        return;
      }
      onTap();
    },
  };
}

/**
 * A Count Habit card's logging controls: the +1 button (tap +1, long press for
 * an exact total) and today's progress, "n / target unit", which also opens
 * exact entry so it is reachable without a long press.
 */
export function CountHabitPlusButton({
  habit,
  met,
  accentBg,
  onAdd,
  onLongPress,
}: {
  habit: Habit;
  met: boolean;
  accentBg: string;
  onAdd: () => void;
  onLongPress: () => void;
}) {
  const press = useLongPress(onAdd, onLongPress);
  return (
    <button
      type="button"
      {...press}
      aria-label={`Add 1 to ${habit.title}`}
      title="Add 1 (hold to type a total)"
      className={`relative mt-0.5 flex h-5 min-w-5 shrink-0 select-none items-center justify-center rounded-full border px-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums before:absolute before:-inset-3 before:content-[''] transition-[transform,opacity,background-color,border-color,color] duration-150 ease-out [-webkit-touch-callout:none] active:scale-90 active:opacity-80 ${
        met ? `${accentBg} border-transparent text-black` : "border-white/40 text-neutral-300 hover:border-success hover:text-success"
      }`}
    >
      +1
    </button>
  );
}

/** Today's progress as a button that opens exact entry. */
export function CountProgressButton({
  habit,
  amount,
  onOpen,
}: {
  habit: Habit;
  amount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Set today's total for ${habit.title}`}
      title="Type today's total"
      className="-my-1 min-h-8 coarse:min-h-11 min-w-0 max-w-full break-words rounded-full px-2 py-1 text-left font-mono text-xs tabular-nums text-neutral-300 transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80"
    >
      {countProgressLabel(habit, amount)}
    </button>
  );
}

/** Exact entry of today's total: Enter or Save writes it, Escape or Cancel closes. */
export function CountAmountForm({
  habit,
  amount,
  onSave,
  onClose,
}: {
  habit: Habit;
  amount: number;
  onSave: (amount: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(formatCountAmount(amount));
  const [invalid, setInvalid] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseCountAmount(text);
    if (value === null) {
      setInvalid(true);
      return;
    }
    onSave(value);
  };
  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="mt-3 flex flex-wrap items-center gap-2 pl-8"
    >
      <input
        type="text"
        inputMode="decimal"
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        aria-label={`Today's total for ${habit.title}`}
        aria-invalid={invalid}
        className={`min-h-8 coarse:min-h-11 w-24 rounded-lg border bg-black/40 px-2 text-sm tabular-nums text-white focus:outline-none ${
          invalid ? "border-danger" : "border-white/15 focus:border-accent"
        }`}
      />
      {habit.unit && <span className="text-xs text-hud-muted">{habit.unit}</span>}
      <button
        type="button"
        onClick={onClose}
        className="min-h-8 coarse:min-h-11 rounded-lg px-3 py-1.5 text-xs text-hud-muted transition-colors duration-150 ease-out hover:text-white active:opacity-80"
      >
        Cancel
      </button>
      <button
        type="submit"
        className="flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors duration-150 ease-out hover:bg-neutral-200 active:opacity-80"
      >
        <Check className="h-3.5 w-3.5" />
        <span>Set total</span>
      </button>
    </form>
  );
}
