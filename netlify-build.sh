#!/usr/bin/env bash
# Selects which folder to publish based on the Netlify site running the build.
# Netlify sets SITE_NAME and SITE_ID in every build. Run locally with SITE_NAME=... bash netlify-build.sh
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist

name="${SITE_NAME:-}"
id="${SITE_ID:-}"

if [[ "$name" == senior-financial-resources* || "$id" == "43eb3681-6f6b-4f68-8bb4-3bc2f7386c30" ]]; then
  echo "Building Senior Financial Resources"
  (cd senior-financial-resources && node tools/build.js)
  cp -r senior-financial-resources/. dist/
  rm -rf dist/src dist/tools dist/netlify.toml
elif [[ "$name" == psalms-map* || "$id" == "b08796e5-0ecf-4fa6-9ceb-8fbff4a74c24" ]]; then
  echo "Publishing The Psalms Interactive Map"
  cp -r psalms-map/. dist/
else
  echo "ERROR: unrecognised Netlify site (SITE_NAME='$name', SITE_ID='$id')." >&2
  echo "Add this site to netlify-build.sh so it knows which folder to publish." >&2
  exit 1
fi
ls -la dist
