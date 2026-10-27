#!/usr/bin/env node
/**
 * verify-team.js — mechanical checks for a generated agent team.
 *
 * Run from the target project's root after generation (SKILL.md Step 6), and again whenever
 * the roster or a convention changes:
 *
 *   node .agents/verify-team.js            # after the skill copies it there
 *   node <skill-dir>/scripts/verify-team.js [target-root]
 *
 * Plain Node, no dependencies. Exit 1 on any FAIL. Warnings do not fail the run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || process.cwd());
let failures = 0;
let warnings = 0;

const ok = (label) => console.log(`ok   - ${label}`);
const fail = (label) => { failures++; console.log(`FAIL - ${label}`); };
const warn = (label) => { warnings++; console.log(`warn - ${label}`); };
const check = (cond, label) => (cond ? ok(label) : fail(label));

const P = (...p) => path.join(root, ...p);
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const relOf = (p) => path.relative(root, p).split(path.sep).join('/');
const mdFiles = (dir) => (exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);
const stem = (f) => f.replace(/\.md$/, '');

// ---------------------------------------------------------------- 1. required files
const protocolPath = P('.agents', 'rules', 'claude-agent-protocol.md');
check(exists(P('AGENTS.md')), 'AGENTS.md exists');
if (exists(P('AGENTS.md'))) check(/^# /.test(read(P('AGENTS.md')).trimStart()), 'AGENTS.md starts with its heading (no template prose or CLAUDE.md snippet above it)');
check(exists(protocolPath), '.agents/rules/claude-agent-protocol.md exists');
check(exists(P('documentation', 'README.md')), 'documentation/README.md exists');

const ccDir = P('.claude', 'agents');
const ocDir = P('.opencode', 'agents');
const ocLegacyDir = P('.opencode', 'agent');
const ocConfigPath = [P('opencode.json'), P('.opencode', 'opencode.json')].find((p) => fs.existsSync(p)) || P('opencode.json');
const neutralDir = P('.agents', 'agents');
const hasCC = exists(ccDir);
const hasOC = exists(ocDir);
const hasNeutral = exists(neutralDir);
check(hasCC || hasOC || hasNeutral, 'at least one agent directory exists (.claude/agents, .opencode/agents, .agents/agents)');
check(!exists(ocLegacyDir), 'no legacy OpenCode 1 directory (.opencode/agent/ — OpenCode 2 reads .opencode/agents/)');

if (hasCC) {
  check(exists(P('CLAUDE.md')), 'CLAUDE.md exists (Claude Code harness)');
  if (exists(P('CLAUDE.md'))) {
    const c = read(P('CLAUDE.md'));
    check(/@AGENTS\.md/.test(c) && /@\.agents\/rules\/claude-agent-protocol\.md/.test(c), 'CLAUDE.md imports AGENTS.md and the protocol');
  }
  check(exists(P('.claude', 'settings.json')), '.claude/settings.json exists (permission tier for Claude Code)');
}
if (hasOC) check(exists(ocConfigPath), 'opencode.json exists (permission tier for OpenCode 2)');
for (const d of [ccDir, ocDir, neutralDir]) {
  if (exists(d)) check(!exists(path.join(d, 'project-manager.md')), `no ${relOf(d)}/project-manager.md (the main agent leads; there is no PM file)`);
}

// ---------------------------------------------------------------- 2. placeholders
// Unfilled generator placeholders are ALL-CAPS tokens in braces. Fenced code blocks are
// skipped (roles copy output templates from them); {ROLE} is the protocol's generic token;
// lowercase {var} is i18n syntax.
const PLACEHOLDER = /\{[A-Z][A-Z0-9_]+(?:[\s,—–-][^}]*)?\}/g;
const ALLOWED = new Set(['{ROLE}']);

function findPlaceholders(text) {
  const hits = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    for (const m of line.match(PLACEHOLDER) || []) {
      if (!ALLOWED.has(m)) hits.push(`${i + 1}: ${m}`);
    }
  });
  return hits;
}

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(md|json|mdc)$/.test(e.name)) out.push(p);
  }
  return out;
}

const generated = [
  P('AGENTS.md'), P('CLAUDE.md'), P('GEMINI.md'), protocolPath, P('.claude', 'settings.json'), ocConfigPath,
  ...walk(ccDir), ...walk(ocDir), ...walk(neutralDir), ...walk(P('documentation')),
  ...walk(P('.opencode', 'commands')),
].filter(exists);

for (const f of generated) {
  const hits = findPlaceholders(read(f));
  check(hits.length === 0, `${relOf(f)}: no unfilled placeholders${hits.length ? ` (${hits.slice(0, 3).join('; ')}${hits.length > 3 ? '; …' : ''})` : ''}`);
}

// ---------------------------------------------------------------- 3. frontmatter helpers
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}
function fmValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------- 4. roster vs files
const agentsMd = exists(P('AGENTS.md')) ? read(P('AGENTS.md')) : '';
const rosterNames = new Set();
{
  // Only the Agent team section: later tables (roles, business rules) are not roster rows.
  const section = (agentsMd.split(/^## Agent team/m)[1] || '').split(/^## /m)[0];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*([a-z][a-z0-9-]*)(?:\s*\([^)]*\))?\s*\|/);
    if (m) rosterNames.add(m[1]);
  }
  check(rosterNames.size > 0, `AGENTS.md roster table parsed (${[...rosterNames].join(', ') || 'none'})`);
}

const cc = new Set(mdFiles(ccDir).map(stem));
const oc = new Set(mdFiles(ocDir).map(stem));
const neutral = new Set(mdFiles(neutralDir).map(stem));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));
const rosterCheck = (set, label) => check(same(set, rosterNames), `${label} == AGENTS.md roster${same(set, rosterNames) ? '' : ` (extra: ${diff(set, rosterNames).join(',') || '-'}; missing: ${diff(rosterNames, set).join(',') || '-'})`}`);

check(!rosterNames.has('project-manager'), 'roster has no project-manager row (the main agent is not a file)');
if (hasCC) rosterCheck(cc, '.claude/agents');
if (hasOC) rosterCheck(oc, '.opencode/agents');
if (hasNeutral) rosterCheck(neutral, '.agents/agents');
if (hasCC && hasOC) check(same(cc, oc), 'CC roster == OC roster');

// ---------------------------------------------------------------- 5. per-agent file shape
function checkAgentFile(file, kind) {
  const text = read(file);
  const rel = relOf(file);
  const fm = frontmatter(text);
  if (kind !== 'neutral') check(fm.length > 0, `${rel}: has frontmatter`);
  if (kind === 'cc') {
    check(fmValue(fm, 'name') === stem(path.basename(file)), `${rel}: frontmatter name matches filename`);
    check(fmValue(fm, 'tools') === null, `${rel}: no tools: line (agents inherit every tool)`);
  }
  check(/^## Handoff/m.test(text), `${rel}: has a Handoff section`);
  check(/^## Scope/m.test(text), `${rel}: has a Scope & focus section`);
  check(!/→ project-manager/.test(text), `${rel}: hands off to the main agent, not a project-manager`);
  return { text, fm, rel };
}

for (const f of mdFiles(ccDir)) checkAgentFile(path.join(ccDir, f), 'cc');
for (const f of mdFiles(neutralDir)) checkAgentFile(path.join(neutralDir, f), 'neutral');

const ocFiles = mdFiles(ocDir).map((f) => ({ name: stem(f), ...checkAgentFile(path.join(ocDir, f), 'oc') }));

// ---------------------------------------------------------------- 6. OpenCode 2 specifics
const readJson = (p) => { try { return JSON.parse(read(p)); } catch (e) { return null; } };
if (hasOC) {
  for (const a of ocFiles) {
    check(fmValue(a.fm, 'mode') === 'subagent', `${a.rel}: mode: subagent`);
    const model = fmValue(a.fm, 'model');
    // Unpinned is allowed: the model is chosen when the agent is started.
    check(model === null || /^[\w.-]+\/[\w.:\/-]+(#[\w.-]+)?$/.test(model), `${a.rel}: model, when pinned, is provider/model with an optional #variant (${model || 'unpinned'})`);
    const v1 = ['permission', 'tools', 'temperature', 'name', 'maxSteps', 'options'].filter((k) => new RegExp(`^${k}:`, 'm').test(a.fm));
    check(v1.length === 0, `${a.rel}: no OpenCode 1 frontmatter keys${v1.length ? ` (found: ${v1.join(', ')})` : ''}`);
    check(!/^permissions:/m.test(a.fm), `${a.rel}: no per-agent permissions list (one policy, in opencode.json)`);
  }

  const config = exists(ocConfigPath) ? readJson(ocConfigPath) : null;
  const rules = config && Array.isArray(config.permissions) ? config.permissions : null;
  if (exists(ocConfigPath)) {
    check(config !== null, 'opencode.json is valid JSON (no comments)');
    check(!(config && config.permission), 'opencode.json has no OpenCode 1 "permission" map');
    check(rules !== null, 'opencode.json has a "permissions" rule list');
  }
  if (rules) {
    const wellFormed = rules.every((r) => r && typeof r.action === 'string' && typeof r.resource === 'string' && ['allow', 'ask', 'deny'].includes(r.effect));
    check(wellFormed, 'every permission rule is { action, resource, effect: allow|ask|deny }');
    const legacy = rules.filter((r) => r && ['bash', 'task'].includes(r.action)).map((r) => r.action);
    check(legacy.length === 0, `permission rules use OpenCode 2 action names (shell, subagent)${legacy.length ? ` — found ${[...new Set(legacy)].join(', ')}` : ''}`);
    const first = rules[0] || {};
    check(first.action === '*' && first.resource === '*' && first.effect === 'allow', 'first permission rule is the allow-all default (edits stay open for every agent)');
    const lastAskIdx = rules.map((r) => r.effect === 'ask').lastIndexOf(true);
    const firstDenyIdx = rules.findIndex((r) => r.effect === 'deny');
    check(firstDenyIdx === -1 || lastAskIdx === -1 || firstDenyIdx > lastAskIdx, 'permission rules: deny rules come after ask rules (OpenCode: last match wins)');
    const editDeny = rules.some((r) => r.action === 'edit' && r.effect === 'deny');
    check(!editDeny, 'no edit deny rule (edit access is open; lanes are held by each agent\'s Scope & focus)');
    const autonomous = rules.every((r) => r.effect === 'allow');
    if (autonomous) warn('Autonomous tier: nothing is blocked mechanically — protocol §6 (user-gated actions) is the guard; the hand-over must say so');

    // Claude Code settings carry the same shell denies, if CC is also generated.
    if (hasCC && exists(P('.claude', 'settings.json'))) {
      const settings = readJson(P('.claude', 'settings.json'));
      check(settings && settings.permissions, '.claude/settings.json is valid JSON with a permissions key');
      if (settings && settings.permissions) {
        const allow = settings.permissions.allow || [];
        check(allow.includes('Edit') || allow.includes('Edit(**)'), '.claude/settings.json allows Edit (edit access is open)');
        // Compare shapes, not spacing: `git push * --force*` and `Bash(git push * --force *)`
        // both normalise to `gitpush--force`.
        const norm = (x) => x.replace(/^Bash\((.*)\)$/, '$1').replace(/[\s*]/g, '');
        const ccDeny = (settings.permissions.deny || []).map(norm);
        const ocDenies = rules.filter((r) => r.action === 'shell' && r.effect === 'deny').map((r) => r.resource);
        const missing = ocDenies.filter((d) => !ccDeny.some((c) => c === norm(d)));
        check(missing.length === 0, `.claude/settings.json deny covers every OpenCode shell deny${missing.length ? ` (missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})` : ''}`);
      }
    }
  }
} else if (hasCC && exists(P('.claude', 'settings.json'))) {
  const settings = readJson(P('.claude', 'settings.json'));
  check(settings && settings.permissions, '.claude/settings.json is valid JSON with a permissions key');
}

// ---------------------------------------------------------------- 6b. behavioural guard present
// With open permissions the user-gated list is the guard, so it must exist where agents read it.
if (exists(protocolPath)) {
  const proto = read(protocolPath);
  check(/^## 6\. Autonomy & User-Gated Actions/m.test(proto), 'protocol has §6 Autonomy & User-Gated Actions');
  check(/senior ladder/i.test(proto), 'protocol embeds the senior ladder');
}
check(/^## How we work/m.test(agentsMd) && /user-gated/i.test(agentsMd), 'AGENTS.md has "How we work" with the user-gated rule');
for (const a of [...mdFiles(ccDir).map((f) => path.join(ccDir, f)), ...mdFiles(ocDir).map((f) => path.join(ocDir, f)), ...mdFiles(neutralDir).map((f) => path.join(neutralDir, f))]) {
  check(/user-gated/i.test(read(a)), `${relOf(a)}: states the user-gated rule`);
}

// ---------------------------------------------------------------- 7. gate commands exist
const gateTexts = [agentsMd, exists(protocolPath) ? read(protocolPath) : '',
  ...[ccDir, ocDir, neutralDir].flatMap((d) => mdFiles(d).map((f) => read(path.join(d, f))))];
const quoted = (re) => { const out = new Set(); for (const t of gateTexts) for (const m of t.matchAll(re)) out.add(m[1]); return [...out]; };
const npmScripts = quoted(/npm run ([\w:.-]+)/g);
const makeTargets = quoted(/`make ([\w.-]+)`/g);
const marker = /verify\s+scripts\s+exist\s+after\s+first\s+scaffold/.test(agentsMd);
if (exists(P('package.json'))) {
  let scripts = {};
  try { scripts = JSON.parse(read(P('package.json'))).scripts || {}; } catch (e) { scripts = {}; }
  const missing = npmScripts.filter((x) => !scripts[x]);
  check(missing.length === 0, `every "npm run <script>" quoted as a gate exists in package.json${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  if (marker) warn('AGENTS.md still carries "verify scripts exist after first scaffold" although package.json exists — remove the marker');
} else if (npmScripts.length && !marker) {
  warn('no package.json — gate commands could not be verified; AGENTS.md should carry "⚠️ verify scripts exist after first scaffold"');
}
if (makeTargets.length) {
  if (exists(P('Makefile'))) {
    const mk = read(P('Makefile'));
    const missing = makeTargets.filter((t) => !new RegExp(`^${t.replace(/[.]/g, '\\.')}\\s*:`, 'm').test(mk));
    check(missing.length === 0, `every \`make <target>\` quoted as a gate exists in the Makefile${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  } else if (!marker) {
    warn('no Makefile — `make` gates could not be verified; AGENTS.md should carry "⚠️ verify scripts exist after first scaffold"');
  }
}

// ---------------------------------------------------------------- 8. docs seeded
if (rosterNames.has('code-reviewer')) check(exists(P('documentation', 'known-issues.md')), 'documentation/known-issues.md exists (code-reviewer logs minor issues there)');
for (const d of ['pages', 'features']) {
  const dir = P('documentation', d);
  check(exists(dir) && fs.readdirSync(dir).length > 0, `documentation/${d}/ exists and is tracked (.gitkeep or a doc)`);
}
if (exists(protocolPath)) check(/documentation\//.test(read(protocolPath)), 'protocol references documentation/');

// ---------------------------------------------------------------- summary
console.log(`\n${failures === 0 ? 'verify-team: all checks passed' : `verify-team: ${failures} check(s) FAILED`}${warnings ? ` (${warnings} warning(s))` : ''}`);
process.exit(failures === 0 ? 0 : 1);
