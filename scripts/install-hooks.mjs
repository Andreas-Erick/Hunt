// Points git at the versioned hooks in .githooks/ (runs as npm's `prepare` step).
// Outside a git checkout (CI tarballs, installer staging) it does nothing.
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // Not a git checkout, or git is unavailable: hooks are a local convenience, never a build step.
}
