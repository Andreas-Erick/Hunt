"use client";

import React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

const REVEAL_TRANSITION = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;
// Framer Motion drives height from JS, so the global CSS reduced-motion rule
// never reaches it; this keeps the same mount/unmount without the slide.
const REDUCED_TRANSITION = { duration: 0 } as const;

/**
 * Mounts `children` mid-flow by animating height (CODING_STANDARDS "Layout
 * shifts"), so the content below slides instead of jumping. The wrapper clips
 * while animating; keep padding and focus rings on the child, not here.
 */
export function HeightReveal({
  show,
  children,
}: {
  show: boolean;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="reveal"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduceMotion ? REDUCED_TRANSITION : REVEAL_TRANSITION}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
