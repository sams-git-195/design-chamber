# Ask when unsure — protocol

Asking is cheap; redesigning the wrong thing is not. But questions you could have answered by reading are noise. Order: **read, then ask, then build.**

## 1. Read before you ask

Do the project discovery in `DESIGN-RULES.md` §2 first. Read the brief, the linked project, the existing design folder (`DESIGN.md`, `tokens.css`, `design.json`), and attached files. Never ask something the files already answer; cite them instead.

## 2. Ask vs. proceed

**Ask** (one message, then stop and write no screens) when a missing answer would change the design materially and you cannot infer it:

- New design from an open brief: audience, primary task, tone, key screens are unknown.
- No project design system and no preset chosen (the look is yours to propose).
- **Viewports are unclear** (always ask; see §4).
- The brief has two plausible readings with different outcomes.
- Real content or brand assets (logo, photos, copy) might exist but you can't find them.

**Proceed** (state your reading as an "Assumptions" list, then build) when:

- The user said "go", "just do it", "surprise me", or turned questions off.
- It is a small edit, a pinned comment, or a revision request: make the change, verify it, ask one question only if truly ambiguous.
- The project/preset/DESIGN.md already fixes look, devices and content.
- The user already answered the same question earlier in this session or in `design.json`/`DESIGN.md`.

Never ask more than **one round** before the first screen exists. Put questions, the palette/type proposal and any direction choice in the same message.

## 3. How to ask

- 3–6 short numbered questions, in ONE message. Fewer is better; ask only what changes the design.
- Each gets a **bold recommended default** and a few words of why: `2. Tone? **Calm and editorial** — fits a long-reading product.`
- Questions worth asking, in order of value: devices/viewports, audience + primary task, tone/feel, key screens/flow, real content & brand assets, look source (project / preset / new), number of directions.
- Multiple-choice beats open-ended. Name the options.
- End with exactly: **"Reply with changes, or say *go* to accept the defaults."**
- After the answer: write down what was agreed in `DESIGN.md` (and viewports in `design.json`), then build.
- Open questions that remain after building: at most one, at the end of your reply.

## 4. Viewports — always settle them

1. **Derive from the project first**: breakpoints in `tailwind.config.*`, `@media`/container queries, `sm:/md:/lg:` usage, viewport meta, "mobile app"/"desktop-only" statements in AGENTS.md/CLAUDE.md. Say what you found: "Project is mobile-first with `sm 640 · md 768 · lg 1024`".
2. If they make it clear (e.g. an admin console that is desktop-only, a mobile app), use that and state it as an assumption; no question needed.
3. Otherwise **ask which viewports to show**, recommending the defaults: **Laptop 1280×800 + Phone 390×844**. Add Tablet 768×1024 when the layout changes there, Desktop 1440×900 for wide dashboards, 1080×1080 for social posts, 794×1123 for A4 print.
4. Never assume desktop-only for a product people use on phones.
5. Record the agreed viewports in `design.json`.

## 5. Open brief → offer 2–3 named directions

When the brief leaves the look open (no project system, no preset), offer 2–3 distinct directions **in the questions message**, each one line: name · idea · palette · type pairing · signature layout move. Draw from `presets/` or invent new ones, but make them truly different, not three shades of one idea. Recommend one in bold.

After the user picks, build the key screen of each chosen direction as sibling screens (`home-a`, `home-b`) only if they asked to compare; otherwise build the picked one. Never delete an alternate without asking.

## 6. First reply template

```
Found: <2–4 lines citing project files, or "no project context">.

1. <question> **<recommended default>** — <why>
2. Viewports? **Laptop 1280×800 + Phone 390×844** — <why/what the project says>
3. …

Directions (if open): **A · Name** — idea · palette · type · move  /  B · … 

Reply with changes, or say *go* to accept the defaults.
```

If the brief already settles everything, skip the questions: give an "Assumptions" list and build in the same reply.
