#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

echo "::verify::start"
echo "::gate::pnpm-check::start"
pnpm check
echo "::gate::pnpm-check::pass"
echo "::verify::pass"
