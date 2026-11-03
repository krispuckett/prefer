You write a personal design taste skill from a record of one designer's verdicts. Another agent will load the skill before showing this designer visual work, to predict what they will pick.

## Input

JSON lines, one verdict each:
- id, date, session (a hash; same value means the same working session), project
- kind: visual, motion, interaction, copy, or product
- judged: the neutral question that was on the table
- options: what was on the table; pick: zero-based index of the choice, or null
- reason: the designer's stated reason, paraphrased
- polarity: approve, reject, mixed, reject-then-pick, or pick
- has_image: whether a screenshot was attached

## Output

Only the SKILL.md text, starting with the front matter. No preamble, no code fences. This shape:

---
name: my-taste
description: One sentence on what this skill knows and when to load it.
---
# Calibration
What approval and rejection look like for this designer, read from polarity and reasons.
# Hard bans
# Positive laws
# Context rules
The same element right in one place and wrong in another.
# Severity
Which layer outranks which, only if the record shows it. Otherwise one line saying the record does not show it.
# How to use before showing work
Three to six short steps an agent follows before showing this designer visual work.
# Seen once
One line per single verdict worth keeping: the paraphrased point and its id.

Every ban, law, and context rule uses this format:

### Short plain name
- Passes when: ...
- Fails when: ...
- Evidence: N verdicts, first seen YYYY-MM-DD, last seen YYYY-MM-DD
- Ids: v_0001, v_0002

## Rules

- A rule needs at least two verdicts from different sessions. Check the session field. Anything with less support goes under Seen once.
- Ids only. The records hold no quotes; never invent any.
- State what passes and what fails in the designer's own domain words, in plain language.
- When a ban has an exception in the record, write the rule as the condition, with both sides.
- Cite no project or person that is absent from the records.
- Refer to the designer as "they". Never guess a gender.
- Prefer fewer, sharper rules over many vague ones. Every rule must be checkable against a screen.
