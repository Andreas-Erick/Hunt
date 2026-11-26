import React from "react";

/**
 * Holds the box of the largest of a control's states, so switching state never
 * reflows its neighbours (CODING_STANDARDS: Layout shifts). Every state is
 * stacked in one grid cell; only `active` is shown, the others keep their space
 * but are hidden from sight, pointer, keyboard and screen readers. `active`
 * null keeps the space empty (e.g. "Skip today" once the day is Met).
 */
export function StableSlot<K extends string>({
  states,
  active,
  className = "",
}: {
  states: Record<K, React.ReactNode>;
  active: K | null;
  className?: string;
}) {
  return (
    <span className={`inline-grid items-center ${className}`}>
      {(Object.keys(states) as K[]).map((key) => {
        const on = key === active;
        return (
          <span
            key={key}
            data-slot-state={key}
            className={`col-start-1 row-start-1 flex min-w-0 items-center ${on ? "" : "invisible"}`}
            aria-hidden={on ? undefined : true}
            inert={!on}
          >
            {states[key]}
          </span>
        );
      })}
    </span>
  );
}
