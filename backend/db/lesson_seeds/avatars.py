"""The lesson avatars: slug, file under replay-chat-vite/public/lessons/avatars, alt text and which way the T. rex faces.

The files are made from the originals in replay-chat-vite/.focusari/lesson-avatars by scripts/make-lesson-avatars.sh, which
uses the same slugs."""

# (slug, alt text, facing)
_AVATARS = [
    ("amazed", "A T. rex scientist with wide eyes, amazed", "front"),
    ("curious-points-up", "A curious T. rex scientist pointing upward", "up"),
    ("guide", "A friendly green T. rex guide waving hello", "front"),
    ("lab-coat-guide", "A friendly T. rex guide in a lab coat", "front"),
    ("points-down-right", "A friendly T. rex scientist pointing down and to the right", "down-right"),
    ("points-up-left", "A friendly T. rex scientist pointing up and to the left", "up-left"),
    ("rubiks-cube", "A T. rex scientist holding a Rubik's cube", "front"),
    ("summary-sign", "A T. rex scientist holding a sign that says Summary", "front"),
    ("cassette-player", "A T. rex standing behind a giant cassette player", "front"),
    ("tesseract", "A T. rex presenting a floating tesseract", "front"),
    ("glowing-tesseracts", "A T. rex presenting glowing tesseracts", "front"),
    ("thumbs-up-gives", "A T. rex scientist giving a thumbs-up", "front"),
    ("thumbs-up", "A T. rex scientist with a thumb up", "front"),
    ("summary-clipboard", "A T. rex scientist holding a clipboard of notes", "front"),
    ("yellow-glasses", "A T. rex scientist wearing yellow glasses", "front"),
    ("checks-clock", "A T. rex in glasses checking the clock", "front"),
    ("puzzled-pocket-watch", "A puzzled T. rex scientist with a pocket watch", "front"),
    ("quizzical", "A quizzical T. rex scientist", "front"),
    ("dodecahedron", "A T. rex scientist beside a floating dodecahedron", "front"),
    ("golden-ai-orb", "A T. rex scientist beside a golden AI orb", "front"),
    ("double-thumbs-up", "A T. rex scientist with both thumbs up", "front"),
    ("floating-robot", "A T. rex scientist introducing a floating robot", "front"),
    ("giant-cassette", "A T. rex scientist with a giant cassette", "front"),
    ("skeptical-points-left", "A skeptical T. rex scientist pointing left", "left"),
    ("thoughtful", "A thoughtful T. rex scientist", "front"),
    ("thoughtful-points-down-left", "A thoughtful T. rex pointing down and to the left", "down-left"),
    ("winking-points-left", "A winking T. rex scientist pointing left", "left"),
]

AVATARS = [
    {"avatar_slug": slug, "file": f"{slug}.webp", "alt": alt, "facing": facing} for slug, alt, facing in _AVATARS
]
