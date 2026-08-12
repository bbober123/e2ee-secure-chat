#!/usr/bin/env bash
# Odświeża kopie plików z src/js/ (żeby test zawsze sprawdzał AKTUALNY kod,
# nie jakąś starą kopię w tests/vendor/) i uruchamia test end-to-end.
set -e
cd "$(dirname "$0")"

for f in crypto.js ratchet.js sealed.js prekeys.js groupkeys.js; do
    cp "../src/js/$f" "vendor/$f"
done

node crypto-e2e-test.mjs
