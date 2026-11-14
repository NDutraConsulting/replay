#!/usr/bin/env bash
# Shrinks the lesson avatars (about 1-2 MB PNGs in .focusari/lesson-avatars) to small WebP files in public/lessons/avatars.
# Needs macOS `sips` and `cwebp` (brew install webp). The originals are never changed.
# Usage: scripts/make-lesson-avatars.sh        (run from replay-chat-vite/)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=".focusari/lesson-avatars"
OUT="public/lessons/avatars"
mkdir -p "$OUT"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# "original file name|slug" : the slug is what lessons.db stores (backend/db/lesson_seeds/avatars.py lists the same slugs)
while IFS='|' read -r file slug; do
  [[ -z "$file" ]] && continue
  [[ -f "$SRC/$file.png" ]] || { echo "Missing: $SRC/$file.png" >&2; exit 1; }
  sips -Z 420 "$SRC/$file.png" --out "$tmp/$slug.png" >/dev/null
  cwebp -quiet -q 82 -alpha_q 90 "$tmp/$slug.png" -o "$OUT/$slug.webp"
done <<'LIST'
Amazed T. Rex Scientist|amazed
Curious T. rex scientist points upward|curious-points-up
Friendly green T. rex guide|guide
Friendly Lab-Coated T. Rex Guide|lab-coat-guide
Friendly Scientist T. Rex Pointing Down-Right|points-down-right
Friendly Scientist T. Rex Points Up-Left|points-up-left
Friendly Scientist T. Rex with Rubik’s Cube|rubiks-cube
Friendly scientist T. Rex with Summary sign|summary-sign
Friendly T. Rex Behind Giant Cassette Player|cassette-player
Friendly T. Rex Presents a Floating Tesseract|tesseract
Friendly T. rex presents glowing tesseracts|glowing-tesseracts
Friendly T. Rex Scientist Gives Thumbs-Up|thumbs-up-gives
Friendly T. rex Scientist Thumbs-Up|thumbs-up
Friendly T. Rex Scientist with Summary Clipboard|summary-clipboard
Friendly T. Rex Scientist with Yellow Glasses|yellow-glasses
Glasses-Wearing T. Rex Checks the Clock|checks-clock
Puzzled Scientist T. Rex with Pocket Watch|puzzled-pocket-watch
Quizzical T. Rex Scientist|quizzical
Scientist T. Rex and Floating Dodecahedron|dodecahedron
Scientist T. Rex and Golden AI Orb|golden-ai-orb
Scientist T. Rex Double Thumbs-Up|double-thumbs-up
Scientist T. Rex Introduces Floating Robot|floating-robot
Scientist T. Rex with Giant Cassette|giant-cassette
Skeptical Scientist T. Rex Pointing Left|skeptical-points-left
Thoughtful Scientist T. Rex|thoughtful
Thoughtful T. Rex Pointing Down-Left|thoughtful-points-down-left
Winking T. Rex Scientist Pointing Left|winking-points-left
LIST
echo "Wrote $(ls "$OUT" | wc -l | tr -d ' ') avatars to $OUT ($(du -sh "$OUT" | cut -f1))."
