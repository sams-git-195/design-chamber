# Design Chamber — Known Issues

Minor issues found in review and accepted for now. Each has a fix prompt: paste it to the
owning agent to fix it. **When an entry is fixed, delete it** in the same commit — this file
lists what is open, git history holds what was closed. Anything serious does not belong here;
it blocks the merge instead. Anything nobody can hit does not belong here either: an entry is
added only if it passes the 🟣 gate (who it reaches, seen or unseen, can it actually happen).

No open entries. KI-2…KI-5 were fixed in the smoke fix round (2026-10-27); see `documentation/smoke/REPORT.md`.

<!-- entry format:
### KI-1 — short title
🟣 Minor · found YYYY-MM-DD · `path/file.ext:line` · owner: agent-name
**What:** the issue, one or two sentences
**Who:** end user / admin / operator · **Seen:** visible in UI / silent — what it affects
**Happens:** the real action that triggers it · common / edge case / rare · **Effect:** what the person experiences
**Why not fixed now:** reason
**Fix prompt:**
> self-contained prompt for the owning agent: what to change, the test to add, the gates to run
-->
