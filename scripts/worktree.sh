#!/usr/bin/env bash
# Prepare or tear down a git worktree of this repo for an agent.
#
#   bash scripts/worktree.sh setup    [worktree-dir]   (default: current dir)
#   bash scripts/worktree.sh teardown <worktree-dir>
#
# setup links what a fresh worktree lacks because git ignores it:
#   node_modules           -> link to the main checkout's (no npm ci)
#   Instructions_for_AI.md -> copy (local quality spec named by CLAUDE.md)
#   CLAUDE.md, CODING_STANDARDS.md, GLOSSARY.md -> copy (local agent docs,
#                             kept out of the repo)
#   debug.keystore         -> copy, so android-app/build-apk.sh signs
#                             with the pinned key without KEYSTORE=...
# teardown unlinks node_modules first, then removes the worktree, so
# the removal can never follow the link into the main node_modules.
set -euo pipefail

die() { echo "worktree.sh: $*" >&2; exit 1; }

main_root() {
  local common
  common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)
  dirname "$common"
}

is_windows() { [ -n "${WINDIR:-}" ] || [ "${OS:-}" = "Windows_NT" ]; }

winpath() { if is_windows; then cygpath -w "$1"; else echo "$1"; fi; }

is_link() {
  local p=$1
  [ -L "$p" ] && return 0
  if is_windows && [ -e "$p" ]; then
    local t
    t=$(powershell -NoProfile -Command \
      "(Get-Item -Force -LiteralPath '$(winpath "$p")').LinkType" | tr -d '\r')
    [ -n "$t" ] && return 0
  fi
  return 1
}

link_dir() { # link_dir <target> <link>
  if is_windows; then
    powershell -NoProfile -Command "New-Item -ItemType Junction \
      -Path '$(winpath "$2")' -Target '$(winpath "$1")' | Out-Null"
  else
    ln -s "$1" "$2"
  fi
}

unlink_dir() { # removes the link only, never its target
  if is_windows && [ ! -L "$1" ]; then
    powershell -NoProfile -Command \
      "(Get-Item -Force -LiteralPath '$(winpath "$1")').Delete()"
  else
    rm "$1"
  fi
}

setup() {
  local wt main
  wt=$(cd "${1:-.}" && pwd)
  main=$(main_root "$wt")
  [ "$wt" != "$main" ] || die "$wt is the main checkout, not a worktree"

  if [ -e "$wt/node_modules" ]; then
    echo "node_modules: already present"
  else
    link_dir "$main/node_modules" "$wt/node_modules"
    echo "node_modules: linked to $main/node_modules"
  fi

  local doc
  for doc in Instructions_for_AI.md CLAUDE.md CODING_STANDARDS.md GLOSSARY.md; do
    if [ -f "$main/$doc" ]; then
      cp "$main/$doc" "$wt/$doc"
      echo "$doc: copied"
    fi
  done

  local key=android-app/app/build/direct-apk/debug.keystore
  if [ -f "$main/$key" ] && [ ! -f "$wt/$key" ]; then
    mkdir -p "$(dirname "$wt/$key")"
    cp "$main/$key" "$wt/$key"
    echo "debug.keystore: copied"
  fi
}

teardown() {
  [ -n "${1:-}" ] || die "teardown needs a worktree dir"
  local wt main
  wt=$(cd "$1" && pwd)
  main=$(main_root "$wt")
  [ "$wt" != "$main" ] || die "refusing to tear down the main checkout"

  if [ -e "$wt/node_modules" ]; then
    is_link "$wt/node_modules" \
      || die "$wt/node_modules is a real folder, not a link; remove it by hand"
    unlink_dir "$wt/node_modules"
    echo "node_modules: unlinked"
  fi
  git -C "$main" worktree remove --force --force "$wt"
  echo "worktree removed: $wt"
}

case "${1:-}" in
  setup) shift; setup "${1:-.}" ;;
  teardown) shift; teardown "${1:-}" ;;
  *) die "usage: worktree.sh setup [dir] | teardown <dir>" ;;
esac
