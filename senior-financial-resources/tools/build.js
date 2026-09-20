#!/usr/bin/env node
/* Build: validates content.json, then writes index.html (shell + embedded snapshot + app)
   and manifest.json. Run after every edit to content.json:  node tools/build.js
   Exits non-zero on any validation error so a bad data file never ships. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const errors = [];
const warn = [];
const fail = (m) => errors.push(m);

// ---------- load ----------
let content;
try { content = JSON.parse(read('content.json')); } catch (e) { console.error('content.json is not valid JSON: ' + e.message); process.exit(1); }

const APP_VERSION = content.meta && content.meta.version;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CLASSES = ['VERIFIED', 'PLAUSIBLE', 'STATE', 'SPECIFICATION'];

// ---------- collect ids ----------
const sectionIds = new Set(), entryIds = new Set(), eventIds = new Set();
for (const mk of Object.keys(content.modules || {})) {
  const mod = content.modules[mk];
  if (mod.id !== mk) fail(`module key ${mk} != id ${mod.id}`);
  for (const s of mod.sections || []) {
    if (sectionIds.has(s.id)) fail(`duplicate section id ${s.id}`);
    sectionIds.add(s.id);
    for (const e of s.entries || []) {
      if (entryIds.has(e.id)) fail(`duplicate entry id ${e.id}`);
      entryIds.add(e.id);
    }
  }
}
for (const ev of content.events || []) eventIds.add(ev.id);
const anchorExists = (a) => sectionIds.has(a) || entryIds.has(a) || eventIds.has(a) || /^module\d+$/.test(a) && content.modules[a] || /^appendix-[ab]$/.test(a);

// ---------- meta ----------
const m = content.meta || {};
for (const k of ['version', 'compileDate', 'contentUpdated', 'disclaimer', 'productName']) if (!m[k]) fail(`meta.${k} missing`);
if (m.compileDate && !ISO.test(m.compileDate)) fail('meta.compileDate not YYYY-MM-DD');
if (m.contentUpdated && !ISO.test(m.contentUpdated)) fail('meta.contentUpdated not YYYY-MM-DD');
if (m.compileDate && m.contentUpdated && m.contentUpdated < m.compileDate) fail('meta.contentUpdated is before meta.compileDate');
if (!['draft', 'published'].includes(content.publicationStatus)) fail('publicationStatus must be draft or published');

const pendingIds = new Set();
for (const p of m.pendingUpdates || []) {
  if (!p.id) fail(`pendingUpdates entry without id: ${p.trigger}`);
  if (pendingIds.has(p.id)) fail(`duplicate pendingUpdates id ${p.id}`);
  pendingIds.add(p.id);
  if (p.date !== null && p.date !== undefined && !ISO.test(p.date)) fail(`pendingUpdates ${p.id}: date must be YYYY-MM-DD or null`);
  if (p.date && !p.notice) warn.push(`pendingUpdates ${p.id} has a date but no notice text; a generic notice will show once it passes`);
  for (const a of p.affects || []) if (!anchorExists(a)) fail(`pendingUpdates ${p.id} affects unknown anchor ${a}`);
}

// ---------- freshness fields on any object ----------
function checkFresh(obj, where) {
  if (obj.asOf !== undefined && !ISO.test(obj.asOf)) fail(`${where}: asOf not YYYY-MM-DD`);
  if (obj.reviewBy !== undefined && !ISO.test(obj.reviewBy)) fail(`${where}: reviewBy not YYYY-MM-DD`);
  if (obj.asOf && obj.reviewBy && obj.reviewBy < obj.asOf) fail(`${where}: reviewBy before asOf`);
  if (obj.reviewBy && !obj.asOf) fail(`${where}: reviewBy without asOf`);
  if (obj.pending && !pendingIds.has(obj.pending)) fail(`${where}: unknown pending id ${obj.pending}`);
  if (obj.sourceUrl && !/^https:\/\//.test(obj.sourceUrl)) fail(`${where}: sourceUrl must be https`);
}
function checkClaim(c, where) {
  if (!c.text) fail(`${where}: claim without text`);
  if (c.classification && !CLASSES.includes(c.classification)) fail(`${where}: unknown classification ${c.classification}`);
  checkFresh(c, where);
}
for (const mk of Object.keys(content.modules || {})) {
  const mod = content.modules[mk];
  if (!ISO.test(mod.compileDate || '')) fail(`${mk}: compileDate not YYYY-MM-DD`);
  for (const s of mod.sections || []) {
    checkFresh(s, s.id);
    for (const a of s.seeAlso || []) if (!anchorExists(a)) fail(`${s.id} seeAlso unknown anchor ${a}`);
    for (const e of s.entries || []) {
      if (e.classification && !CLASSES.includes(e.classification)) fail(`${e.id}: unknown classification ${e.classification}`);
      checkFresh(e, e.id);
      (e.extraClaims || []).forEach((c, i) => checkClaim(c, `${e.id} claim ${i}`));
      for (const a of e.seeAlso || []) if (!anchorExists(a)) fail(`${e.id} seeAlso unknown anchor ${a}`);
    }
    if (s.middleIncomeSidebar) (s.middleIncomeSidebar.claims || []).forEach((c, i) => checkClaim(c, `${s.id} sidebar claim ${i}`));
  }
}
for (const ev of content.events || []) for (const a of ev.seeAlso || []) if (!anchorExists(a)) fail(`${ev.id} seeAlso unknown anchor ${a}`);
for (const [from, to] of Object.entries(content.anchorRedirects || {})) if (!anchorExists(to)) fail(`anchorRedirects ${from} -> unknown ${to}`);

// ---------- report ----------
for (const w of warn) console.warn('warning: ' + w);
if (errors.length) {
  for (const e of errors) console.error('error: ' + e);
  console.error(`\n${errors.length} error(s). index.html not written.`);
  process.exit(1);
}

// ---------- emit ----------
const embedded = JSON.stringify(content).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
const app = read('src/app.js').replace(/__APP_VERSION__/g, APP_VERSION);
const html = read('src/shell.html')
  .replace(/__APP_VERSION__/g, APP_VERSION)
  .replace('__EMBEDDED_CONTENT__', () => embedded)
  .replace('__APP_JS__', () => app);
fs.writeFileSync(path.join(ROOT, 'index.html'), html);

const manifest = {
  appVersion: APP_VERSION,
  contentVersion: content.meta.version,
  contentUpdated: content.meta.contentUpdated,
  factsVerified: content.meta.compileDate,
  builtAt: new Date().toISOString().slice(0, 10)
};
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Service worker cache name must change whenever the shell changes, so old shells are evicted.
const sw = read('src/service-worker.js').replace(/__CACHE_VERSION__/g, APP_VERSION + '-' + content.meta.contentUpdated);
fs.writeFileSync(path.join(ROOT, 'service-worker.js'), sw);

console.log(`built v${APP_VERSION}: index.html (${(html.length / 1024).toFixed(0)} KB), manifest.json, service-worker.js · content updated ${content.meta.contentUpdated} · facts verified ${content.meta.compileDate}`);
