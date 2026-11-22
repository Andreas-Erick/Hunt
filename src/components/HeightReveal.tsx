"use client";

import React from "react";
import { AnimatePresence, motion } from "framer-motion";

const REVEAL_TRANSITION = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

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
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="reveal"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={REVEAL_TRANSITION}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
