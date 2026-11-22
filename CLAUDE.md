# Hunt

- **Devices**: the Next.js app (`src/`) runs in the desktop launcher *and* on touch tablets via the LAN URL. Size every control for touch: `coarse:` / `hoverless:` Tailwind variants, 44px targets on coarse pointers, never hover-only.
- **Phone app**: `public/hunt-mobile.html` is the phone/tablet companion. Edit it there, then copy it byte-for-byte to `android-app/app/src/main/assets/hunt-mobile.html` (a test enforces they match).
- **Layout changes**: run `npm run test:geometry` (real-browser widths 360–2560px); jsdom unit tests cannot see overflow or off-screen popovers.
- **Review**: judge diffs against `CODING_STANDARDS.md`. Mechanical UI rules live in `src/__tests__/sourceScan_uiGuardrails.test.ts`.
- **Spec**: `Instructions_for_AI.md` holds the project's trigger-based quality spec; read the section whose trigger matches the task.
