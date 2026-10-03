#!/usr/bin/env bash
# Record a full operator flow in the deployed dev UI (fixture agents, no model calls).
# Output: review/videos/operator-flow-fixture.webm. Credentials come from .env.local and
# go only into origin-scoped request headers.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env.local; set +a
S=rec-operator
OUT=review/videos/operator-flow-fixture.webm
URL=https://converge-dev.converge-42.workers.dev/
H=$(printf '{"CF-Access-Client-Id":"%s","CF-Access-Client-Secret":"%s"}' "$CF_ACCESS_CLIENT_ID_DEV" "$CF_ACCESS_CLIENT_SECRET_DEV")
ab() { agent-browser --session "$S" "$@" >/dev/null 2>&1 || true; }
js() { agent-browser --session "$S" eval "$1" 2>/dev/null | tail -1; }
click_text() { # scroll a button with this text into view, pause, then click it
  js "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('$1')); if(!b) return 'missing'; b.scrollIntoView({block:'center'}); return 'ok'; })()" >/dev/null
  sleep 1.5
  js "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('$1')); if(!b) return 'missing'; b.click(); return 'clicked'; })()"
}
scroll_tour() { # slow scroll through the page
  local h; h=$(js "document.documentElement.scrollHeight" | tr -d '"')
  for y in $(seq 0 450 "${h%.*}"); do js "window.scrollTo({top:$y,behavior:'smooth'})" >/dev/null; sleep 1.2; done
}

agent-browser --session "$S" --headers "$H" open "$URL" >/dev/null 2>&1
ab set viewport 1440 900
ab wait --load networkidle
ab record start "$OUT"
sleep 3
click_text 'Create session'; sleep 4
click_text 'Start agents'; sleep 5
for i in $(seq 1 40); do
  title=$(js "document.querySelector('h1')?.textContent ?? ''")
  echo "$(date +%T) $title"
  [[ "$title" == *"Ready to approve"* || "$title" == *"attention"* ]] && break
  js "window.scrollTo({top: ($i % 3) * 700, behavior:'smooth'})" >/dev/null
  sleep 8
done
sleep 2; scroll_tour
# Open the counterexample of the first failed matrix cell.
js "(() => { const b=[...document.querySelectorAll('button')].find(x=>/Customer isolation: Failed/.test(x.getAttribute('aria-label')||x.textContent)); if(!b) return 'missing'; b.scrollIntoView({block:'center'}); b.click(); return 'ok'; })()"
sleep 7; ab press Escape; sleep 2
click_text 'Approve commit'; sleep 6
click_text 'Promote commit'; sleep 30
js "document.body.innerText.match(/Main now[^\n]*/)?.[0] ?? 'no promotion text'"
click_text 'Preview'; sleep 25
js "window.scrollTo({top:0,behavior:'smooth'})" >/dev/null; sleep 2
click_text 'Publish replay'; sleep 6
js "document.body.innerText.match(/https:[^\s]*replay\/rpl_[a-z0-9]+/)?.[0] ?? 'none'"
sleep 3
ab record stop
ab close
ls -la "$OUT"
