#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
node scripts/github-deploy-atimelogger-notion-worker.mjs
