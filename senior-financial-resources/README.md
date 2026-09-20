# Senior Financial Resources — v1.6

A single-page reference for U.S. seniors, families, and the people who help them. Compiled by Alan Francis. Reference, not advice.

v1.6 is the **freshness architecture** release. It changes how the reference ages, not what it says. No factual claim text was altered; facts were last verified May 4, 2026.

## What changed in v1.6

1. **Content lives in `content.json`.** It is the single source of truth. `index.html` is generated from it and carries an embedded snapshot so the file still works offline or opened directly from disk. When the page is served from a website it fetches `content.json` and uses whichever copy is newer (by `meta.contentUpdated`). Editing the data file is enough to update the live site.
2. **Dated figures are self-aging.** Any claim, entry, or section may carry `asOf`, `reviewBy`, `sourceUrl`, and `pending`. The page prints "As of …" under the figure, and once `reviewBy` passes it adds a red **REVIEW DUE** chip and a "confirm at the primary source" line, automatically, with no edit and no redeploy. The figure itself is never changed by the app.
3. **Scheduled changes surface on their date.** `meta.pendingUpdates` entries with a `date` and a `notice` show as a muted "Scheduled change" note before the date and a red "Scheduled change has occurred" notice after it, in the sections and entries they name. Entries with no date show as "Watching".
4. **Newer-edition banner.** `manifest.json` records the deployed app version. A cached copy of the page that sees a newer version offers a one-click reload.
5. **Review queue.** The Maintenance page (footer link, or `#?view=maintenance`) lists every figure past its review date, with links. Append `?today=YYYY-MM-DD` to preview how the page will look on a future date, for example `#?view=maintenance&today=2026-10-01`.
6. **Working service worker.** Shell is cached for offline use; data files are network-first so a returning visitor always gets the current data when online.
7. **Fixed:** module 5's USDA Section 504 entry shared its id with module 2's, so its anchor never resolved. It is now `entry-usda-504-m5`.

## Files

| Path | Role |
|---|---|
| `content.json` | Source of truth. Edit this. |
| `src/shell.html` | Page markup and CSS. |
| `src/app.js` | Renderer, content loading, freshness logic. |
| `src/service-worker.js` | Offline caching template. |
| `tools/build.js` | Validates `content.json`, then writes `index.html`, `manifest.json`, `service-worker.js`. |
| `index.html`, `manifest.json`, `service-worker.js` | Build outputs. Committed so the site works with no build step and can be opened from disk. |
| `netlify.toml` | Netlify config for a site whose base directory is this folder. |

## Updating a figure

1. Edit the claim in `content.json`. Keep the prose in `text`; set `asOf` to the date the new figure took effect or was verified, and `reviewBy` to the next date it should be checked.
2. Set `meta.contentUpdated` to today. Bump `meta.version` only for a release.
3. Run `node tools/build.js`. It refuses to build if a date is malformed, `reviewBy` precedes `asOf`, a `pending` id or anchor does not exist, or an id is duplicated.
4. Commit `content.json` together with the regenerated `index.html`, `manifest.json`, and `service-worker.js`.

A deployed site picks up a new `content.json` on the next visit even if step 3 is skipped, because the live file wins when it is newer than the embedded copy. Run the build anyway so the offline snapshot and the manifest stay consistent.

## Freshness fields

Any claim in `extraClaims` or a sidebar's `claims`, any entry, and any section may carry:

| Field | Meaning |
|---|---|
| `asOf` | `YYYY-MM-DD`. Date the figure took effect or was verified. Printed under the figure. |
| `reviewBy` | `YYYY-MM-DD`. Editorial deadline. After this date the figure is flagged REVIEW DUE. Requires `asOf`. |
| `sourceUrl` | `https://…` primary source. Rendered as a "check source" link. |
| `pending` | id of a `meta.pendingUpdates` entry. When that entry's date passes, the figure is flagged even if `reviewBy` has not. |

`meta.pendingUpdates` entries: `{ id, date (or null), trigger, affects: [section or entry ids], notice }`. The `notice` text is shown once `date` passes.

**The header date is a summary, not the record.** `meta.compileDate` says when the last full verification pass happened. The per-figure `asOf` and `reviewBy` dates are the record, and they drive the REVIEW DUE flags and the "figures due for review" count in the header. The build refuses a `compileDate` that is later than any figure's `reviewBy`, so the header cannot be made to look fresher than the figures beneath it.

**Review-date policy.** `reviewBy` is the next date on which the primary source is expected to publish a change (calendar-year figures: December 31; federal-poverty-level figures: April 1; fiscal-year funding: September 30), or 90 days after the compile date for status snapshots. These are editorial deadlines, not claims about the programs.

## Deploying on Netlify

The repository's root `netlify.toml` runs `netlify-build.sh`, which reads the `SITE_NAME` Netlify provides and publishes the folder that belongs to that site. So the Netlify site named `senior-financial-resources` needs no base directory, build command, or publish directory: link it to the repository, branch `main`, and leave every field blank. Cache headers for the data files come from `_headers` in this folder. The Psalms map site builds from the same script and is unaffected.

The folder's own `netlify.toml` is kept for the alternative setup where the site's base directory is set to `senior-financial-resources`; either route produces the same site.

## Not in v1.6

Automated re-verification against primary sources (a scheduled job that diffs SSA, CMS, HHS and USAC figures against `content.json` and opens a pull request for review) is the next layer. It needs the structured fields this release adds.
