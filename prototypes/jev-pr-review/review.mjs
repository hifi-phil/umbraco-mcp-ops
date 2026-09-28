#!/usr/bin/env node
// Tiered PR review with Jev (TypeSafe System One). Prototype — see README.md.
//
//   node review.mjs <pr-number> [--repo owner/name] [--out dir] [--dry-run]
//
// Needs `gh` (logged in) and, unless --dry-run, TYPESAFE_API_KEY.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIER0, TIER0_SPECULATIVE, testsCoverContract, reaskWithFile, whichGoal } from './questions.mjs';
import { planFollowups, judge } from './policy.mjs';

const MODEL = process.env.JEV_MODEL || 'jev-latest';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Jev 1.13: 32k tokens for state + longest question. Chars/3 is a conservative estimate for
// code; caps keep each request well inside that.
const CAP = { hunk: 40_000, file: 40_000, tests: 30_000, body: 6_000 };
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(png|jpe?g|gif|svg|ico|zip)$/;
const TEST = /(__tests__|\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)evals?\/)/;

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const dryRun = argv.includes('--dry-run') && argv.splice(argv.indexOf('--dry-run'), 1);
const repo = flag('--repo');
const outDir = flag('--out');
const pr = argv[0];
if (!pr) {
  console.error('usage: node review.mjs <pr-number> [--repo owner/name] [--out dir] [--dry-run]');
  process.exit(2);
}
if (!dryRun && !process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set (use --dry-run to inspect requests without calling Jev)');
  process.exit(2);
}

// ---- GitHub ----
const gh = (...args) => execFileSync('gh', [...args, ...(repo ? ['--repo', repo] : [])], { encoding: 'utf8', maxBuffer: 64 << 20 });
const meta = JSON.parse(gh('pr', 'view', pr, '--json', 'title,body,headRefOid,headRepository,headRepositoryOwner'));
const diff = gh('pr', 'diff', pr);
const headRepo = `${meta.headRepositoryOwner.login}/${meta.headRepository.name}`;

const fileCache = new Map();
function fileAfter(path) {
  if (!fileCache.has(path)) {
    let text = null;
    try {
      text = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${headRepo}/contents/${path}?ref=${meta.headRefOid}`], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      });
    } catch {
      /* deleted or unreadable file: no extra evidence */
    }
    fileCache.set(path, text && clip(text, CAP.file));
  }
  return fileCache.get(path);
}

// ---- diff parsing ----
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n[... truncated ${s.length - n} chars]` : s);

function parseHunks(text) {
  const hunks = [];
  for (const section of text.split(/^diff --git /m).slice(1)) {
    const file = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? section.match(/^--- a\/(.+)$/m)?.[1];
    if (!file || SKIP.test(file) || /^Binary files/m.test(section)) continue;
    const parts = section.split(/^(?=@@ )/m).slice(1);
    parts.forEach((d, i) => hunks.push({ id: `${file}#${i + 1}`, file, diff: clip(d.trimEnd(), CAP.hunk) }));
  }
  return hunks;
}

const hunks = parseHunks(diff);
const testHunks = [];
let testChars = 0;
for (const h of hunks.filter((h) => TEST.test(h.file))) {
  if ((testChars += h.diff.length) > CAP.tests) break;
  testHunks.push(h);
}
const bullets = (meta.body || '')
  .split('\n')
  .map((l) => l.match(/^\s*(?:[-*]|\d+[.)])\s+(.{8,})$/)?.[1]?.trim())
  .filter(Boolean)
  .slice(0, 20);
const prState = { title: meta.title, body: clip(meta.body || '', CAP.body) };

// ---- Jev ----
const log = [];
async function ask(hunkId, round, state, questions) {
  const body = { model: MODEL, state, questions };
  const entry = { hunk: hunkId, round, request: body, estTokens: Math.ceil(JSON.stringify(body).length / 3) };
  log.push(entry);
  if (dryRun) return null;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      entry.response = json;
      return json.answers;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      continue;
    }
    throw new Error(`Jev ${res.status} for ${hunkId} (${round}): ${await res.text()}`);
  }
}

async function reviewHunk(h) {
  const base = { pr: prState, hunk: { file: h.file, diff: h.diff } };
  // Round 1: Tier 0 + speculative Tier 1 over the same state, in one request.
  const a = await ask(h.id, 'tier0', base, { ...TIER0, ...TIER0_SPECULATIVE });
  if (!a) return { hunk: h.id };

  // Round 2: follow-ups that need different state, in parallel.
  const ctx = { testHunks: testHunks.filter((t) => t.id !== h.id), bullets, canFetchFile: true };
  const plan = planFollowups(a, ctx);
  const followups = {};
  await Promise.all(
    plan.map(async (p) => {
      let req;
      if (p.kind === 'tests_cover') req = testsCoverContract(base, ctx.testHunks);
      if (p.kind === 'which_goal') req = whichGoal(base, bullets);
      if (p.kind === 'reask_with_file') {
        const text = fileAfter(h.file);
        if (!text) return;
        req = reaskWithFile(base, text, p.ids);
      }
      const ans = await ask(h.id, p.kind, req.state, req.questions);
      // Re-asked Tier 0 answers replace the originals; the rest are Tier 1 answers.
      for (const [id, v] of Object.entries(ans)) (TIER0[id] ? a : followups)[id] = v;
    }),
  );

  return { hunk: h.id, file: h.file, answers: a, followups, plan: plan.map((p) => p.kind), ...judge(a, followups, ctx) };
}

// Small concurrency pool: well under the documented 1,200 requests/minute.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

const results = await pool(hunks, 6, reviewHunk);

// ---- output ----
const dir = outDir || join('out', `pr-${pr}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'run.json'), JSON.stringify({ pr, repo: repo || null, model: MODEL, dryRun: !!dryRun, log }, null, 2));

const totalTokens = log.reduce((s, e) => s + (e.response?.usage?.input_tokens ?? e.estTokens), 0);
if (dryRun) {
  console.log(`${hunks.length} hunks → ${log.length} Tier 0 requests, ~${totalTokens} input tokens (estimate).`);
  console.log(`Follow-up rounds depend on answers, so they are not planned in a dry run.`);
  console.log(`Requests written to ${join(dir, 'run.json')}`);
  process.exit(0);
}

const pct = (p) => `${Math.round(p * 100)}%`;
const lines = [`# Jev review: PR #${pr} — ${meta.title}`, '', `${hunks.length} hunks, ${log.length} requests, ${totalTokens} input tokens.`, ''];
const escalations = results.filter((r) => r.escalate);
lines.push(`## Escalate to Tier 2 (${escalations.length})`, '');
for (const r of escalations) lines.push(`- \`${r.hunk}\` — risk ${r.answers.risk.score.toFixed(2)}/3; ${r.findings.join('; ') || 'high risk'}`);
lines.push('', '## All hunks', '', '| hunk | kind | risk | matches desc | contract | follow-ups | findings | uncertain |', '|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const a = r.answers;
  lines.push(
    `| \`${r.hunk}\` | ${a.change_kind.choice} (${pct(a.change_kind.confidence)}) | ${a.risk.score.toFixed(2)} | ${pct(a.matches_description.noul)} | ${pct(a.touches_contract.noul)} | ${r.plan.join(', ') || '—'} | ${r.findings.join('; ') || '—'} | ${r.stillUncertain.join(', ') || '—'} |`,
  );
}
writeFileSync(join(dir, 'report.md'), `${lines.join('\n')}\n`);

// Tier 2 hand-off: everything Claude needs to review the escalated hunks without re-running Jev.
writeFileSync(
  join(dir, 'escalations.json'),
  JSON.stringify(
    escalations.map((r) => ({ ...r, diff: hunks.find((h) => h.id === r.hunk).diff })),
    null,
    2,
  ),
);
console.log(lines.slice(0, 4 + escalations.length + 2).join('\n'));
console.log(`\nFull report: ${join(dir, 'report.md')}  ·  Tier 2 hand-off: ${join(dir, 'escalations.json')}`);
