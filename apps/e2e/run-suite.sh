#!/usr/bin/env bash
# Runs the e2e suite (the list in package.json "test") in one style and prints a summary.
#   bash run-suite.sh                 # default style (whatever the org/user has: dashboard)
#   E2E_STYLE=liquid-glass bash run-suite.sh [--skip styles.e2e.mjs]
# styles.e2e.mjs tests the organisation's style policy itself; with a forced local style it has nothing to prove, so the
# liquid-glass run skips it.
cd "$(dirname "$0")" || exit 1
files=$(node -e "console.log(require('./package.json').scripts.test.replace(/node /g,'').split(' && ').join(' '))")
skip="${SKIP:-}"
[ -n "${E2E_STYLE:-}" ] && skip="$skip styles.e2e.mjs"
pass=0; fail=0; failed=""
for f in $files; do
  case " $skip " in *" $f "*) echo "SKIPPED $f"; continue;; esac
  echo "=== $f (${E2E_STYLE:-default})"
  if node --import ./style-hook.mjs "$f"; then pass=$((pass+1)); else fail=$((fail+1)); failed="$failed $f"; fi
done
echo "SUITE ${E2E_STYLE:-default}: $pass passed, $fail failed${failed:+ ($failed )}"
[ "$fail" -eq 0 ]
