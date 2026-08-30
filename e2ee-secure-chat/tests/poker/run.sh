#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
cp ../../src/js/casino/cards.js src/cards.js
cp ../../src/js/casino/poker-engine.js src/poker-engine.js
node poker-unit-test.mjs
echo
node poker-simulation.mjs
