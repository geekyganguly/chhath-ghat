# Ghat loudspeaker songs

## Option 1 — a YouTube video (current setup)

`playlist.json` has a `"youtube"` entry with a video id. The game plays it through YouTube's
official embedded player (shown as a small "Ghat TV" screen) and turns its volume up/down
as you walk near/away from the loudspeakers. Remove the `"youtube"` entry to use files instead.

## Option 2 — your own audio files

Put the MP3 (or .m4a/.ogg) files you have the rights to use in this folder, using the
file names listed in `playlist.json` — or edit `playlist.json` to match your files.

- Songs play in order and loop. Missing files are skipped automatically.
- Every player hears the same song at the same moment (synced to the shared game clock),
  so all players must load the same files: deploy them together with the game.
- Songs are not included in this repository because they are copyrighted recordings.
