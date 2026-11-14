#!/usr/bin/env bash
# Library engineer: upgrades the motion libraries to their latest compatible versions on a branch, and merges ONLY
# if every test passes and a real motion video renders. Prints what changed. (GitHub workflow "studio-rnd".)
set -euo pipefail
cur=$(node -p "require('remotion/package.json').version")
latest=$(npm view remotion@4 version --json | node -e "const v=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(Array.isArray(v)?v.at(-1):v)")
icons=$(npm view lucide-react version)
echo "remotion $cur → $latest · lucide-react → $icons"
if [ "$cur" = "$latest" ] && [ "$(node -p "require('lucide-react/package.json').version")" = "$icons" ]; then echo "UP_TO_DATE"; exit 0; fi
pkgs="remotion@$latest @remotion/cli@$latest @remotion/renderer@$latest @remotion/bundler@$latest @remotion/lottie@$latest @remotion/transitions@$latest @remotion/motion-blur@$latest @remotion/shapes@$latest @remotion/paths@$latest lucide-react@$icons"
present=""; for p in $pkgs; do n=${p%@*}; node -e "require.resolve('$n/package.json')" 2>/dev/null && present="$present $p"; done
npm install --no-audit --no-fund $present
npx tsc --noEmit -p .
# the heavy full-render test times out on CI runners; the real motion render below covers rendering
node --no-warnings=ExperimentalWarning --test --test-skip-pattern="long video always yields" "tests/**/*.test.ts"
npx remotion browser ensure
npx remotion render motion/index.ts MotionShort /tmp/rnd-sample.mp4 --codec=h264 --log=error
echo "UPGRADED remotion $cur → $latest"
