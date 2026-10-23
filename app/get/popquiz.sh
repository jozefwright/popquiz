#!/bin/sh
# Pop Quiz: put the current plugin on this Mac, or bring the one here up to date.
#
#   curl -fsSL <site>/get/popquiz.sh | POPQUIZ_SITE=<site> sh
#       fetches Pop Quiz into ~/PopQuiz/app. Run it again whenever the panel says a
#       newer Pop Quiz is out; only what has changed is downloaded.
#
#   curl -fsSL <site>/get/popquiz.sh | POPQUIZ_SITE=<site> sh -s -- --auto
#       the same, and from then on this Mac looks for a newer Pop Quiz every
#       quarter of an hour by itself. --stop undoes that.
#
# Chrome will not let anything load or reload an extension for you. The first
# time, load the folder yourself (chrome://extensions, Developer mode, Load
# unpacked). After an update, the Pop Quiz panel shows a Reload Pop Quiz button.
#
# Every file is checked against the list the site publishes before it is put in
# place, and the manifest goes in last, so Chrome never sees half a version.
# If Pop Quiz's folder is a git checkout, this pulls it instead.
set -eu

SITE="${POPQUIZ_SITE:-}"
DIR="${POPQUIZ_DIR:-$HOME/PopQuiz/app}"
HOME_DIR="${POPQUIZ_HOME:-$HOME/PopQuiz}"
LABEL="${POPQUIZ_LABEL:-fun.popquiz.update}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AUTO=""
STOP=""
for arg in "$@"; do
  case "$arg" in
    --auto) AUTO=1 ;;
    --stop) STOP=1 ;;
    *) echo "Pop Quiz: I do not know \"$arg\". Use --auto, --stop, or nothing." >&2; exit 2 ;;
  esac
done

if [ -n "$STOP" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Pop Quiz will no longer look for updates by itself."
  exit 0
fi

if [ -z "$SITE" ]; then
  echo "Pop Quiz: say which site to fetch from, as the install page shows: POPQUIZ_SITE=<site> sh" >&2
  exit 2
fi
SITE="${SITE%/}"

version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/manifest.json" 2>/dev/null | head -1; }
before="$(version || true)"

top=""
if [ -d "$DIR" ]; then top="$(cd "$DIR" && git rev-parse --show-toplevel 2>/dev/null || true)"; fi

if [ -n "$top" ]; then
  git -C "$top" pull --ff-only --quiet
else
  mkdir -p "$DIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$SITE/files.txt" -o "$tmp/files.txt"
  changed=0
  while read -r sum file; do
    [ -n "$file" ] || continue
    case "$file" in /* | *..*) echo "Pop Quiz: skipping an odd path, $file" >&2; continue ;; esac
    have=""
    if [ -f "$DIR/$file" ]; then have="$(shasum -a 1 "$DIR/$file" | cut -d' ' -f1)"; fi
    [ "$have" = "$sum" ] && continue
    mkdir -p "$tmp/new/$(dirname "$file")"
    curl -fsSL "$SITE/$file" -o "$tmp/new/$file"
    got="$(shasum -a 1 "$tmp/new/$file" | cut -d' ' -f1)"
    if [ "$got" != "$sum" ]; then
      echo "Pop Quiz: $file did not arrive whole. Nothing on this Mac was changed. Try again in a minute." >&2
      exit 1
    fi
    changed=$((changed + 1))
  done < "$tmp/files.txt"
  if [ "$changed" -gt 0 ]; then
    (cd "$tmp/new" && find . -type f ! -path ./manifest.json | while read -r f; do
      mkdir -p "$DIR/$(dirname "$f")"
      mv "$f" "$DIR/$f"
    done)
    if [ -f "$tmp/new/manifest.json" ]; then mv "$tmp/new/manifest.json" "$DIR/manifest.json"; fi
  fi
fi

after="$(version || true)"
if [ -z "$before" ]; then
  echo "Pop Quiz $after is in $DIR"
  echo "Now, once: open chrome://extensions, turn on Developer mode, press Load unpacked and choose that folder."
elif [ "$before" != "$after" ]; then
  echo "Pop Quiz $after is on this Mac (it was $before). Press Reload Pop Quiz in the Pop Quiz panel."
else
  echo "Pop Quiz $after is up to date."
fi

if [ -n "$AUTO" ]; then
  mkdir -p "$HOME_DIR" "$HOME/Library/LaunchAgents"
  curl -fsSL "$SITE/get/popquiz.sh" -o "$HOME_DIR/popquiz.sh"
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$HOME_DIR/popquiz.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>POPQUIZ_DIR</key><string>$DIR</string><key>POPQUIZ_SITE</key><string>$SITE</string><key>PATH</key><string>/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/update.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/update.log</string>
</dict>
</plist>
PLIST_END
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "This Mac will now look for a newer Pop Quiz every quarter of an hour. To stop: sh $HOME_DIR/popquiz.sh --stop"
fi
