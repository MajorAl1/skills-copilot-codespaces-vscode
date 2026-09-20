#!/usr/bin/env node
/* Scheduled source check for Senior Financial Resources.
   Fetches machine-readable primary sources, extracts the figures they publish, and compares them
   with the figures stated in content.json. It never edits content.json: the output is a report
   for a human to act on ("AI assists. You decide. Trust but verify.").

   Usage:  node tools/check-sources.js [--out DIR] [--debug] [--today YYYY-MM-DD]
   Writes DIR/report.md and DIR/result.json (default DIR = ./source-check).
   --debug prints, for every source, the text around each anchor word so extractors can be tuned
   from a CI log when the page shape changes. */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; };
const OUT = path.resolve(opt('--out', 'source-check'));
const DEBUG = args.includes('--debug');
const TODAY = opt('--today', new Date().toISOString().slice(0, 10));
const ROOT = path.resolve(__dirname, '..');
const content = JSON.parse(fs.readFileSync(path.join(ROOT, 'content.json'), 'utf8'));

// ---------- helpers ----------
function findEntry(id) {
  for (const mk of Object.keys(content.modules)) for (const s of content.modules[mk].sections) for (const e of s.entries || []) if (e.id === id) return e;
  throw new Error('no entry ' + id);
}
function findClaim(entryId, startsWith) {
  const c = (findEntry(entryId).extraClaims || []).find((x) => x.text.startsWith(startsWith));
  if (!c) throw new Error(`no claim in ${entryId} starting "${startsWith}"`);
  return c;
}
const num = (s) => (s == null ? null : Number(String(s).replace(/[$,\s]/g, '')));
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }));
function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;/g, '$')
    .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}
function contextSnippets(text, word, width = 160, max = 4) {
  const out = []; const rx = new RegExp(word, 'gi'); let m;
  while ((m = rx.exec(text)) && out.length < max) out.push(text.slice(Math.max(0, m.index - width), m.index + width).replace(/\s+/g, ' '));
  return out;
}
async function fetchText(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; SeniorFinancialResources-source-check/1.0; +https://senior-financial-resources.netlify.app)', accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } finally { clearTimeout(t); }
}
// Find the first number matching `rx` inside a window of text that follows an anchor phrase.
// Returns null when the anchor is missing, so a redesigned page reads as "unreadable", never as a wrong figure.
function anchored(text, anchorRx, valueRx, window = 400) {
  const a = anchorRx.exec(text); if (!a) return null;
  const seg = text.slice(a.index, a.index + window);
  const v = valueRx.exec(seg); return v ? v[1] : null;
}

// ---------- watchers ----------
// Each watcher: fetch its source, return {values} keyed by figure name, and a list of comparisons
// against content.json. `stated` reads the figure from the claim text; `live` computes the source's figure.
const YEAR = content.meta.compileDate.slice(0, 4); // year the stated figures belong to
const WATCHERS = [
  {
    id: 'fpl', label: `HHS poverty guidelines ${YEAR} (48 states + D.C.) → Medicare Savings Program income limits`,
    url: `https://aspe.hhs.gov/topical-subjects/poverty-economic-mobility/poverty-guidelines/api/${YEAR}/us/1`,
    urls: (y) => [1, 2].map((n) => `https://aspe.hhs.gov/topical-subjects/poverty-economic-mobility/poverty-guidelines/api/${y}/us/${n}`),
    anchors: ['income', 'household_size'],
    async read(fetchAll) {
      const [p1, p2] = await fetchAll(this.urls(YEAR));
      const parse = (r) => { try { const j = JSON.parse(r.body); return num(j.data && j.data.income != null ? j.data.income : (j.income != null ? j.income : null)); } catch (e) { return null; } };
      const fpl1 = parse(p1), fpl2 = parse(p2);
      if (fpl1 == null || fpl2 == null) return { unreadable: 'API response did not contain data.income', raw: [p1, p2] };
      // CMS formula: monthly FPL percentage + $20 general income disregard, rounded to whole dollars.
      const limit = (fpl, pct) => Math.round((fpl * pct) / 12) + 20;
      return { values: { 'FPL 1 person': fpl1, 'FPL 2 persons': fpl2,
        'QMB individual': limit(fpl1, 1.0), 'QMB couple': limit(fpl2, 1.0),
        'SLMB individual': limit(fpl1, 1.2), 'SLMB couple': limit(fpl2, 1.2),
        'QI individual': limit(fpl1, 1.35), 'QI couple': limit(fpl2, 1.35) }, raw: [p1, p2] };
    },
    compare(values) {
      const c = findClaim('entry-msp', `${YEAR} federal limits`);
      const g = (rx) => num((rx.exec(c.text) || [])[1]);
      return [
        { figure: 'QMB individual /month', stated: g(/QMB ~\$([\d,]+)\/month individual/), live: values['QMB individual'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'derived: FPL ÷ 12 + $20 disregard' },
        { figure: 'QMB couple /month', stated: g(/~\$([\d,]+)\/month couple/), live: values['QMB couple'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'derived' },
        { figure: 'SLMB individual /month', stated: g(/SLMB ~\$([\d,]+)\//), live: values['SLMB individual'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'derived (120% FPL)' },
        { figure: 'SLMB couple /month', stated: g(/SLMB ~\$[\d,]+\/\$([\d,]+)/), live: values['SLMB couple'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'derived (120% FPL)' },
        { figure: 'QI individual /month', stated: g(/QI ~\$([\d,]+)\//), live: values['QI individual'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'derived (135% FPL)' },
        { figure: 'QI couple /month', stated: g(/QI ~\$[\d,]+\/\$([\d,]+)/), live: values['QI couple'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'derived (135% FPL)' }
      ];
    }
  },
  {
    id: 'ssi-fbr', label: `SSA — SSI federal benefit rate ${YEAR}`,
    url: 'https://www.ssa.gov/oact/cola/SSI.html', anchors: ['eligible individual', 'eligible couple', 'Federal Payment'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      // The page tabulates monthly amounts by year; find the row for our year first, then the amounts.
      const ind = anchored(t, new RegExp(`${YEAR}[^\\d]{0,40}`), /\$?\s?([\d,]{3,6})\b/, 120) || anchored(t, /eligible individual/i, /\$\s?([\d,]{3,6})\b/, 200);
      const cpl = anchored(t, /eligible couple/i, /\$\s?([\d,]{3,6})\b/, 200);
      if (ind == null && cpl == null) return { unreadable: 'could not find the individual or couple monthly amount', raw: [r] };
      return { values: { 'individual /month': num(ind), 'couple /month': num(cpl) }, raw: [r] };
    },
    compare(values) {
      const c = findClaim('entry-ssi', `${YEAR} Federal Benefit Rate`);
      return [
        { figure: 'SSI individual /month', stated: num((/\$([\d,]+)\/month for an eligible individual/.exec(c.text) || [])[1]), live: values['individual /month'], claim: c, entry: 'entry-ssi' },
        { figure: 'SSI couple /month', stated: num((/\$([\d,]+)\/month for an eligible couple/.exec(c.text) || [])[1]), live: values['couple /month'], claim: c, entry: 'entry-ssi' }
      ];
    }
  },
  {
    id: 'cola', label: 'SSA — latest cost-of-living adjustment',
    url: 'https://www.ssa.gov/oact/cola/latestCOLA.html', anchors: ['percent', 'COLA'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const m = /([\d.]+)\s*(?:percent|%)\s*(?:COLA|cost-of-living|benefit increase)/i.exec(t) || /(?:COLA|cost-of-living adjustment)[^.]{0,120}?([\d.]+)\s*(?:percent|%)/i.exec(t);
      const yr = /(?:for|beginning|in)\s+(?:January\s+)?(20\d\d)/i.exec(t);
      if (!m) return { unreadable: 'could not find a percentage next to "COLA"', raw: [r] };
      return { values: { 'COLA percent': Number(m[1]), 'COLA year': yr ? Number(yr[1]) : null }, raw: [r] };
    },
    compare(values) {
      const c = findClaim('entry-social-security', `${YEAR} COLA`);
      const stated = Number((/([\d.]+) percent/.exec(c.text) || [])[1]);
      const note = values['COLA year'] && String(values['COLA year']) !== YEAR ? `source now describes the ${values['COLA year']} COLA; the stated figure is for ${YEAR}` : '';
      return [{ figure: 'COLA percent', stated, live: values['COLA percent'], claim: c, entry: 'entry-social-security', note }];
    }
  },
  {
    id: 'part-b', label: `Medicare — standard Part B premium ${YEAR}`,
    url: 'https://www.medicare.gov/basics/costs/medicare-costs', anchors: ['Part B premium', 'standard'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const v = anchored(t, /standard (?:monthly )?(?:Part B )?premium/i, /\$(\d{2,3}\.\d{2})/, 300) || anchored(t, /Part B premium/i, /\$(\d{2,3}\.\d{2})/, 400);
      if (v == null) return { unreadable: 'could not find a $NNN.NN amount near "Part B premium"', raw: [r] };
      return { values: { 'Part B standard premium': Number(v) }, raw: [r] };
    },
    compare(values) {
      const c = findClaim('entry-msp', `${YEAR} Medicare Part B premium`);
      return [{ figure: 'Part B standard premium /month', stated: Number((/\$([\d.]+)\/month/.exec(c.text) || [])[1]), live: values['Part B standard premium'], claim: c, entry: 'entry-msp' }];
    }
  },
  {
    id: 'msp-resources', label: `Medicare — Medicare Savings Program resource limits`,
    url: 'https://www.medicare.gov/basics/costs/help/medicare-savings-programs', anchors: ['resource limit', 'Individual', 'Married couple'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      // The page lists income and resource limits per program; capture the first individual/couple pair after "resource".
      const ind = anchored(t, /resource limit/i, /Individual[^$]{0,40}\$([\d,]+)/i, 600);
      const cpl = anchored(t, /resource limit/i, /(?:Married )?couple[^$]{0,40}\$([\d,]+)/i, 600);
      if (ind == null && cpl == null) return { unreadable: 'could not find individual/couple amounts after "resource limit"', raw: [r] };
      return { values: { 'QMB/SLMB resource individual': num(ind), 'QMB/SLMB resource couple': num(cpl) }, raw: [r] };
    },
    compare(values) {
      const c = findClaim('entry-msp', `${YEAR} federal limits`);
      return [
        { figure: 'MSP resource limit individual', stated: num((/resource limits: \$([\d,]+)\/individual/.exec(c.text) || [])[1]), live: values['QMB/SLMB resource individual'], claim: c, entry: 'entry-msp' },
        { figure: 'MSP resource limit couple', stated: num((/\$([\d,]+)\/couple for QMB and SLMB/.exec(c.text) || [])[1]), live: values['QMB/SLMB resource couple'], claim: c, entry: 'entry-msp' }
      ];
    }
  },
  {
    id: 'extra-help', label: 'SSA — Extra Help (Part D low-income subsidy) resource limits',
    url: 'https://www.ssa.gov/medicare/part-d-extra-help', anchors: ['resources', 'married', 'single'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const amounts = []; const rx = /\$([\d,]{5,7})/g; let m;
      const seg = (() => { const a = /resources?[^.]{0,200}?(?:must|limited|less than|up to|below)/i.exec(t); return a ? t.slice(a.index, a.index + 500) : t; })();
      while ((m = rx.exec(seg)) && amounts.length < 4) amounts.push(num(m[1]));
      if (amounts.length < 2) return { unreadable: 'could not find two resource amounts near "resources"', raw: [r] };
      const sorted = [...new Set(amounts)].sort((a, b) => a - b);
      return { values: { 'resource limit single': sorted[0], 'resource limit couple': sorted[sorted.length - 1] }, raw: [r] };
    },
    compare(values) {
      const c = findClaim('entry-extra-help', 'People enrolled in Medicaid');
      return [
        { figure: 'Extra Help resources single', stated: num((/\$([\d,]+) \(single\)/.exec(c.text) || [])[1]), live: values['resource limit single'], claim: c, entry: 'entry-extra-help' },
        { figure: 'Extra Help resources couple', stated: num((/\$([\d,]+) \(couple\)/.exec(c.text) || [])[1]), live: values['resource limit couple'], claim: c, entry: 'entry-extra-help' }
      ];
    }
  },
  {
    id: 'lifeline', label: 'USAC — Lifeline monthly discount',
    url: 'https://www.lifelinesupport.org/', anchors: ['\\$9', 'per month', 'Tribal'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const std = (/\$(\d{1,2}\.\d{2})\s*(?:per month|\/month|a month|monthly)/i.exec(t) || [])[1];
      const tribal = anchored(t, /Tribal/i, /\$(\d{2}\.\d{2})/, 300);
      if (std == null) return { unreadable: 'could not find a $N.NN per-month amount', raw: [r] };
      return { values: { 'discount /month': Number(std), 'Tribal discount /month': tribal == null ? null : Number(tribal) }, raw: [r] };
    },
    compare(values) {
      const c = findClaim('entry-lifeline', 'Discount amount');
      return [
        { figure: 'Lifeline discount /month', stated: Number((/Up to \$([\d.]+)\/month/.exec(c.text) || [])[1]), live: values['discount /month'], claim: c, entry: 'entry-lifeline' },
        { figure: 'Lifeline Tribal discount /month', stated: Number((/up to \$([\d.]+)\/month on qualifying Tribal/.exec(c.text) || [])[1]), live: values['Tribal discount /month'], claim: c, entry: 'entry-lifeline' }
      ];
    }
  }
];

// ---------- run ----------
(async () => {
  fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });
  const results = [];
  for (const w of WATCHERS) {
    const rec = { id: w.id, label: w.label, url: w.url, status: 'ok', comparisons: [], values: null, error: null };
    try {
      const fetchAll = async (urls) => {
        const out = [];
        for (const u of urls) {
          const r = await fetchText(u);
          const fname = u.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.]+/g, '_').slice(0, 120);
          fs.writeFileSync(path.join(OUT, 'pages', fname + (r.body.trim().startsWith('{') ? '.json' : '.html')), r.body);
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
          out.push(r);
        }
        return out;
      };
      const res = await w.read(fetchAll);
      if (DEBUG) {
        for (const r of res.raw || []) {
          const t = r.body.trim().startsWith('{') ? r.body.slice(0, 600) : stripHTML(r.body);
          console.log(`\n### ${w.id} — ${t.length} chars of text`);
          for (const a of w.anchors || []) for (const s of contextSnippets(t, a)) console.log(`  [${a}] …${s}…`);
        }
      }
      if (res.unreadable) { rec.status = 'unreadable'; rec.error = res.unreadable; }
      else {
        rec.values = res.values;
        for (const cmp of w.compare(res.values)) {
          const tol = cmp.tolerance || 0;
          let state;
          if (cmp.live == null) state = 'unreadable';
          else if (cmp.stated == null || Number.isNaN(cmp.stated)) state = 'unparsed';
          else state = Math.abs(cmp.live - cmp.stated) <= tol ? 'match' : 'changed';
          rec.comparisons.push({ figure: cmp.figure, stated: cmp.stated, live: cmp.live, state, entry: cmp.entry, asOf: cmp.claim.asOf, reviewBy: cmp.claim.reviewBy, note: cmp.note || '' });
        }
      }
    } catch (e) { rec.status = 'error'; rec.error = e.message; }
    results.push(rec);
    console.log(`${w.id}: ${rec.status}${rec.error ? ' — ' + rec.error : ''}` + rec.comparisons.map((c) => `\n   ${c.state.toUpperCase().padEnd(10)} ${c.figure}: stated ${money(c.stated)} · source ${money(c.live)}`).join(''));
  }

  // ---------- review queue and triggers from content.json ----------
  const queue = [], upcoming = [];
  const look = (obj, where, anchor) => {
    if (!obj.reviewBy) return;
    const days = Math.round((new Date(obj.reviewBy) - new Date(TODAY)) / 86400000);
    if (obj.reviewBy < TODAY) queue.push({ where, anchor, reviewBy: obj.reviewBy, days: -days });
    else if (days <= 45) upcoming.push({ where, anchor, reviewBy: obj.reviewBy, days });
  };
  for (const mk of Object.keys(content.modules)) for (const s of content.modules[mk].sections) {
    look(s, `Module ${content.modules[mk].number} §${s.number} ${s.title}`, s.id);
    for (const e of s.entries || []) { look(e, e.name, e.id); (e.extraClaims || []).forEach((c) => look(c, `${e.name}: ${c.text.slice(0, 70)}…`, e.id)); }
  }
  const triggers = (content.meta.pendingUpdates || []).map((p) => ({ id: p.id, trigger: p.trigger, date: p.date, state: p.date ? (p.date <= TODAY ? 'occurred' : 'scheduled') : 'watching', affects: p.affects }));

  // ---------- report ----------
  const flat = results.flatMap((r) => r.comparisons.map((c) => ({ ...c, watcher: r.id, url: r.url })));
  const changed = flat.filter((c) => c.state === 'changed');
  const unreadable = results.filter((r) => r.status !== 'ok').concat(flat.filter((c) => c.state === 'unreadable' || c.state === 'unparsed'));
  const matched = flat.filter((c) => c.state === 'match');
  const actionable = changed.length + unreadable.length + queue.length + triggers.filter((t) => t.state === 'occurred').length;
  const site = 'https://senior-financial-resources.netlify.app/';
  const L = [];
  L.push(`# Source check — ${TODAY}`);
  L.push('');
  L.push(`Facts last verified ${content.meta.compileDate} · content file updated ${content.meta.contentUpdated} · app v${content.meta.version}.`);
  L.push(`This report compares figures published at primary sources with the figures stated in \`content.json\`. Nothing has been changed. Every item below is a decision for a human.`);
  L.push('');
  L.push(`**${actionable} item${actionable === 1 ? '' : 's'} need attention** · ${changed.length} changed at source · ${unreadable.length} could not be read · ${queue.length} past review date · ${matched.length} figures match.`);
  L.push('');
  if (changed.length) {
    L.push('## Changed at the source'); L.push(''); L.push('| Figure | Stated in content.json | Published at source | Entry | Source |'); L.push('|---|---|---|---|---|');
    for (const c of changed) L.push(`| ${c.figure} | ${money(c.stated)} (as of ${c.asOf || '?'}) | **${money(c.live)}** ${c.note ? `_(${c.note})_` : ''} | [${c.entry}](${site}#${c.entry}) | [link](${c.url}) |`);
    L.push(''); L.push('Confirm the source figure by eye, then edit the claim text in `content.json`, set its `asOf` and `reviewBy`, bump `meta.contentUpdated`, and merge.'); L.push('');
  }
  if (unreadable.length) {
    L.push('## Could not be read automatically'); L.push('');
    for (const u of unreadable) L.push(u.figure ? `- **${u.figure}** (${u.watcher}): ${u.state === 'unparsed' ? 'the stated figure could not be parsed from the claim text' : 'the source did not yield this figure'} — check by eye: ${u.url}` : `- **${u.label}**: ${u.error} — check by eye: ${u.url}`);
    L.push(''); L.push('A page redesign usually causes this. The check refuses to guess; verify the figure manually and, if the page moved, update the extractor in `tools/check-sources.js`.'); L.push('');
  }
  if (queue.length) {
    L.push('## Past review date (flagged REVIEW DUE on the site)'); L.push('');
    for (const q of queue.sort((a, b) => b.days - a.days)) L.push(`- ${q.where} — review was due ${q.reviewBy}, ${q.days} day${q.days === 1 ? '' : 's'} ago · [open](${site}#${q.anchor})`);
    L.push('');
  }
  if (upcoming.length) {
    L.push('## Review due within 45 days'); L.push('');
    for (const q of upcoming.sort((a, b) => a.days - b.days)) L.push(`- ${q.where} — due ${q.reviewBy}, in ${q.days} day${q.days === 1 ? '' : 's'}`);
    L.push('');
  }
  L.push('## Scheduled changes'); L.push('');
  for (const t of triggers) L.push(`- ${t.state === 'occurred' ? '**OCCURRED**' : t.state === 'scheduled' ? 'scheduled' : 'watching'} · ${t.trigger}${t.date ? ` (${t.date})` : ''} → ${t.affects.join(', ')}`);
  L.push('');
  if (matched.length) {
    L.push('## Matching figures'); L.push(''); L.push('| Figure | Value | Entry |'); L.push('|---|---|---|');
    for (const c of matched) L.push(`| ${c.figure} | ${money(c.live)} ${c.note ? `_(${c.note})_` : ''} | ${c.entry} |`);
    L.push('');
  }
  L.push('---'); L.push('_Generated by `tools/check-sources.js`. Sources fetched are saved as a workflow artifact for inspection._');
  const report = L.join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), report);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ today: TODAY, actionable, changed, unreadable: unreadable.map((u) => u.figure || u.label), queue, upcoming, triggers, results }, null, 2));
  console.log(`\n${actionable} actionable item(s). Report: ${path.join(OUT, 'report.md')}`);
})().catch((e) => { console.error(e); process.exit(1); });
