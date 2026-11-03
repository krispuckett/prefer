---
name: prefer
description: Mine the user's own Claude Code history for the moments they judged design work, write a personal taste skill from those verdicts, and score that skill in a blind test against a predictor that knows nothing about them. Use when someone asks to find their design taste, build a taste skill from their history, or test how well a taste skill predicts their choices.
---
# Prefer

A local Node script reads the user's Claude Code transcripts on this machine, finds the moments they said yes or no to design work, writes those verdicts up as a skill, and tests that skill blind. Every model call goes through the user's own Claude Code sign-in with `claude -p`. Nothing is sent anywhere else.

The script is `${CLAUDE_PLUGIN_ROOT}/prefer.js`. Run it with `node`. It needs Node 18 or newer.

## Run it with the user, in this order

1. **Say what will happen, in two sentences.** It reads their Claude Code history on this machine, pulls out their design verdicts, writes a taste skill from the older ones, and checks how well that skill predicts the newer ones. It uses their own Claude usage: about one Sonnet call per 25 candidate turns (up to about 160 calls on a big history), one Opus call to write the skill, and about ten calls for the test.

2. **Ask for the deny list.** Ask which names must never appear: their employer, their clients, and any people. Write them one per line to `~/prefer-deny.txt`. Matches become `[name]` before any text reaches a model. Do not skip this, even if they say there is nothing sensitive; at least ask about the employer and clients.

3. **Show what it will read, and get a yes.** Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/prefer.js" scan --out ~/prefer-run --deny ~/prefer-deny.txt
   ```
   With no terminal attached it lists every file and stops without reading any of them. Tell the user how many files and how much data, and ask whether to go ahead. Only a clear yes from the user counts. Never add `--yes` on your own.

4. **Run it in the background.** After the yes:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/prefer.js" run --out ~/prefer-run --deny ~/prefer-deny.txt --yes
   ```
   Use the Bash tool's background mode, because a large history runs well past the ten-minute limit of a normal call. Tell the user it is running and that a stopped run picks up where it left off. If it stops on an error, show the user the reason it printed (a usage limit, sign-in, a missing model) and rerun the same command once that is fixed. Every finished call is cached.

5. **Explain the result in plain words.** Read `~/prefer-run/report.md`. Give both scores, the gap, and the sign test line exactly as the report states them. If the report says the gap could be chance, say so plainly. A capable model with no history often predicts most of a designer's calls, and that is a real finding too. If the report says CONTAMINATED, say there is no score and show what `test/canary.json` says the scorer saw.

6. **Offer to install their taste skill.** If they want it:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/prefer.js" install --out ~/prefer-run
   ```
   It copies their SKILL.md to `~/.claude/skills/<name>/` and refuses to overwrite one that is already there unless they say so (then add `--yes`). Suggest they read it first.

## Options worth knowing

- `--cutoff 2026-09-01` picks the date between the verdicts the skill learns from and the ones it is tested on. By default the newest quarter is held out, at least 20.
- `--predict-model opus` scores with Opus instead of Sonnet. `--repeats 3` sets runs per arm.
- `--calibration FILE` is a short note on what approval and rejection sound like for this person ("fine" means no, "rad" means yes).
- `--source menu|correction|all` limits the test to menus the agent offered or to corrections the user asked for.

## What it reads and writes

- Reads `~/.claude/projects/*/*.jsonl`, streamed line by line. For the leak check only, the first 10 lines of any `~/.claude/projects/*/memory/MEMORY.md`, which are never written anywhere.
- Writes only inside `--out`. `candidates.jsonl`, `batches/`, `cache/`, `verdicts.jsonl` and `manifest.json` hold excerpts or names from their history: keep them private. `SKILL.md` and `report.json` are meant to be shared, but SKILL.md can name their projects, so they should read it first.
- Images are never sent.

## How the test stays honest

- The skill learns only from verdicts before the cutoff. Test items come after it, and any item that repeats an earlier question is dropped.
- A separate call rewords every question and option without seeing the pick. A word check drops anything that still leans.
- Option order is shuffled with a seed, the answer key is balanced, and the key is hashed before any prediction runs.
- The scorer runs with no tools, no settings, no memory and no skills, in an empty folder. A context check and a canary prove it. If either fails, the report says CONTAMINATED and has no score.
- Both predictors use the same model and run several times. The report gives every run and a sign test.
