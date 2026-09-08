#!/bin/bash
# GamificationOG — GitHub push helper
# Usage: TOKEN=<pat> ./scripts/push-to-github.sh  (or: ./scripts/push-to-github.sh <pat>)
# Security: token is passed via env var / arg and used as an HTTP header only.
#           It is NEVER written to .git/config, .git-credentials, or any file.
set -euo pipefail

REPO="https://github.com/Ogxcoders/GamificationOG.git"
BRANCH="main"
cd "$(dirname "$0")/.."

TOKEN="${TOKEN:-${1:-}}"
if [ -z "$TOKEN" ]; then
  echo "ERROR: No token provided. Usage: TOKEN=github_pat_... ./scripts/push-to-github.sh"
  exit 1
fi

# Basic auth header: username:token (username is ignored by GitHub for PAT auth,
# but must be non-empty). Computed in-memory only.
AUTH=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)

echo "==> Pushing ${BRANCH} to Ogxcoders/GamificationOG ..."
git -c "http.extraHeader=AUTHORIZATION: Basic ${AUTH}" push "${REPO}" "${BRANCH}"

echo "==> Verifying remote state ..."
git -c "http.extraHeader=AUTHORIZATION: Basic ${AUTH}" ls-remote "${REPO}" refs/heads/"${BRANCH}"

echo "==> SUCCESS: push complete and verified."
