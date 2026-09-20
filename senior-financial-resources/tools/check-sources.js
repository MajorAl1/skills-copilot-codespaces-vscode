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
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' } });
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
// Each watcher fetches its source, returns {values} keyed by figure name (or {unreadable}), and
// `compare` pairs those values with figures parsed from content.json claim text.
const YEAR = content.meta.compileDate.slice(0, 4); // year the stated figures belong to
const G = (text, rx) => num((rx.exec(text) || [])[1]);

// medicare.gov lists each program as: "<Program name> ... Individual $INC $RES Married couple $INC $RES"
function mspProgram(t, nameRx) {
  const a = nameRx.exec(t); if (!a) return null;
  const seg = t.slice(a.index, a.index + 900);
  const m = /Individual\s*\$([\d,]+)\s*\$([\d,]+)\s*Married couple\s*\$([\d,]+)\s*\$([\d,]+)/i.exec(seg);
  return m ? { incInd: num(m[1]), resInd: num(m[2]), incCpl: num(m[3]), resCpl: num(m[4]) } : null;
}

const WATCHERS = [
  {
    id: 'msp', label: `Medicare.gov — Medicare Savings Programs, income and resource limits ${YEAR}`,
    url: 'https://www.medicare.gov/basics/costs/help/medicare-savings-programs',
    anchors: ['limits for 20', 'Individual', 'no more than \\$'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const yr = /limits for (20\d\d)/i.exec(t);
      const qmb = mspProgram(t, /Qualified Medicare Beneficiary \(QMB\)/i);
      const slmb = mspProgram(t, /Specified Low-Income Medicare Beneficiary \(SLMB\)/i);
      const qi = mspProgram(t, /Qualifying Individual \(QI\)/i);
      const copay = G(t, /no more than \$([\d.]+) in 20\d\d for each drug/i);
      if (!qmb && !slmb && !qi) return { unreadable: 'could not find the program tables (QMB/SLMB/QI)', raw: [r] };
      const v = { 'page year': yr ? Number(yr[1]) : null, 'Extra Help brand copay cap': copay };
      for (const [k, p] of [['QMB', qmb], ['SLMB', slmb], ['QI', qi]]) if (p) Object.assign(v, { [`${k} income individual`]: p.incInd, [`${k} income couple`]: p.incCpl, [`${k} resources individual`]: p.resInd, [`${k} resources couple`]: p.resCpl });
      return { values: v, raw: [r] };
    },
    compare(v) {
      const c = findClaim('entry-msp', `${YEAR} federal limits`);
      const eh = findClaim('entry-extra-help', `${YEAR} copay caps`);
      const yearNote = v['page year'] && String(v['page year']) !== YEAR ? `source page now shows ${v['page year']} limits; stated figures are for ${YEAR}` : '';
      const row = (figure, stated, live, note) => ({ figure, stated, live, claim: c, entry: 'entry-msp', note: [note, yearNote].filter(Boolean).join('; ') });
      return [
        row('QMB income individual /month', G(c.text, /QMB ~\$([\d,]+)\/month individual/), v['QMB income individual']),
        row('QMB income couple /month', G(c.text, /~\$([\d,]+)\/month couple/), v['QMB income couple']),
        row('SLMB income individual /month', G(c.text, /SLMB ~\$([\d,]+)\//), v['SLMB income individual']),
        row('SLMB income couple /month', G(c.text, /SLMB ~\$[\d,]+\/\$([\d,]+)/), v['SLMB income couple']),
        row('QI income individual /month', G(c.text, /QI ~\$([\d,]+)\//), v['QI income individual']),
        row('QI income couple /month', G(c.text, /QI ~\$[\d,]+\/\$([\d,]+)/), v['QI income couple']),
        row('QMB/SLMB resources individual', G(c.text, /resource limits: \$([\d,]+)\/individual/), v['QMB resources individual'], 'claim states one figure for QMB and SLMB; compared with the QMB row'),
        row('QMB/SLMB resources couple', G(c.text, /\$([\d,]+)\/couple for QMB and SLMB/), v['QMB resources couple'], 'compared with the QMB row'),
        row('SLMB resources individual', G(c.text, /resource limits: \$([\d,]+)\/individual/), v['SLMB resources individual'], 'same stated figure, compared with the SLMB row'),
        row('QI resources individual', G(c.text, /\$([\d,]+)\/\$[\d,]+ for QI/), v['QI resources individual']),
        row('QI resources couple', G(c.text, /\$[\d,]+\/\$([\d,]+) for QI/), v['QI resources couple']),
        { figure: 'Extra Help brand-name copay cap', stated: G(eh.text, /\$([\d.]+) per brand-name drug/), live: v['Extra Help brand copay cap'], claim: eh, entry: 'entry-extra-help', note: yearNote }
      ];
    }
  },
  {
    id: 'part-b', label: `Medicare.gov — standard Part B premium ${YEAR}`,
    url: 'https://www.medicare.gov/basics/costs/medicare-costs', anchors: ['each month', 'depending on your income'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      // Phrased as "$202.90 each month (or higher depending on your income)".
      const m = /\$(\d{2,3}\.\d{2})\s*each month\s*\(or higher depending on your income\)/i.exec(t) || /\$(\d{2,3}\.\d{2})[^$]{0,120}depending on your income/i.exec(t);
      if (!m) return { unreadable: 'could not find "$NNN.NN each month (or higher depending on your income)"', raw: [r] };
      return { values: { 'Part B standard premium': Number(m[1]) }, raw: [r] };
    },
    compare(v) {
      const c = findClaim('entry-msp', `${YEAR} Medicare Part B premium`);
      return [{ figure: 'Part B standard premium /month', stated: Number((/\$([\d.]+)\/month/.exec(c.text) || [])[1]), live: v['Part B standard premium'], claim: c, entry: 'entry-msp' }];
    }
  },
  {
    id: 'lifeline', label: 'USAC — Lifeline monthly discount',
    url: 'https://www.lifelinesupport.org/', anchors: ['monthly discount', 'Tribal Benefit'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const std = G(t, /Standard Benefit[^$]{0,200}monthly discount of up to \$(\d{1,2}\.\d{2})/i) ?? G(t, /monthly discount of up to \$(\d{1,2}\.\d{2})/i);
      const tribal = G(t, /Tribal Benefit[^$]{0,300}monthly discount of up to \$(\d{2}\.\d{2})/i);
      if (std == null) return { unreadable: 'could not find "monthly discount of up to $N.NN"', raw: [r] };
      return { values: { 'discount /month': std, 'Tribal discount /month': tribal }, raw: [r] };
    },
    compare(v) {
      const c = findClaim('entry-lifeline', 'Discount amount');
      return [
        { figure: 'Lifeline discount /month', stated: Number((/Up to \$([\d.]+)\/month/.exec(c.text) || [])[1]), live: v['discount /month'], claim: c, entry: 'entry-lifeline' },
        { figure: 'Lifeline Tribal discount /month', stated: Number((/up to \$([\d.]+)\/month on qualifying Tribal/.exec(c.text) || [])[1]), live: v['Tribal discount /month'], claim: c, entry: 'entry-lifeline' }
      ];
    }
  },
  {
    id: 'extra-help', label: `Medicare.gov — Extra Help (Part D) income and resource limits ${YEAR}`,
    url: 'https://www.medicare.gov/basics/costs/help/drug-costs', anchors: ['resource limits in 20', 'Married couple'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      // Same table layout as the MSP page: "Income and resource limits in 2026 ... Individual $INC $RES Married couple $INC $RES"
      const a = /Income and resource limits in (20\d\d)/i.exec(t);
      if (!a) return { unreadable: 'could not find "Income and resource limits in <year>"', raw: [r] };
      const m = /Individual\s*\$([\d,]+)\s*\$([\d,]+)\s*Married couple\s*\$([\d,]+)\s*\$([\d,]+)/i.exec(t.slice(a.index, a.index + 900));
      if (!m) return { unreadable: 'found the heading but not the Individual / Married couple rows', raw: [r] };
      return { values: { 'page year': Number(a[1]), 'income limit single': num(m[1]), 'resource limit single': num(m[2]), 'income limit couple': num(m[3]), 'resource limit couple': num(m[4]) }, raw: [r] };
    },
    compare(v) {
      const c = findClaim('entry-extra-help', 'People enrolled in Medicaid');
      const note = v['page year'] && String(v['page year']) !== YEAR ? `source page now shows ${v['page year']} limits` : '';
      return [
        { figure: 'Extra Help resources single', stated: G(c.text, /\$([\d,]+) \(single\)/), live: v['resource limit single'], claim: c, entry: 'entry-extra-help', note },
        { figure: 'Extra Help resources couple', stated: G(c.text, /\$([\d,]+) \(couple\)/), live: v['resource limit couple'], claim: c, entry: 'entry-extra-help', note }
      ];
    }
  },
  {
    id: 'ssi-fbr', label: `SSA — SSI federal benefit rate ${YEAR}`,
    url: 'https://www.ssa.gov/oact/cola/SSI.html', anchors: ['eligible individual', 'eligible couple', 'Federal Payment'],
    async read(fetchAll) {
      const [r] = await fetchAll([this.url]); const t = stripHTML(r.body);
      const ind = anchored(t, new RegExp(`${YEAR}[^\\d]{0,40}`), /\$?\s?([\d,]{3,6})\b/, 120) || anchored(t, /eligible individual/i, /\$\s?([\d,]{3,6})\b/, 200);
      const cpl = anchored(t, /eligible couple/i, /\$\s?([\d,]{3,6})\b/, 200);
      if (ind == null && cpl == null) return { unreadable: 'could not find the individual or couple monthly amount', raw: [r] };
      return { values: { 'individual /month': num(ind), 'couple /month': num(cpl) }, raw: [r] };
    },
    compare(v) {
      const c = findClaim('entry-ssi', `${YEAR} Federal Benefit Rate`);
      return [
        { figure: 'SSI individual /month', stated: G(c.text, /\$([\d,]+)\/month for an eligible individual/), live: v['individual /month'], claim: c, entry: 'entry-ssi' },
        { figure: 'SSI couple /month', stated: G(c.text, /\$([\d,]+)\/month for an eligible couple/), live: v['couple /month'], claim: c, entry: 'entry-ssi' }
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
    compare(v) {
      const c = findClaim('entry-social-security', `${YEAR} COLA`);
      const note = v['COLA year'] && String(v['COLA year']) !== YEAR ? `source now describes the ${v['COLA year']} COLA; the stated figure is for ${YEAR}` : '';
      return [{ figure: 'COLA percent', stated: Number((/([\d.]+) percent/.exec(c.text) || [])[1]), live: v['COLA percent'], claim: c, entry: 'entry-social-security', note }];
    }
  },
  {
    id: 'fpl', label: `HHS poverty guidelines ${YEAR} (48 states + D.C.), informational cross-check of MSP income limits`,
    url: `https://aspe.hhs.gov/topical-subjects/poverty-economic-mobility/poverty-guidelines/api/${YEAR}/us/1`,
    anchors: ['income'],
    async read(fetchAll) {
      const [p1, p2] = await fetchAll([1, 2].map((n) => `https://aspe.hhs.gov/topical-subjects/poverty-economic-mobility/poverty-guidelines/api/${YEAR}/us/${n}`));
      const parse = (r) => { try { const j = JSON.parse(r.body); return num(j.data && j.data.income != null ? j.data.income : j.income); } catch (e) { return null; } };
      const fpl1 = parse(p1), fpl2 = parse(p2);
      if (fpl1 == null || fpl2 == null) return { unreadable: 'API response did not contain data.income', raw: [p1, p2] };
      const limit = (fpl, pct) => Math.round((fpl * pct) / 12) + 20; // CMS: monthly FPL share + $20 disregard
      return { values: { 'FPL 1 person': fpl1, 'FPL 2 persons': fpl2, 'QMB individual': limit(fpl1, 1), 'QMB couple': limit(fpl2, 1) }, raw: [p1, p2] };
    },
    compare(v) {
      const c = findClaim('entry-msp', `${YEAR} federal limits`);
      return [
        { figure: 'QMB income individual (derived from FPL)', stated: G(c.text, /QMB ~\$([\d,]+)\/month individual/), live: v['QMB individual'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'FPL ÷ 12 + $20' },
        { figure: 'QMB income couple (derived from FPL)', stated: G(c.text, /~\$([\d,]+)\/month couple/), live: v['QMB couple'], tolerance: 2, claim: c, entry: 'entry-msp', note: 'FPL ÷ 12 + $20' }
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
          if (!r.ok) { const err = new Error(`HTTP ${r.status} for ${u}`); err.blocked = [401, 403, 429, 503].includes(r.status); throw err; }
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
    } catch (e) { rec.status = e.blocked ? 'blocked' : 'error'; rec.error = e.message; }
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
  const blocked = results.filter((r) => r.status === 'blocked');
  const unreadable = results.filter((r) => r.status === 'unreadable' || r.status === 'error').concat(flat.filter((c) => c.state === 'unreadable' || c.state === 'unparsed'));
  const matched = flat.filter((c) => c.state === 'match');
  const actionable = changed.length + unreadable.length + queue.length + triggers.filter((t) => t.state === 'occurred').length;
  const site = 'https://senior-financial-resources.netlify.app/';
  const L = [];
  L.push(`# Source check — ${TODAY}`);
  L.push('');
  L.push(`Facts last verified ${content.meta.compileDate} · content file updated ${content.meta.contentUpdated} · app v${content.meta.version}.`);
  L.push(`This report compares figures published at primary sources with the figures stated in \`content.json\`. Nothing has been changed. Every item below is a decision for a human.`);
  L.push('');
  L.push(`**${actionable} item${actionable === 1 ? '' : 's'} need attention** · ${changed.length} changed at source · ${unreadable.length} could not be read · ${queue.length} past review date · ${matched.length} figures match${blocked.length ? ` · ${blocked.length} source${blocked.length === 1 ? '' : 's'} refuse automated reads` : ''}.`);
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
  if (blocked.length) {
    L.push('## Sources that refuse automated reads'); L.push('');
    for (const b of blocked) L.push(`- **${b.label}**: ${b.error}. Not counted above. Check this page by eye when its figures come up for review: ${b.url}`);
    L.push('');
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
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ today: TODAY, actionable, changed, unreadable: unreadable.map((u) => u.figure || u.label), blocked: blocked.map((b) => b.label), queue, upcoming, triggers, results }, null, 2));
  console.log(`\n${actionable} actionable item(s). Report: ${path.join(OUT, 'report.md')}`);
})().catch((e) => { console.error(e); process.exit(1); });
