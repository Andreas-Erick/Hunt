import React from "react";

const W = 640;
const H = 224;
const CX = W / 2;
const GROUND = 196;
const RX = 280;
const RY = 172;

/** Point on the arc for a fraction of the hour (0 = left horizon, 1 = right). */
export function sunPosition(fraction: number): { x: number; y: number } {
  const f = Math.min(1, Math.max(0, fraction));
  const angle = Math.PI * (1 - f);
  return { x: CX + RX * Math.cos(angle), y: GROUND - RY * Math.sin(angle) };
}

/**
 * Dawn's Focus progress (ADR-0005): the sun makes one pass across the sky per
 * hour on this task, rising at :00, highest at :30, setting at :60, then rises
 * again for the next hour. Hidden in the Neon look by `.focus-sun-arc` CSS.
 */
export function FocusSunArc({ elapsedSeconds }: { elapsedSeconds: number }) {
  const total = Math.max(0, Math.floor(elapsedSeconds));
  const hour = Math.floor(total / 3600);
  const fraction = (total % 3600) / 3600;
  const start = sunPosition(0);
  const sun = sunPosition(fraction);
  const minutes = Math.floor((total % 3600) / 60);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Minute ${minutes} of hour ${hour + 1} on this task`}
      data-testid="focus-sun-arc"
      className="focus-sun-arc mt-4 sm:mt-6 -mb-2 w-full max-w-xl"
    >
      <path
        d={`M${start.x} ${GROUND} A${RX} ${RY} 0 0 1 ${CX + RX} ${GROUND}`}
        fill="none"
        className="stroke-white/20"
        strokeWidth={1.2}
        strokeDasharray="2 6"
        strokeLinecap="round"
      />
      {fraction > 0 && (
        <path
          d={`M${start.x} ${start.y} A${RX} ${RY} 0 0 1 ${sun.x} ${sun.y}`}
          fill="none"
          className="stroke-accent"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      )}
      <line x1={0} y1={GROUND} x2={W} y2={GROUND} className="stroke-white/35" strokeWidth={1} />
      <circle cx={sun.x} cy={sun.y} r={22} className="fill-accent/15" />
      <circle cx={sun.x} cy={sun.y} r={10} className="fill-accent" />
      <text x={start.x} y={GROUND + 18} textAnchor="middle" className="fill-hud-muted text-xs">
        {hour === 0 ? "Start" : `${hour}h`}
      </text>
      <text x={CX + RX} y={GROUND + 18} textAnchor="middle" className="fill-hud-muted text-xs">
        {`${hour + 1}h`}
      </text>
    </svg>
  );
}
