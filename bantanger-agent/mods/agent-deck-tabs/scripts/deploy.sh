#!/usr/bin/env bash
# Deploy the agent-deck-tabs mod — the only sanctioned writer of a deployed copy.
#
#   scripts/deploy.sh             install into $HERDR_APP_HOME/mods/agent-deck-tabs (a scratch or test app home)
#   scripts/deploy.sh --live      install into the user's live app home, with a backup and a rollback line
#   scripts/deploy.sh --dry-run   print source, target and the rsync command; write nothing
#
# Agents use --dry-run or a scratch HERDR_APP_HOME; --live is the user's own command.
#
# The mod's preview queue is fed by the `open` shim (`~/.local/bin/open`), which appends
# every clicked path to `~/.cache/herdr-open/queue.json`. That shim is installed separately
# and is not this script's file: losing it only costs the rail its queue, never the preview.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: deploy.sh [--live] [--dry-run]

  (no flag)   install into $HERDR_APP_HOME/mods/agent-deck-tabs; refuses the live app home
  --live      install into ~/.config/herdr-app/mods/agent-deck-tabs, after backing it up
  --dry-run   print the resolved source, target and rsync command; write nothing
EOF
}

live=0
dry=0
for arg in "$@"; do
  case $arg in
    --live) live=1 ;;
    --dry-run) dry=1 ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'deploy.sh: unknown argument: %s\n\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

mod=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f $mod/mod.json ]] || { printf 'deploy.sh: %s is not the agent-deck-tabs mod\n' "$mod" >&2; exit 2; }

# A path as it really is, so "$HERDR_APP_HOME/" and a symlinked home compare equal.
canonical() {
  local p=${1%/}
  [[ -n $p ]] || p=/
  if [[ -d $p ]]; then (cd -- "$p" && pwd -P); else printf '%s\n' "$p"; fi
}

live_home=$(canonical "$HOME/.config/herdr-app")

if (( live )); then
  app_home=$live_home
else
  app_home=${HERDR_APP_HOME:-}
  if [[ -z $app_home ]]; then
    if (( ! dry )); then
      printf 'deploy.sh: HERDR_APP_HOME is not set\n\n' >&2
      usage >&2
      exit 2
    fi
    # Nothing is written by a dry run, so the live home is the plan worth showing.
    app_home=$live_home
    printf 'note: HERDR_APP_HOME is not set, so this plans the live app home\n'
  else
    app_home=$(canonical "$app_home")
    if (( ! dry )) && [[ $app_home == "$live_home" ]]; then
      printf 'deploy.sh: refusing to write the live app home; pass --live if you mean it\n' >&2
      exit 2
    fi
  fi
fi

target=$app_home/mods/agent-deck-tabs
backups=$HOME/.herdr/agent-deck-tabs-install-backup

# tests/ and package.json are for development; the generated declarations belong to the app home.
rsync_args=(-a --delete
  --exclude=/tests/ --exclude=/package.json
  --exclude=/gpui-kit.d.ts --exclude=/herdr.d.ts --exclude=/jsconfig.json)

if (( dry )); then
  printf 'source: %s\n' "$mod"
  printf 'target: %s\n' "$target"
  if (( live )) || [[ $app_home == "$live_home" ]]; then
    printf 'live:   yes — running this plan writes the user'"'"'s app home\n'
  fi
  printf 'rsync %s %q/ %q/\n' "${rsync_args[*]}" "$mod" "$target"
  if (( live )); then
    printf 'backup: %s/<UTC timestamp>/ first, then: herdr-app check %s\n' "$backups" "$target"
  fi
  printf 'dry run: nothing written\n'
  exit 0
fi

# The candidate is checked BEFORE it can reach the live home: a mod that fails `herdr-app check`
# would otherwise hot-reload a broken window first and only then report. The check runs against a
# throwaway app home holding exactly what is about to be installed.
checker=${HERDR_APP_CHECK_BIN:-herdr-app}
stage=
cleanup() { [[ -n $stage ]] && rm -rf -- "$stage"; }
trap cleanup EXIT

stage=$(mktemp -d)
mkdir -p -- "$stage/home/mods/agent-deck-tabs"
rsync "${rsync_args[@]}" "$mod/" "$stage/home/mods/agent-deck-tabs/"

if ! HERDR_APP_HOME=$stage/home "$checker" check "$stage/home/mods/agent-deck-tabs"; then
  printf 'check: FAILED on the staged copy — nothing was installed, %s is untouched\n' "$target" >&2
  exit 1
fi
printf 'check: passed (staged)\n'

backup=
if (( live )) && [[ -d $target ]]; then
  backup=$backups/$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p -- "$backup"
  cp -a -- "$target/." "$backup/"
  printf 'backup: %s\n' "$backup"
fi

mkdir -p -- "$target"
rsync "${rsync_args[@]}" "$mod/" "$target/"
printf 'installed: %s\n' "$target"

if [[ -n $backup ]]; then
  printf 'rollback: rsync -a --delete %q %q\n' "$backup/" "$target/"
  printf 'backup: %s\n' "$backup"
fi
