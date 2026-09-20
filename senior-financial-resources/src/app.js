/* === RENDERING LOGIC === */
/* Senior Financial Resources web app · v1.6
   Renderer reads CONTENT, which is loaded at startup from content.json (live)
   or from the embedded snapshot in index.html (offline / file:// fallback),
   whichever is newer. No external dependencies. No tracking. No analytics. */

(function () {
  'use strict';

  var APP_VERSION = '__APP_VERSION__';
  var CONTENT = null;            // set by loadContent()
  var CONTENT_SOURCE = 'embedded';
  var PUBLICATION_STATUS = 'published';
  var ANCHOR_REDIRECTS = {};
  var VERSION_HISTORY = [];
  var PENDING_BY_ID = {};

  // ---------- Content loading ----------
  function parseEmbedded() {
    var node = document.getElementById('sfr-content');
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }
  function looksLikeContent(c) {
    return !!(c && c.meta && c.modules && c.events && c.appendices && c.meta.contentUpdated);
  }
  function adopt(c, source) {
    CONTENT = c;
    CONTENT_SOURCE = source;
    PUBLICATION_STATUS = c.publicationStatus || 'published';
    ANCHOR_REDIRECTS = c.anchorRedirects || {};
    VERSION_HISTORY = c.versionHistory || [];
    PENDING_BY_ID = {};
    var pu = (c.meta.pendingUpdates || []);
    for (var i = 0; i < pu.length; i++) if (pu[i].id) PENDING_BY_ID[pu[i].id] = pu[i];
    ALL_NUMBERS = null; SEARCH_INDEX = null;
  }
  function loadContent(done) {
    var embedded = parseEmbedded();
    var canFetch = (typeof window.fetch === 'function') && location.protocol !== 'file:';
    if (!canFetch) { done(embedded, 'embedded'); return; }
    var settled = false;
    function finish(c, s) { if (settled) return; settled = true; done(c, s); }
    // Do not wait forever on a slow network: fall back to the embedded copy after 4s,
    // then swap in the live copy if it arrives later and is newer.
    var timer = setTimeout(function () { finish(embedded, 'embedded'); }, 4000);
    fetch('content.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (remote) {
        clearTimeout(timer);
        if (!looksLikeContent(remote)) throw new Error('invalid content.json');
        var useRemote = !embedded || remote.meta.contentUpdated >= embedded.meta.contentUpdated;
        if (settled) {
          // Late arrival after timeout: adopt and re-render if newer.
          if (useRemote && embedded && remote.meta.contentUpdated > embedded.meta.contentUpdated) {
            adopt(remote, 'live'); renderHeader(); renderFooter(); route();
          }
          return;
        }
        finish(useRemote ? remote : embedded, useRemote ? 'live' : 'embedded');
      })
      .catch(function () { clearTimeout(timer); finish(embedded, 'embedded'); });
  }
  function checkForNewerEdition() {
    if (typeof window.fetch !== 'function' || location.protocol === 'file:') return;
    fetch('manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        if (!m || !m.appVersion || m.appVersion === APP_VERSION) return;
        var mount = $('#update-banner-mount');
        if (!mount) return;
        mount.innerHTML = '<div class="update-banner" role="status">A newer edition (v' + escapeHTML(m.appVersion) + ') of this reference is available. <button type="button" id="reload-btn">Reload to update</button></div>';
        $('#reload-btn').addEventListener('click', function () {
          var p = Promise.resolve();
          if ('serviceWorker' in navigator) {
            p = navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.update() : null; }).catch(function () {});
          }
          p.then(function () { location.reload(); });
        });
      })
      .catch(function () { /* offline or no manifest: nothing to do */ });
  }

  // ---------- Date / freshness helpers ----------
  function todayISO() {
    // Maintainers can preview how the reference will age: #?today=2026-10-01
    var override = getQueryParam('today');
    if (/^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function daysBetween(isoA, isoB) {
    var a = new Date(isoA + 'T00:00:00'), b = new Date(isoB + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  function pendingPassed(p) { return !!(p && p.date && p.date <= todayISO()); }
  function freshness(obj) {
    if (!obj) return null;
    var p = obj.pending ? PENDING_BY_ID[obj.pending] : null;
    var today = todayISO();
    var overdue = !!(obj.reviewBy && obj.reviewBy < today);
    var passed = pendingPassed(p);
    if (!obj.asOf && !obj.reviewBy && !p) return null;
    return { asOf: obj.asOf, reviewBy: obj.reviewBy, sourceUrl: obj.sourceUrl, pending: p, overdue: overdue, pendingPassed: passed, flagged: overdue || passed };
  }
  function reviewChipHTML() {
    return '<span class="chip chip-REVIEW" title="' + escapeHTML(classDescription('REVIEW')) + '" tabindex="0" role="button">REVIEW DUE</span>';
  }
  function freshnessHTML(f) {
    if (!f) return '';
    var bits = [];
    if (f.asOf) bits.push('As of ' + escapeHTML(formatDate(f.asOf)));
    if (f.reviewBy) bits.push((f.overdue ? 'review was due ' : 'review due ') + escapeHTML(formatDate(f.reviewBy)));
    if (f.pendingPassed && f.pending) bits.push('scheduled change on ' + escapeHTML(formatDate(f.pending.date)) + ' (' + escapeHTML(f.pending.trigger) + ')');
    if (f.flagged) bits.push('confirm at the primary source before relying on this figure');
    if (f.sourceUrl && !isOffline()) bits.push('<a href="' + escapeHTML(f.sourceUrl) + '" target="_blank" rel="noopener">check source</a>');
    if (!bits.length) return '';
    return '<small class="asof' + (f.flagged ? ' overdue' : '') + '">' + bits.join(' · ') + '</small>';
  }
  function claimHTML(c) {
    var f = freshness(c);
    var html = '<div class="claim' + (f && f.flagged ? ' overdue' : '') + '"><p style="margin:0">' + chipHTML(c.classification) + (f && f.flagged ? ' ' + reviewChipHTML() : '') + ' ' + escapeHTML(c.text) + '</p>';
    html += freshnessHTML(f);
    html += '</div>';
    return html;
  }
  function pendingNoticesHTML(targetId) {
    var pu = CONTENT.meta.pendingUpdates || [];
    var html = '';
    for (var i = 0; i < pu.length; i++) {
      var p = pu[i];
      if (!p.affects || p.affects.indexOf(targetId) === -1) continue;
      if (pendingPassed(p)) {
        html += '<div class="notice passed" role="alert"><strong>Scheduled change has occurred: ' + escapeHTML(p.trigger) + ' (' + escapeHTML(formatDate(p.date)) + ')</strong>' + escapeHTML(p.notice || 'Information below was verified before this date. Confirm current details at the primary source.') + '</div>';
      } else if (p.date) {
        html += '<div class="notice upcoming"><strong>Scheduled change: ' + escapeHTML(formatDate(p.date)) + '</strong>' + escapeHTML(p.trigger) + '. Figures below are current as of their stated dates and will be flagged for review on that day.</div>';
      } else {
        html += '<div class="notice watching"><strong>Watching:</strong>' + escapeHTML(p.trigger) + '. Figures in this section will be re-verified when it happens.</div>';
      }
    }
    return html;
  }
  function contentAgeDays() { return daysBetween(CONTENT.meta.compileDate, todayISO()); }

  // ---------- Utilities ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function phoneToTel(p) {
    if (!p) return '';
    var digits = p.replace(/[^0-9]/g, '');
    if (digits.length === 10) digits = '1' + digits;
    return 'tel:+' + digits;
  }
  function urlToHref(u) {
    if (!u) return '';
    if (/^https?:\/\//.test(u)) return u;
    return 'https://' + u;
  }
  function chipHTML(cls) {
    if (!cls) return '';
    return '<span class="chip chip-' + cls + '" title="' + classDescription(cls) + '" tabindex="0" role="button">' + cls + '</span>';
  }
  function classDescription(cls) {
    if (cls === 'VERIFIED') return 'Confirmed at the named primary source as of the date shown.';
    if (cls === 'PLAUSIBLE') return 'Consistent across named sources; specifics change annually. Confirm before relying.';
    if (cls === 'STATE') return 'Program framework is federal; numbers and operational details vary by state.';
    if (cls === 'SPECIFICATION') return 'Specification — pathway or pattern guidance, not a verified fact about a specific program. Confirm specifics at the named source.';
    if (cls === 'REVIEW') return 'The scheduled review date for this figure has passed, or a scheduled change has occurred since it was verified. Confirm at the primary source before relying on it.';
    return '';
  }

  // ---------- Phone icon (inline SVG) ----------
  var PHONE_SVG = '<svg class="svg-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';
  var EXT_SVG = '<svg class="svg-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3v2h3.59L7.76 14.83l1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z"/></svg>';

  // ---------- Phone number formatting ----------
  function phoneLabelHTML(entry) {
    var bits = [];
    if (entry.phone) bits.push(escapeHTML(entry.phone));
    if (entry.phoneLabel) bits.push('<small>' + escapeHTML(entry.phoneLabel) + '</small>');
    return bits.join(' ');
  }
  function callButtonHTML(phone, label) {
    if (!phone) return '';
    return '<a class="btn-call" href="' + phoneToTel(phone) + '" aria-label="Call ' + escapeHTML(label || phone) + '">' + PHONE_SVG + ' ' + escapeHTML(phone) + '</a>';
  }
  function visitButtonHTML(url, offline) {
    if (!url) return '';
    if (offline) {
      return '<span class="btn-visit" style="opacity:0.6">' + EXT_SVG + ' ' + escapeHTML(url) + ' <span class="offline-tag">offline</span></span>';
    }
    return '<a class="btn-visit" href="' + urlToHref(url) + '" target="_blank" rel="noopener" aria-label="Open ' + escapeHTML(url) + '">' + EXT_SVG + ' ' + escapeHTML(url) + '</a>';
  }

  // ---------- Anchor + redirect ----------
  function resolveAnchor(hash) {
    if (!hash) return '';
    var h = hash.replace(/^#/, '');
    if (typeof ANCHOR_REDIRECTS !== 'undefined' && ANCHOR_REDIRECTS[h]) {
      return ANCHOR_REDIRECTS[h];
    }
    return h;
  }

  // ---------- See-also lookup ----------
  function lookupAnchorTitle(anchor) {
    if (!anchor) return anchor;
    // module N
    if (/^module\d+$/.test(anchor)) {
      var modKey = anchor;
      var m = CONTENT.modules[modKey];
      if (m) return 'Module ' + m.number + ': ' + m.title;
    }
    // module N section X
    var ms = anchor.match(/^module(\d+)-section(\d+)$/);
    if (ms) {
      var mod = CONTENT.modules['module' + ms[1]];
      if (mod) {
        for (var i = 0; i < mod.sections.length; i++) {
          if (mod.sections[i].id === anchor) {
            return 'Module ' + mod.number + ' §' + mod.sections[i].number + ' — ' + mod.sections[i].title;
          }
        }
      }
    }
    // event
    if (/^event-/.test(anchor)) {
      for (var j = 0; j < CONTENT.events.length; j++) {
        if (CONTENT.events[j].id === anchor) return 'Event ' + CONTENT.events[j].number + ': ' + CONTENT.events[j].title;
      }
    }
    // entry
    if (/^entry-/.test(anchor)) {
      var entry = findEntry(anchor);
      if (entry) return entry.name;
    }
    if (/^appendix-/.test(anchor)) {
      var key = anchor.replace('appendix-', '');
      if (CONTENT.appendices[key]) return CONTENT.appendices[key].title;
    }
    return anchor;
  }

  function findEntry(id) {
    for (var modKey in CONTENT.modules) {
      var mod = CONTENT.modules[modKey];
      for (var i = 0; i < mod.sections.length; i++) {
        var s = mod.sections[i];
        if (!s.entries) continue;
        for (var j = 0; j < s.entries.length; j++) {
          if (s.entries[j].id === id) return s.entries[j];
        }
      }
    }
    return null;
  }

  function seeAlsoHTML(arr) {
    if (!arr || !arr.length) return '';
    var html = '<div class="see-also"><strong>See also:</strong> ';
    for (var i = 0; i < arr.length; i++) {
      html += '<a href="#' + escapeHTML(arr[i]) + '">' + escapeHTML(lookupAnchorTitle(arr[i])) + '</a>';
    }
    html += '</div>';
    return html;
  }

  // ---------- Universal phone directory ----------
  var ALL_NUMBERS = null;
  function buildAllNumbers() {
    if (ALL_NUMBERS) return ALL_NUMBERS;
    var out = [];
    function add(name, phone, phoneLabel, url, sourceId, sourceLabel) {
      if (!phone) return;
      out.push({
        name: name, phone: phone, phoneLabel: phoneLabel || '',
        url: url || '', sourceId: sourceId || '', sourceLabel: sourceLabel || ''
      });
    }
    for (var modKey in CONTENT.modules) {
      var mod = CONTENT.modules[modKey];
      for (var i = 0; i < mod.sections.length; i++) {
        var s = mod.sections[i];
        if (s.entries) {
          for (var j = 0; j < s.entries.length; j++) {
            var e = s.entries[j];
            add(e.name, e.phone, e.phoneLabel, e.url, s.id, 'Module ' + mod.number + ' §' + s.number);
          }
        }
        if (s.quickDirectory) {
          for (var k = 0; k < s.quickDirectory.length; k++) {
            var q = s.quickDirectory[k];
            add(q.name, q.phone, q.phoneLabel, q.url, s.id, 'Module ' + mod.number + ' §' + s.number);
          }
        }
      }
    }
    for (var ei = 0; ei < CONTENT.events.length; ei++) {
      var ev = CONTENT.events[ei];
      for (var ec = 0; ec < ev.calls.length; ec++) {
        var call = ev.calls[ec];
        add(call.name, call.phone, call.phoneLabel, call.url, ev.id, 'Event ' + ev.number);
      }
    }
    // De-duplicate by phone+name
    var seen = {};
    var uniq = [];
    for (var u = 0; u < out.length; u++) {
      var key = out[u].phone + '|' + out[u].name;
      if (seen[key]) continue;
      seen[key] = 1;
      uniq.push(out[u]);
    }
    uniq.sort(function (a, b) { return a.name.localeCompare(b.name); });
    ALL_NUMBERS = uniq;
    return uniq;
  }

  // ---------- Search index ----------
  var SEARCH_INDEX = null;
  function buildSearchIndex() {
    if (SEARCH_INDEX) return SEARCH_INDEX;
    var idx = [];
    for (var modKey in CONTENT.modules) {
      var mod = CONTENT.modules[modKey];
      for (var i = 0; i < mod.sections.length; i++) {
        var s = mod.sections[i];
        var sectionText = (s.title || '') + ' ' + (s.intro || '');
        idx.push({
          where: 'Module ' + mod.number + ' §' + s.number,
          title: s.title, anchor: s.id, text: sectionText, type: 'section'
        });
        if (s.entries) {
          for (var j = 0; j < s.entries.length; j++) {
            var e = s.entries[j];
            var entryText = e.name + ' ' + (e.description || '') + ' ' + (e.phone || '') + ' ' + (e.url || '') + ' ' + (e.phoneLabel || '');
            if (e.extraClaims) for (var ec = 0; ec < e.extraClaims.length; ec++) entryText += ' ' + e.extraClaims[ec].text;
            idx.push({
              where: 'Module ' + mod.number + ' §' + s.number + ' — ' + e.name,
              title: e.name, anchor: s.id + '#' + e.id, text: entryText, type: 'entry'
            });
          }
        }
        if (s.quickDirectory) {
          for (var k = 0; k < s.quickDirectory.length; k++) {
            var q = s.quickDirectory[k];
            idx.push({
              where: 'Module ' + mod.number + ' §' + s.number,
              title: q.name, anchor: s.id, text: q.name + ' ' + (q.phone || '') + ' ' + (q.url || ''), type: 'directory'
            });
          }
        }
      }
    }
    for (var ei = 0; ei < CONTENT.events.length; ei++) {
      var ev = CONTENT.events[ei];
      var evText = ev.title + ' ' + ev.frame + ' ' + (ev.whatNext || '');
      for (var ec2 = 0; ec2 < ev.calls.length; ec2++) {
        var call = ev.calls[ec2];
        evText += ' ' + call.name + ' ' + (call.description || '') + ' ' + (call.phone || '');
      }
      idx.push({ where: 'Event ' + ev.number, title: ev.title, anchor: ev.id, text: evText, type: 'event' });
    }
    SEARCH_INDEX = idx;
    return idx;
  }
  function search(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return [];
    var idx = buildSearchIndex();
    var results = [];
    var qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var rx = new RegExp(qEsc, 'i');
    for (var i = 0; i < idx.length; i++) {
      var item = idx[i];
      var hay = (item.title + ' ' + item.text).toLowerCase();
      if (hay.indexOf(q) !== -1) {
        // Build snippet
        var pos = item.text.toLowerCase().indexOf(q);
        var snippet = '';
        if (pos !== -1) {
          var start = Math.max(0, pos - 60);
          var end = Math.min(item.text.length, pos + q.length + 80);
          snippet = (start > 0 ? '…' : '') + item.text.slice(start, end) + (end < item.text.length ? '…' : '');
          snippet = snippet.replace(rx, function (m) { return '<mark>' + escapeHTML(m) + '</mark>'; });
        } else {
          snippet = (item.text || '').slice(0, 140);
        }
        results.push({ item: item, snippet: snippet, score: pos === -1 ? 100 : pos });
      }
    }
    results.sort(function (a, b) { return a.score - b.score; });
    return results;
  }


  // ---------- Renderers ----------
  function renderEntry(e, opts) {
    opts = opts || {};
    var f = freshness(e);
    var html = '<article class="entry" id="' + escapeHTML(e.id || '') + '">';
    html += '<h4>' + escapeHTML(e.name) + ' ' + chipHTML(e.classification) + (f && f.flagged ? ' ' + reviewChipHTML() : '') + '</h4>';
    html += pendingNoticesHTML(e.id);
    if (e.runBy) html += '<p><small><em>Run by: ' + escapeHTML(e.runBy) + '</em></small></p>';
    if (e.description) html += '<p>' + escapeHTML(e.description) + '</p>';
    html += freshnessHTML(f);
    if (e.extraClaims) {
      for (var i = 0; i < e.extraClaims.length; i++) html += claimHTML(e.extraClaims[i]);
    }
    if (e.eligibility) html += '<p><strong>Eligibility:</strong> ' + escapeHTML(e.eligibility) + '</p>';
    if (e.howApply) html += '<p><strong>How to apply:</strong> ' + escapeHTML(e.howApply) + '</p>';
    if (e.startWhen) html += '<p><strong>Start here when:</strong> ' + escapeHTML(e.startWhen) + '</p>';
    if (e.warning) html += '<p style="background:var(--crisis-bg);color:var(--crisis-fg);padding:8px 10px;border-radius:4px;"><strong>Warning:</strong> ' + escapeHTML(e.warning) + '</p>';
    if (e.primarySource) html += '<p><small><strong>Primary source:</strong> ' + escapeHTML(e.primarySource) + '</small></p>';
    if (e.hours) html += '<p><small><strong>Hours:</strong> ' + escapeHTML(e.hours) + '</small></p>';
    if (e.tty) html += '<p><small><strong>TTY:</strong> ' + escapeHTML(e.tty) + '</small></p>';
    if (e.phone || e.url) {
      html += '<div class="contact-row">';
      if (e.phone) html += callButtonHTML(e.phone, e.name);
      if (e.url) html += visitButtonHTML(e.url, isOffline());
      html += '</div>';
      if (e.phoneLabel) html += '<p><small>' + escapeHTML(e.phoneLabel) + '</small></p>';
      if (e.urlLabel) html += '<p><small>' + escapeHTML(e.urlLabel) + '</small></p>';
    }
    if (e.seeAlso) html += seeAlsoHTML(e.seeAlso);
    html += '</article>';
    return html;
  }

  function renderHome() {
    var status = (PUBLICATION_STATUS === 'draft');
    var draftBanner = $('#draft-banner-mount');
    draftBanner.innerHTML = status ? '<div class="draft-banner">DRAFT — content under review, not yet released.</div>' : '';
    var html = '';
    html += '<h1>Senior Financial Resources</h1>';
    html += '<p style="color:var(--muted);font-size:0.95rem;">A reference for U.S. seniors, families, and the people who help them — federal programs, non-profits, event triage, fraud, and long-term care. Pick a door.</p>';
    html += '<nav class="doors" aria-label="Main navigation">';
    html += '<a class="door" href="#?view=triage"><span class="label">Something just happened.</span><span class="desc">Find the right first three calls for fifteen common events.</span></a>';
    html += '<a class="door" href="#?view=topics"><span class="label">I need help with a topic.</span><span class="desc">Browse federal programs, non-profits, fraud, long-term care, and quick cards.</span></a>';
    html += '<a class="door" href="#?view=directory"><span class="label">I just need a phone number.</span><span class="desc">Searchable directory of every phone number in this stack.</span></a>';
    html += '</nav>';

    html += '<div class="disclaimer-card" role="note"><strong>This is information, not advice.</strong>';
    html += escapeHTML(CONTENT.meta.disclaimer);
    html += '</div>';

    var age = contentAgeDays();
    var q = reviewQueue();
    html += '<p style="color:var(--muted);font-size:0.9rem;"><em>Facts last verified ' + escapeHTML(formatDate(CONTENT.meta.compileDate)) + ' (' + age + ' day' + (age === 1 ? '' : 's') + ' ago). ';
    if (q.length) html += q.length + ' dated figure' + (q.length === 1 ? ' is' : 's are') + ' past ' + (q.length === 1 ? 'its' : 'their') + ' review date and marked REVIEW DUE where ' + (q.length === 1 ? 'it appears' : 'they appear') + '. ';
    html += 'Always confirm at the primary source named for each program.</em></p>';
    return html;
  }

  function renderTriage() {
    var html = '<a class="back-link" href="#">Home</a>';
    html += '<h1>Something just happened.</h1>';
    html += '<p>Find the event that matches what is unfolding. Tap for the first three calls and what to do next.</p>';
    html += '<nav class="event-grid" aria-label="Event triage">';
    for (var i = 0; i < CONTENT.events.length; i++) {
      var ev = CONTENT.events[i];
      html += '<a class="event-card" href="#' + escapeHTML(ev.id) + '">';
      html += '<span class="num">Event ' + ev.number + '</span>';
      html += '<span class="title">' + escapeHTML(ev.title) + '</span>';
      html += '</a>';
    }
    html += '</nav>';
    html += '<h2>None of these match?</h2>';
    html += '<p>' + escapeHTML(CONTENT.appendices.a.whenNoneMatches) + '</p>';
    html += '<p style="margin-top:14px;"><a class="back-link" href="#?print=appendix-a" style="border-color:var(--primary);color:var(--primary);">Print Appendix A — phone-side card</a></p>';
    return html;
  }

  function renderEvent(ev) {
    var html = '<a class="back-link" href="#?view=triage">Event Triage</a>';
    html += '<h1 id="' + escapeHTML(ev.id) + '">Event ' + ev.number + ': ' + escapeHTML(ev.title) + '</h1>';
    html += '<p>' + escapeHTML(ev.frame) + '</p>';
    html += '<h2>First three calls</h2>';
    html += '<ol class="calls">';
    for (var i = 0; i < ev.calls.length; i++) {
      var c = ev.calls[i];
      html += '<li><strong>' + escapeHTML(c.name) + '</strong> ' + chipHTML(c.classification);
      if (c.phone) html += '<div style="margin-top:6px;">' + callButtonHTML(c.phone, c.name);
      if (c.phone && c.phoneLabel) html += ' <small>' + escapeHTML(c.phoneLabel) + '</small>';
      if (c.phone) html += '</div>';
      if (c.url) html += '<div style="margin-top:6px;">' + visitButtonHTML(c.url, isOffline()) + '</div>';
      if (c.description) html += '<p>' + escapeHTML(c.description) + '</p>';
      html += '</li>';
    }
    html += '</ol>';
    if (ev.whatNext) html += '<h2>What next</h2><p>' + escapeHTML(ev.whatNext) + '</p>';
    if (ev.seeAlso) html += seeAlsoHTML(ev.seeAlso);
    return html;
  }

  function renderTopics() {
    var html = '<a class="back-link" href="#">Home</a>';
    html += '<h1>I need help with a topic.</h1>';
    html += '<p>Five collections, each with multiple sections. Tap a card to open its table of contents.</p>';
    html += '<nav class="topic-grid" aria-label="Topic browse">';
    var topics = [
      { id: 'module1', title: 'Module 1: Federal Programs', desc: 'SSI · Medicare cost help · LIHEAP · SNAP · Housing · Property tax · Tax prep · Employment · APS / Ombudsman · Transportation · Medicare enrollment' },
      { id: 'module2', title: 'Module 2: Non-Profits & Foundations', desc: 'Copay funds · Dental/vision/hearing · Home repair · Faith-based · Disease-specific · Veterans · Caregiving · Fraud · Advocacy · Mental health · Abuse in later life' },
      { id: 'module4', title: 'Module 4: Financial Crimes Against Elders', desc: 'Three rules · Red flags · Recovery sequence · Reporting hierarchy · Helplines · Identity theft' },
      { id: 'module5', title: 'Module 5: Long-Term Care', desc: 'Aging in place · Five documents · LTC insurance · Medicaid spend-down · VA Aid & Attendance · IRMAA appeal · Hospice · Aging-in-place financing · Driving transitions · Guardianship' },
      { id: 'appendix-a', title: 'Appendix A: Event-Trigger Card', desc: 'Print-ready quick reference for the fifteen events.' },
      { id: 'appendix-b', title: 'Appendix B: Fraud One-Pager', desc: 'Print-ready fraud rules and recovery checklist.' }
    ];
    for (var i = 0; i < topics.length; i++) {
      var t = topics[i];
      html += '<a class="topic-card" href="#' + escapeHTML(t.id) + '">';
      html += '<span class="title">' + escapeHTML(t.title) + '</span>';
      html += '<span class="desc">' + escapeHTML(t.desc) + '</span>';
      html += '</a>';
    }
    html += '</nav>';
    return html;
  }


  function renderModule(mod) {
    var html = '<a class="back-link" href="#?view=topics">Topics</a>';
    html += '<h1 id="' + escapeHTML(mod.id) + '">Module ' + mod.number + ': ' + escapeHTML(mod.title) + '</h1>';
    html += '<p class="section-meta">Version ' + escapeHTML(mod.version) + ' · facts verified ' + escapeHTML(formatDate(mod.compileDate)) + '</p>';
    if (mod.summary) html += '<p><em>' + escapeHTML(mod.summary) + '</em></p>';
    if (mod.intro) html += '<p>' + escapeHTML(mod.intro) + '</p>';
    if (mod.orientation) html += '<p class="orientation"><em>' + escapeHTML(mod.orientation) + '</em></p>';
    html += '<details class="toc" open><summary>Table of Contents</summary><ul>';
    for (var i = 0; i < mod.sections.length; i++) {
      var s = mod.sections[i];
      html += '<li><a href="#' + escapeHTML(s.id) + '">§' + escapeHTML(s.number) + '. ' + escapeHTML(s.title) + '</a></li>';
    }
    html += '</ul></details>';
    for (var j = 0; j < mod.sections.length; j++) {
      html += renderSection(mod.sections[j], mod);
    }
    if (mod.tribalElderSidebar) {
      var tes = mod.tribalElderSidebar;
      html += '<aside class="sidebar tribal-elder" data-sidebar="tribalElderSidebar">';
      html += '<h3>' + escapeHTML(tes.title || 'Tribal Elder Pathway') + '</h3>';
      if (tes.intro) html += '<p>' + escapeHTML(tes.intro) + '</p>';
      if (tes.entries && tes.entries.length) {
        for (var tei = 0; tei < tes.entries.length; tei++) {
          var te = tes.entries[tei];
          html += '<div class="entry">';
          html += '<h4>' + escapeHTML(te.name) + ' ' + chipHTML(te.classification) + '</h4>';
          if (te.description) html += '<p>' + escapeHTML(te.description) + '</p>';
          if (te.phone) html += '<p>' + callButtonHTML(te.phone, te.name) + (te.phoneLabel ? ' <small>' + escapeHTML(te.phoneLabel) + '</small>' : '') + '</p>';
          if (te.url) html += '<p>' + visitButtonHTML(te.url, isOffline()) + '</p>';
          html += '</div>';
        }
      }
      html += '</aside>';
    }
    return html;
  }

  function renderSection(s, mod) {
    var f = freshness(s);
    var html = '<section id="' + escapeHTML(s.id) + '" style="margin:24px 0;">';
    html += '<h2>§' + escapeHTML(s.number) + '. ' + escapeHTML(s.title) + (f && f.flagged ? ' ' + reviewChipHTML() : '') + '</h2>';
    html += pendingNoticesHTML(s.id);
    if (s.intro) html += '<p>' + escapeHTML(s.intro) + '</p>';
    html += freshnessHTML(f);
    if (s.quickDirectory && s.quickDirectory.length) {
      html += '<table class="dir-table"><thead><tr><th>Organization</th><th>Phone</th><th>Web</th></tr></thead><tbody>';
      for (var i = 0; i < s.quickDirectory.length; i++) {
        var q = s.quickDirectory[i];
        html += '<tr>';
        html += '<td>' + escapeHTML(q.name) + '</td>';
        html += '<td>' + (q.phone ? callButtonHTML(q.phone, q.name) + (q.phoneLabel ? ' <small>' + escapeHTML(q.phoneLabel) + '</small>' : '') : '—') + '</td>';
        html += '<td>' + (q.url ? visitButtonHTML(q.url, isOffline()) : '—') + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    if (s.entries && s.entries.length) {
      for (var j = 0; j < s.entries.length; j++) html += renderEntry(s.entries[j]);
    }
    if (s.extras) {
      for (var k = 0; k < s.extras.length; k++) {
        html += '<div class="entry"><h4>' + escapeHTML(s.extras[k].title) + '</h4><p>' + escapeHTML(s.extras[k].text) + '</p></div>';
      }
    }
    if (s.middleIncomeSidebar) {
      var mis = s.middleIncomeSidebar;
      html += '<aside class="sidebar middle-income" data-sidebar="middleIncomeSidebar">';
      html += '<h4>' + escapeHTML(mis.title || 'Middle-Income Sidebar') + '</h4>';
      if (mis.intro) html += '<p>' + escapeHTML(mis.intro) + '</p>';
      if (mis.claims && mis.claims.length) {
        for (var msi = 0; msi < mis.claims.length; msi++) html += claimHTML(mis.claims[msi]);
      }
      html += '</aside>';
    }
    if (s.seeAlso) html += seeAlsoHTML(s.seeAlso);
    html += '</section>';
    return html;
  }

  function renderDirectory() {
    var html = '<a class="back-link" href="#">Home</a>';
    html += '<h1>Universal Phone Directory</h1>';
    html += '<p>Every phone number in this stack. Tap a number to call. Type in the search bar above to filter.</p>';
    var nums = buildAllNumbers();
    html += '<table class="dir-table" id="directory-table"><thead><tr><th>Organization</th><th>Phone</th><th>Web</th><th>Source</th></tr></thead><tbody>';
    for (var i = 0; i < nums.length; i++) {
      var n = nums[i];
      html += '<tr data-search="' + escapeHTML((n.name + ' ' + n.phone + ' ' + n.url + ' ' + n.sourceLabel).toLowerCase()) + '">';
      html += '<td>' + escapeHTML(n.name) + '</td>';
      html += '<td>' + callButtonHTML(n.phone, n.name) + (n.phoneLabel ? ' <small>' + escapeHTML(n.phoneLabel) + '</small>' : '') + '</td>';
      html += '<td>' + (n.url ? visitButtonHTML(n.url, isOffline()) : '—') + '</td>';
      html += '<td><a href="#' + escapeHTML(n.sourceId) + '">' + escapeHTML(n.sourceLabel) + '</a></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function renderAppendixA(printMode) {
    var html = '';
    if (!printMode) html += '<a class="back-link" href="#?view=topics">Topics</a>';
    html += '<div class="print-page">';
    html += '<h1 id="appendix-a">' + escapeHTML(CONTENT.appendices.a.title) + '</h1>';
    html += '<p>' + escapeHTML(CONTENT.appendices.a.intro) + '</p>';
    if (!printMode) html += '<p><a class="back-link" href="#?print=appendix-a" style="border-color:var(--primary);color:var(--primary);">Print this page</a></p>';
    for (var i = 0; i < CONTENT.events.length; i++) {
      var ev = CONTENT.events[i];
      html += '<section style="margin:14px 0;page-break-inside:avoid;">';
      html += '<h3>' + ev.number + '. ' + escapeHTML(ev.title) + '</h3>';
      html += '<p style="font-size:0.95rem;">' + escapeHTML(ev.frame) + '</p>';
      html += '<ol>';
      for (var j = 0; j < ev.calls.length; j++) {
        var c = ev.calls[j];
        html += '<li><strong>' + escapeHTML(c.name) + '</strong>';
        if (c.phone) html += ' — ' + callButtonHTML(c.phone, c.name);
        if (c.phoneLabel) html += ' <small>' + escapeHTML(c.phoneLabel) + '</small>';
        if (c.url) html += ' (' + escapeHTML(c.url) + ')';
        html += '</li>';
      }
      html += '</ol>';
      if (ev.seeAlso) html += '<p style="font-size:0.85rem;"><em>See also:</em> ';
      if (ev.seeAlso) {
        for (var k = 0; k < ev.seeAlso.length; k++) {
          html += escapeHTML(lookupAnchorTitle(ev.seeAlso[k]));
          if (k < ev.seeAlso.length - 1) html += ' · ';
        }
        html += '</p>';
      }
      html += '</section>';
    }
    html += '<h3>When None of the Above Matches</h3>';
    html += '<p>' + escapeHTML(CONTENT.appendices.a.whenNoneMatches) + '</p>';
    html += '</div>';
    if (printMode) {
      setTimeout(function () { window.print(); }, 250);
    }
    return html;
  }

  function renderAppendixB(printMode) {
    var html = '';
    if (!printMode) html += '<a class="back-link" href="#?view=topics">Topics</a>';
    html += '<div class="print-page">';
    html += '<h1 id="appendix-b">' + escapeHTML(CONTENT.appendices.b.title) + '</h1>';
    html += '<p>' + escapeHTML(CONTENT.appendices.b.intro) + '</p>';
    if (!printMode) html += '<p><a class="back-link" href="#?print=appendix-b" style="border-color:var(--primary);color:var(--primary);">Print this page</a></p>';
    html += '<h2>Three Rules That Stop Almost Every Scam</h2>';
    html += '<ol style="font-size:1rem;">';
    for (var i = 0; i < CONTENT.appendices.b.threeRules.length; i++) {
      var r = CONTENT.appendices.b.threeRules[i];
      html += '<li><strong>' + escapeHTML(r.rule) + '.</strong> ' + escapeHTML(r.text) + '</li>';
    }
    html += '</ol>';
    html += '<h2>If It Has Already Happened — In This Order</h2>';
    html += '<p>Stop further loss first. Prove it later. Every hour matters.</p>';
    html += '<ol>';
    for (var j = 0; j < CONTENT.appendices.b.ifAlreadyHappened.length; j++) {
      html += '<li>' + escapeHTML(CONTENT.appendices.b.ifAlreadyHappened[j]) + '</li>';
    }
    html += '</ol>';
    html += '<h2>Phone Directory — Post These</h2>';
    html += '<table class="dir-table"><thead><tr><th>Service</th><th>Phone</th><th>Web</th></tr></thead><tbody>';
    for (var k = 0; k < CONTENT.appendices.b.directory.length; k++) {
      var d = CONTENT.appendices.b.directory[k];
      html += '<tr>';
      html += '<td>' + escapeHTML(d.name) + '</td>';
      html += '<td>' + (d.phone ? callButtonHTML(d.phone, d.name) : '—') + '</td>';
      html += '<td>' + (d.url ? escapeHTML(d.url) : '—') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';
    if (printMode) {
      setTimeout(function () { window.print(); }, 250);
    }
    return html;
  }

  function renderSearchResults(query) {
    var html = '<a class="back-link" href="#">Home</a>';
    html += '<h1>Search results for &ldquo;' + escapeHTML(query) + '&rdquo;</h1>';
    var res = search(query);
    if (!res.length) {
      html += '<p class="no-results">No matches found. Try a different word, an organization name, or a phone number.</p>';
      return html;
    }
    html += '<p style="color:var(--muted);">' + res.length + ' result' + (res.length === 1 ? '' : 's') + '.</p>';
    for (var i = 0; i < Math.min(res.length, 80); i++) {
      var r = res[i];
      html += '<div class="search-result">';
      html += '<div class="where">' + escapeHTML(r.item.where) + '</div>';
      html += '<a href="#' + escapeHTML(r.item.anchor.split('#')[0]) + (r.item.anchor.indexOf('#') > -1 ? '' : '') + '"><strong>' + escapeHTML(r.item.title) + '</strong></a>';
      html += '<div class="snippet">' + r.snippet + '</div>';
      html += '</div>';
    }
    return html;
  }


  // ---------- Review queue (every dated item whose review is due) ----------
  function reviewQueue() {
    var out = [];
    function consider(obj, where, anchor, label) {
      var f = freshness(obj);
      if (f && f.flagged) out.push({ where: where, anchor: anchor, label: label, f: f });
    }
    for (var modKey in CONTENT.modules) {
      var mod = CONTENT.modules[modKey];
      for (var i = 0; i < mod.sections.length; i++) {
        var s = mod.sections[i];
        var where = 'Module ' + mod.number + ' §' + s.number;
        consider(s, where, s.id, s.title);
        var ents = s.entries || [];
        for (var j = 0; j < ents.length; j++) {
          var e = ents[j];
          consider(e, where, e.id, e.name);
          var cl = e.extraClaims || [];
          for (var k = 0; k < cl.length; k++) consider(cl[k], where + ' — ' + e.name, e.id, cl[k].text.slice(0, 90) + (cl[k].text.length > 90 ? '…' : ''));
        }
        if (s.middleIncomeSidebar && s.middleIncomeSidebar.claims) {
          var mc = s.middleIncomeSidebar.claims;
          for (var m = 0; m < mc.length; m++) consider(mc[m], where + ' — sidebar', s.id, mc[m].text.slice(0, 90));
        }
      }
    }
    return out;
  }

  function renderMaintenance() {
    var today = todayISO();
    var html = '<a class="back-link" href="#">Home</a>';
    html += '<h1>Maintenance Mode</h1>';
    html += '<div class="maintenance-panel">';
    html += '<p><strong>App version:</strong> v' + escapeHTML(APP_VERSION) + ' · <strong>Content file:</strong> v' + escapeHTML(CONTENT.meta.version) + ', updated ' + escapeHTML(formatDate(CONTENT.meta.contentUpdated)) + ' (' + (CONTENT_SOURCE === 'live' ? 'loaded live from content.json' : 'embedded snapshot') + ')</p>';
    html += '<p><strong>Facts last verified:</strong> ' + escapeHTML(CONTENT.meta.compileDateDisplay) + ' · ' + contentAgeDays() + ' days ago</p>';
    html += '<p><strong>Evaluated as of:</strong> ' + escapeHTML(formatDate(today)) + (getQueryParam('today') ? ' (preview override; add <code>?today=YYYY-MM-DD</code> to the URL to change)' : ' (today; append <code>?today=YYYY-MM-DD</code> to preview a future date)') + '</p>';

    var q = reviewQueue();
    html += '<h3>Review queue — ' + q.length + ' item' + (q.length === 1 ? '' : 's') + ' due</h3>';
    if (!q.length) html += '<p>Nothing is past its review date.</p>';
    else {
      html += '<ul class="review-queue">';
      for (var i = 0; i < q.length; i++) {
        var it = q[i];
        var why = [];
        if (it.f.overdue) why.push('review was due ' + formatDate(it.f.reviewBy));
        if (it.f.pendingPassed) why.push(it.f.pending.trigger + ' occurred ' + formatDate(it.f.pending.date));
        html += '<li><span class="where">' + escapeHTML(it.where) + '</span><br><a href="#' + escapeHTML(it.anchor) + '">' + escapeHTML(it.label) + '</a> <small>— ' + escapeHTML(why.join('; ')) + '</small></li>';
      }
      html += '</ul>';
    }

    html += '<h3>Pending Updates</h3><ul>';
    var pu = CONTENT.meta.pendingUpdates || [];
    for (var p = 0; p < pu.length; p++) {
      var u = pu[p];
      var state = pendingPassed(u) ? 'OCCURRED' : (u.date ? 'scheduled' : 'watching');
      html += '<li><strong>' + escapeHTML(u.date ? formatDate(u.date) : 'TBD') + '</strong> — ' + escapeHTML(u.trigger) + ' · ' + state + ' (affects: ';
      for (var a = 0; a < u.affects.length; a++) html += (a ? ', ' : '') + '<a href="#' + escapeHTML(u.affects[a]) + '">' + escapeHTML(u.affects[a]) + '</a>';
      html += ')</li>';
    }
    html += '</ul>';
    if (CONTENT.meta.reviewPolicy) html += '<h3>Review policy</h3><p>' + escapeHTML(CONTENT.meta.reviewPolicy) + '</p>';
    html += '<h3>Anchor health</h3>';
    html += '<p>' + Object.keys(ANCHOR_REDIRECTS).length + ' active redirect(s).</p>';
    html += '<h3>Version history</h3><ul>';
    for (var v = 0; v < VERSION_HISTORY.length; v++) {
      html += '<li><strong>v' + escapeHTML(VERSION_HISTORY[v].version) + '</strong> (' + escapeHTML(VERSION_HISTORY[v].date) + ') — ' + escapeHTML(VERSION_HISTORY[v].changes) + '</li>';
    }
    html += '</ul>';
    html += '<p><strong>Methodology:</strong> Architecture of Understanding v' + escapeHTML(CONTENT.meta.methodologyVersion) + '</p>';
    html += '</div>';
    return html;
  }

  // ---------- Date helpers ----------
  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  // ---------- Offline detection ----------
  function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  // ---------- Header (content age) ----------
  function renderHeader() {
    var el = $('#content-age');
    if (!el) return;
    var age = contentAgeDays();
    el.textContent = 'v' + APP_VERSION + ' · facts verified ' + formatDate(CONTENT.meta.compileDate) + ' · ' + age + ' days ago';
    el.className = age > 180 ? 'age-stale' : (age > 90 ? 'age-warn' : '');
    el.title = age > 90 ? 'More than 90 days since the last verification pass. Dated figures are flagged individually as their review dates pass.' : '';
  }

  // ---------- Footer ----------
  function renderFooter() {
    var fm = $('#footer-meta');
    if (!fm) return;
    var html = '';
    html += '<div><strong>' + escapeHTML(CONTENT.meta.productName) + '</strong> · v' + escapeHTML(APP_VERSION) + ' · Compiled by ' + escapeHTML(CONTENT.meta.compiler) + ' · facts verified ' + escapeHTML(CONTENT.meta.compileDateDisplay) + '</div>';
    html += '<div style="margin-top:6px;">' + escapeHTML(CONTENT.meta.disclaimer) + '</div>';
    html += '<div class="source-line">Content file updated ' + escapeHTML(formatDate(CONTENT.meta.contentUpdated)) + ' · ' + (CONTENT_SOURCE === 'live' ? 'loaded live' : 'embedded snapshot' + (location.protocol === 'file:' ? ' (opened as a file)' : '')) + '</div>';
    html += '<div style="margin-top:6px;"><a href="#?view=triage">Event Triage</a> · <a href="#?view=topics">Topics</a> · <a href="#?view=directory">Phone Directory</a> · <a href="#?view=maintenance">Version History &amp; Review Queue</a></div>';
    fm.innerHTML = html;
  }

  // ---------- Router ----------
  function getQueryParam(name) {
    var hash = window.location.hash || '';
    var qIdx = hash.indexOf('?');
    if (qIdx === -1) return '';
    var query = hash.slice(qIdx + 1);
    var pairs = query.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      if (kv[0] === name) return decodeURIComponent(kv[1] || '');
    }
    return '';
  }

  function route() {
    var hash = window.location.hash || '';
    var anchorPart = hash.replace(/^#/, '').split('?')[0];
    var resolvedAnchor = resolveAnchor(anchorPart);
    if (resolvedAnchor !== anchorPart) {
      window.location.replace('#' + resolvedAnchor + (hash.indexOf('?') > -1 ? '?' + hash.split('?')[1] : ''));
      return;
    }
    var view = getQueryParam('view');
    var print = getQueryParam('print');
    var searchQ = getQueryParam('search');
    var main = $('#main');
    main.innerHTML = '';

    if (print === 'appendix-a') {
      main.innerHTML = renderAppendixA(true);
      return;
    }
    if (print === 'appendix-b') {
      main.innerHTML = renderAppendixB(true);
      return;
    }
    if (searchQ) {
      $('#search-input').value = searchQ;
      main.innerHTML = renderSearchResults(searchQ);
      return;
    }
    if (view === 'maintenance' || getQueryParam('maintenance') === '1') {
      main.innerHTML = renderMaintenance();
      return;
    }
    if (view === 'triage') {
      main.innerHTML = renderTriage();
      return;
    }
    if (view === 'topics') {
      main.innerHTML = renderTopics();
      return;
    }
    if (view === 'directory') {
      main.innerHTML = renderDirectory();
      return;
    }

    // Anchor-based navigation
    if (anchorPart) {
      // Module-level
      if (CONTENT.modules[anchorPart]) {
        main.innerHTML = renderModule(CONTENT.modules[anchorPart]);
        return;
      }
      // Section-level (module1-section4)
      var msMatch = anchorPart.match(/^module(\d+)-section/);
      if (msMatch) {
        var modKey = 'module' + msMatch[1];
        if (CONTENT.modules[modKey]) {
          main.innerHTML = renderModule(CONTENT.modules[modKey]);
          // scroll to anchor
          setTimeout(function () {
            var target = document.getElementById(anchorPart);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 50);
          return;
        }
      }
      // Event
      if (/^event-/.test(anchorPart)) {
        for (var i = 0; i < CONTENT.events.length; i++) {
          if (CONTENT.events[i].id === anchorPart) {
            main.innerHTML = renderEvent(CONTENT.events[i]);
            return;
          }
        }
      }
      // Entry
      if (/^entry-/.test(anchorPart)) {
        var entry = findEntry(anchorPart);
        if (entry) {
          // Find the section/module containing the entry
          for (var modKey2 in CONTENT.modules) {
            var modX = CONTENT.modules[modKey2];
            for (var j = 0; j < modX.sections.length; j++) {
              if (modX.sections[j].entries) {
                for (var k = 0; k < modX.sections[j].entries.length; k++) {
                  if (modX.sections[j].entries[k].id === anchorPart) {
                    main.innerHTML = renderModule(modX);
                    setTimeout(function () {
                      var target = document.getElementById(anchorPart);
                      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 50);
                    return;
                  }
                }
              }
            }
          }
        }
      }
      // Appendix
      if (anchorPart === 'appendix-a') { main.innerHTML = renderAppendixA(false); return; }
      if (anchorPart === 'appendix-b') { main.innerHTML = renderAppendixB(false); return; }
    }

    // Default: home
    main.innerHTML = renderHome();
  }

  // ---------- Init / event handlers ----------
  function initLargeText() {
    var stored = false;
    try { stored = localStorage.getItem('sfr-large-text') === '1'; } catch (e) { /* storage blocked */ }
    if (stored) {
      document.documentElement.classList.add('large-text');
      $('#text-toggle').setAttribute('aria-pressed', 'true');
    }
  }
  function toggleLargeText() {
    var on = document.documentElement.classList.toggle('large-text');
    $('#text-toggle').setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem('sfr-large-text', on ? '1' : '0'); } catch (e) { /* storage blocked */ }
  }

  function initKeyModal() {
    var modal = $('#key-modal');
    var btn = $('#key-btn');
    var close = $('#key-close');
    btn.addEventListener('click', function () { modal.classList.add('open'); close.focus(); });
    close.addEventListener('click', function () { modal.classList.remove('open'); btn.focus(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.remove('open'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) { modal.classList.remove('open'); btn.focus(); }
    });
    // Chips also open the modal
    document.body.addEventListener('click', function (e) {
      if (e.target.classList && e.target.classList.contains('chip')) {
        modal.classList.add('open');
        close.focus();
      }
    });
    document.body.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('chip')) {
        e.preventDefault();
        modal.classList.add('open');
        close.focus();
      }
    });
  }

  function initSearch() {
    var input = $('#search-input');
    var debounceId = null;
    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(debounceId);
      debounceId = setTimeout(function () {
        if (q.length >= 2) {
          window.location.hash = '#?search=' + encodeURIComponent(q);
        } else if (q.length === 0 && getQueryParam('search')) {
          window.location.hash = '#';
        }
      }, 220);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var q = input.value.trim();
        if (q) window.location.hash = '#?search=' + encodeURIComponent(q);
      }
    });
  }


  function initServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('service-worker.js').catch(function () { /* ignore */ });
    }
  }

  function init() {
    initLargeText();
    initKeyModal();
    initSearch();
    initServiceWorker();
    $('#home-link').addEventListener('click', function (e) { e.preventDefault(); window.location.hash = ''; });
    $('#text-toggle').addEventListener('click', toggleLargeText);

    var pre = getQueryParam('search');
    if (pre) $('#search-input').value = pre;
    var large = getQueryParam('large');
    if (large === '1') {
      document.documentElement.classList.add('large-text');
      $('#text-toggle').setAttribute('aria-pressed', 'true');
    }

    loadContent(function (c, source) {
      if (!c) {
        $('#main').innerHTML = '<p class="no-results">Could not load the reference content. Reload the page, or check that content.json is present.</p>';
        return;
      }
      adopt(c, source);
      window.addEventListener('hashchange', route);
      window.addEventListener('online', route);
      window.addEventListener('offline', route);
      renderHeader();
      renderFooter();
      route();
      checkForNewerEdition();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
