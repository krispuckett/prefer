<img src=".claude-plugin/icon.png" width="96" alt="">

# Prefer

A taste finding skill for Claude Code.

If you design with Claude Code, you've already told it yes and no hundreds of times: kill that border, softer glow, the second one. Prefer finds those moments in your own history, writes them up as rules your agent can load, and then checks whether those rules actually know you.

## What it does

Three steps, all on your machine:

1. **Finds your verdicts.** It reads your old Claude Code chats and pulls out every time you judged design work: what was on the table, what you picked, and why.
2. **Writes your taste down.** From your older verdicts it writes a skill, a SKILL.md file of rules like "no side borders on cards", each one backed by real verdicts. Your agent can load it before it shows you anything.
3. **Tests it blind.** It hides your newest choices and asks a model to guess what you picked, once with your skill and once knowing nothing about you. If the skill is any good, the first guesser wins.

"Skill" means two things here. Prefer is a Claude Code skill you install. What it makes for you is a second skill: your taste.

## Install

You need Claude Code and Node 18 or newer (`node --version` to check, or get it from nodejs.org). It runs on macOS and Linux; on Windows, use WSL.

In Claude Code:

```
/plugin install prefer --marketplace krispuckett/prefer
```

On Claude Code older than 2.1.275, use two steps instead: `/plugin marketplace add krispuckett/prefer`, then `/plugin install prefer@prefer`.

Then ask Claude Code to find your design taste. It asks which names to keep out (your employer, your clients), shows you every file it will read and waits for your yes, runs in the background, explains your report, and offers to install your taste skill.

## What you get

In a folder you name:

- `SKILL.md`: your taste as hard bans, positive laws and context rules. Each rule says when it passes and when it fails, how many verdicts back it, and their ids.
- `report.md`: the blind test. Both scores, the gap, n, and a sign test that says whether the gap could be chance.
- `report.json`: the numbers only, safe to share.

## Run it from a terminal

```bash
git clone https://github.com/krispuckett/prefer && cd prefer
```

Write `~/deny.txt` first: one name per line. Put your employer, your clients and anyone you would rather keep out of the output. Matches become `[name]` before any text reaches a model.

```bash
node prefer.js run --out ~/prefer-run --deny ~/deny.txt
```

To load your taste skill in Claude Code afterwards:

```bash
node prefer.js install --out ~/prefer-run
```

Before it reads anything, it checks your Node and Claude Code versions and makes one tiny call to each model it will use. If a check fails, it prints the reason Claude Code gave. If `claude` lives somewhere unusual, set `PREFER_CLAUDE` to its full path. It passes along the settings Claude Code uses for an API key, Bedrock, Vertex and proxies. So far it has only been tried with a subscription sign-in.

It uses your own Claude usage: about one Sonnet call per 25 candidate turns (up to about 160 on a big history), one Opus call to write the skill, and about ten calls for the test.

The steps, if you want them one at a time:

| Command | What it does | Model calls |
|---|---|---|
| `scan` | Lists every file it will read, waits for a yes, counts sessions | none |
| `mine` | Finds candidate verdict turns, redacts them, classifies them into verdict records | about 1 per 25 candidates |
| `skill` | Writes SKILL.md from verdicts before the cutoff | 1 |
| `test` | Rewords test items blind, shuffles, runs both predictors several times, scores | about 10 |
| `run` | All of the above | |
| `install --out DIR` | Copies your taste skill into `~/.claude/skills/` | none |

Every call is cached in the output folder, so a stopped run picks up where it left off.

## How the test stays honest

An earlier hand-made version of this test looked great on my own choices, until a predictor told nothing about me scored just as well. The questions were giving their answers away through how the options were worded. So the test is built around that failure:

- The skill never sees a test item. Items come from after the cutoff, and any item that repeats a question from before the cutoff is dropped.
- A separate call rewords every question and option without being told which option was picked. A word check then drops anything that still leans (better, cleaner, original, keep, revert and friends).
- Option order is shuffled with a recorded seed, and the answer key is balanced so position tells you nothing. The key is written and hashed before any prediction runs.
- Every model call runs in a clean context: no tools, no settings, no memory, no CLAUDE.md, no skills, from an empty folder. Before predicting, the scorer is asked what it knows about you. If it names anything from your history, the report says CONTAMINATED and shows no score.
- Both predictors use the same model and run several times. The report shows every run, plus a sign test on the items where the two disagreed.
- Items are split by source. Some are real menus the agent offered. Most are corrections, where you rejected what was shown and asked for something else. Corrections are easier to guess, so each source gets its own score.

## Privacy

- Runs on your machine. Model calls go through your own Claude Code sign-in and nowhere else.
- Reads `~/.claude/projects/*/*.jsonl`, plus the first 10 lines of any memory index for the canary check. `scan` prints the full list before reading anything.
- Writes only inside `--out`.
- Redacts emails, keys, tokens, passwords in `NAME=value` form, logins inside URLs, phone numbers, IPs, home paths and every deny-list name (also when it is joined to another word, like `acmecorp`) before any text reaches a model. Single first names it can't know about get through, so put them in the deny list.
- Images are never sent.
- `candidates.jsonl`, `batches/` and `cache/` hold redacted excerpts of your turns so runs can resume. `verdicts.jsonl` is paraphrased by the model, but short phrases can slip through. `manifest.json` lists your project folders and names that recur in your history. Keep all five private.
- `SKILL.md` and `report.json` are the files meant to be shared. SKILL.md can name your projects and quote short phrases from the verdicts, so read it before you share it.

## Limits

- It reads text only. The screenshots you reacted to are never seen, so verdicts that lived in an image are thin.
- The rewording and the predicting use the same model family, which may leave some wording hints behind.
- Small samples. The report gives a sign test on the items where the two arms disagreed, and says plainly when the gap could be chance.
- It needs about 30 testable verdicts to run the blind test. A short history gets a message saying so.
- The prefilter that finds candidate turns looks for English words.
- Claude Code history only.


## Why I built it

I teach people to build their own agent in [NEUMA](https://heyneuma.com). This is the part of that work I most wanted to measure.
