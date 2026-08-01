#!/usr/bin/env bash
# ============================================================
# Everything that must hold before a push.
#
#   npm run check
#
# Exists because a "//" comment key in vercel.json reached production
# and failed the build, and because a stray NUL byte in src/sync.js
# made the file read as binary. Both were invisible to the tests.
# ============================================================
set -uo pipefail

cd "$(dirname "$0")/.."
fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fail=1; }

step "build"
if python3 src/build.py >/dev/null 2>&1; then ok "index.html regenerated"
else bad "src/build.py failed"; python3 src/build.py; fi

if git diff --quiet -- index.html 2>/dev/null; then
  ok "committed index.html matches the template"
else
  bad "index.html is out of date — commit the rebuild"
fi

step "source hygiene"
# a NUL byte makes git treat the file as binary and grep stop working
if grep -qlP '\x00' src/*.js src/*.html src/*.py 2>/dev/null; then
  bad "NUL byte in: $(grep -lP '\x00' src/*.js src/*.html src/*.py 2>/dev/null | tr '\n' ' ')"
else
  ok "no NUL bytes in source"
fi

if grep -q '@@' index.html 2>/dev/null; then
  bad "unsubstituted placeholder left in index.html"
else
  ok "no placeholders left in the build"
fi

if node --check src/sync.js 2>/dev/null && node --check src/config.js 2>/dev/null; then
  ok "javascript parses"
else
  bad "javascript syntax error"
fi

# Every button in this app calls a function by name from an onclick, and a
# renamed function leaves a button that does nothing at all with no error
# until somebody presses it. Cheap to check, so it is checked.
python3 - <<'PY'
import re, sys
s = open('index.html').read()
called  = set(re.findall(r'on(?:click|change|submit|input)=\\?"?\'?([A-Za-z_$][\w$]*)\s*\(', s))
defined = set(re.findall(r'function\s+([A-Za-z_$][\w$]*)\s*\(', s))
defined |= set(re.findall(r'(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()', s))
defined |= {'VFSync'}
missing = sorted(c for c in called if c not in defined)
if missing:
    print('  FAIL handler with no function: %s' % ', '.join(missing)); sys.exit(1)
print('  ok   all %d inline handlers resolve' % len(called))
PY
[ $? -eq 0 ] || fail=1

step "vercel.json"
python3 - <<'PY'
import json, sys
try:
    cfg = json.load(open('vercel.json'))
except Exception as e:
    print('  FAIL invalid JSON: %s' % e); sys.exit(1)
# Vercel validates strictly and rejects anything it does not know,
# including a "//" used as a comment
allowed = {
  '$schema', 'buildCommand', 'outputDirectory', 'installCommand',
  'devCommand', 'framework', 'cleanUrls', 'trailingSlash',
  'headers', 'redirects', 'rewrites', 'regions', 'public',
  'ignoreCommand', 'github', 'crons', 'functions', 'images',
}
bad = sorted(set(cfg) - allowed)
if bad:
    print('  FAIL Vercel will reject these keys: %s' % ', '.join(bad)); sys.exit(1)
if cfg.get('outputDirectory') != '.':
    print('  FAIL outputDirectory must be "." for a root-level app'); sys.exit(1)
print('  ok   valid, and no keys Vercel would reject')
PY
[ $? -ne 0 ] && fail=1

step "app and database agree"
# The seed was written from the shop names rather than the codes in the
# app, so two of five were wrong (MMB/HIR instead of MBK/HRN). Every
# write for those shops was rejected by a foreign key.
python3 - <<'PY'
import pathlib, re, sys

tpl = pathlib.Path('src/template.html').read_text(encoding='utf-8')
block = re.search(r'const SHOPS = \[(.*?)\];', tpl, re.S)
if not block:
    print('  FAIL could not find SHOPS in src/template.html'); sys.exit(1)
app = {m.group(1) for m in re.finditer(r"id:\s*'([^']+)'", block.group(1))}

sql = pathlib.Path('supabase/05_production.sql').read_text(encoding='utf-8')
ins = re.search(r'insert into shops[^;]+;', sql, re.S)
if not ins:
    print('  FAIL could not find the shops insert in 05_production.sql'); sys.exit(1)
db = {m.group(1) for m in re.finditer(r"\('([A-Z]{2,4})',\s*'KPN'", ins.group(0))}

if app != db:
    print('  FAIL shop codes differ')
    print('       app only: %s' % (sorted(app - db) or 'none'))
    print('       sql only: %s' % (sorted(db - app) or 'none'))
    sys.exit(1)
print('  ok   %d shop codes match the app: %s' % (len(app), ', '.join(sorted(app))))

# the app also carries a bill prefix per shop; a mismatch would put the
# wrong code on a printed bill
pref_app = dict(re.findall(r"id:'([^']+)'[^}]*prefix:'([^']+)'", block.group(1)))
pref_sql = dict(re.findall(r"\('([A-Z]{2,4})',\s*'KPN',\s*'[^']*',\s*'([^']+)'\)", ins.group(0)))
diff = {k for k in pref_app if pref_app[k] != pref_sql.get(k)}
if diff:
    print('  FAIL bill prefix differs for: %s' % ', '.join(sorted(diff))); sys.exit(1)
print('  ok   bill prefixes match')
PY
[ $? -ne 0 ] && fail=1

step "secrets"
# The word service_role appears legitimately in comments warning against
# it. What matters is a real key, so every JWT in the tree is decoded and
# its role claim checked: anon is meant to ship, service_role never is.
python3 - <<'PY'
import base64, json, pathlib, re, sys

JWT = re.compile(rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}')
bad = []
for p in pathlib.Path('.').rglob('*'):
    if not p.is_file() or '.git/' in str(p) or 'node_modules' in str(p):
        continue
    try:
        blob = p.read_bytes()
    except Exception:
        continue
    for m in JWT.finditer(blob):
        payload = m.group().split(b'.')[1]
        payload += b'=' * (-len(payload) % 4)
        try:
            role = json.loads(base64.urlsafe_b64decode(payload)).get('role')
        except Exception:
            continue
        if role and role != 'anon':
            bad.append('%s: a %s key' % (p, role))

if bad:
    for b in bad:
        print('  FAIL ' + b)
    sys.exit(1)
print('  ok   every key in the tree is an anon key')
PY
[ $? -ne 0 ] && fail=1

step "tests"
if node test/smoke.js >/tmp/vf-smoke.log 2>&1; then
  ok "$(tail -2 /tmp/vf-smoke.log | head -1)"
else
  bad "smoke tests"; tail -20 /tmp/vf-smoke.log
fi

if node test/sync.test.js >/tmp/vf-sync.log 2>&1; then
  ok "$(tail -2 /tmp/vf-sync.log | head -1)"
else
  bad "sync tests"; tail -20 /tmp/vf-sync.log
fi

# The rest drive a real browser against test/mock-supabase.js. Skipped
# rather than failed where Playwright is not installed, so this script
# still means something on a machine that only has python and node.
if ! node -e "require('playwright')" 2>/dev/null; then
  export NODE_PATH=/opt/node22/lib/node_modules
fi
if node -e "require('playwright')" 2>/dev/null; then
  python3 -m http.server 8092 >/dev/null 2>&1 &
  SERVE_PID=$!
  trap 'kill $SERVE_PID 2>/dev/null' EXIT
  sleep 2
  for suite in login route theme product vendor people signup whatsapp emailauth shoplogin phone; do
    if node "test/$suite.test.js" >"/tmp/vf-$suite.log" 2>&1 &&
       ! grep -q FAIL "/tmp/vf-$suite.log"; then
      ok "$suite — $(grep -E 'passed,' "/tmp/vf-$suite.log" | tail -1)"
    else
      bad "$suite"; grep -E 'FAIL|Error' "/tmp/vf-$suite.log" | head -5
    fi
  done
  kill $SERVE_PID 2>/dev/null; trap - EXIT
else
  printf '  --   browser suites skipped (no playwright)\n'
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall checks passed\033[0m\n'
else
  printf '\033[31mchecks FAILED — do not push\033[0m\n'
fi
exit $fail
