#!/bin/sh
# Security checks for the frontend/nginx image (Phase 1 hardening), run against the built image on an isolated
# Docker network with fixed client IPs. No backend is needed: a request that nginx lets through reaches the
# (absent) upstream and gets 502, a request nginx refuses gets 404.
#
#   sh scripts/nginx_security_test.sh [image]        (default: flowboard-frontend:local)
set -u
IMG="${1:-flowboard-frontend:local}"
NET="fb-nginx-sec-$$"
SUBNET="172.31.250"
ALLOWED="$SUBNET.10"; DENIED="$SUBNET.11"; PROXY="$SUBNET.12"
PASS=0; FAIL=0

cleanup() {
    docker rm -f fbsec-allowed fbsec-denied fbsec-proxy fbsec-t1 fbsec-t2 fbsec-t3 >/dev/null 2>&1
    docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

check() {  # check <label> <expected> <actual>
    if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "PASS $1"; else FAIL=$((FAIL + 1)); echo "FAIL $1 (expected $2, got $3)"; fi
}

status() {  # status <client container> <url> [extra wget args...]  -> HTTP status code
    client="$1"; url="$2"; shift 2
    docker exec "$client" wget -S -O /dev/null -T 5 "$@" "$url" 2>&1 | awk '/^  HTTP\//{c=$2} END{print c}'
}

headers() {  # headers <client> <url> -> response headers
    docker exec "$1" wget -S -O /dev/null -T 5 "$2" 2>&1 | sed -n 's/^  //p'
}

target() {  # target <name> <ip> [env ...]
    name="$1"; ip="$2"; shift 2
    docker run -d --name "$name" --network "$NET" --ip "$ip" -e BACKEND_UPSTREAM=127.0.0.1:9 "$@" "$IMG" >/dev/null
}

cleanup
docker network create --subnet "$SUBNET.0/24" "$NET" >/dev/null || exit 1
for c in allowed:$ALLOWED denied:$DENIED proxy:$PROXY; do
    docker run -d --name "fbsec-${c%%:*}" --network "$NET" --ip "${c#*:}" "$IMG" sleep 600 >/dev/null || exit 1
done
target fbsec-t1 "$SUBNET.20" -e ADMIN_ALLOWLIST="$ALLOWED"
target fbsec-t2 "$SUBNET.21"                                   # image default: ADMIN_ALLOWLIST empty
target fbsec-t3 "$SUBNET.22" -e ADMIN_ALLOWLIST=203.0.113.5 -e TRUSTED_PROXY_CIDRS="$PROXY"
sleep 2
T1="http://$SUBNET.20"; T2="http://$SUBNET.21"; T3="http://$SUBNET.22"

echo "== admin allowlist"
check "allowlisted IP reaches the admin"                     502 "$(status fbsec-allowed "$T1/admin/")"
check "other IP gets 404"                                     404 "$(status fbsec-denied "$T1/admin/")"
check "other IP can't spoof X-Forwarded-For"                  404 "$(status fbsec-denied "$T1/admin/" --header "X-Forwarded-For: $ALLOWED")"
check "empty allowlist (default) denies everyone"             404 "$(status fbsec-allowed "$T2/admin/")"
check "admin login also denied with empty allowlist"          404 "$(status fbsec-allowed "$T2/admin/login/")"
check "API is not affected by the admin rule"                 502 "$(status fbsec-denied "$T2/api/health/")"

echo "== trusted proxies"
check "trusted proxy forwarding an allowlisted client"        502 "$(status fbsec-proxy "$T3/admin/" --header "X-Forwarded-For: 203.0.113.5")"
check "trusted proxy forwarding another client"               404 "$(status fbsec-proxy "$T3/admin/" --header "X-Forwarded-For: 198.51.100.9")"
check "untrusted peer's X-Forwarded-For is ignored"           404 "$(status fbsec-denied "$T3/admin/" --header "X-Forwarded-For: 203.0.113.5")"

echo "== admin login rate limit"
codes=""
for i in 1 2 3 4 5 6 7 8 9 10; do codes="$codes $(status fbsec-allowed "$T1/admin/login/")"; done
case "$codes" in *429*) limited=yes ;; *) limited=no ;; esac
check "rapid admin logins from one IP get 429 ($codes )"      yes "$limited"

echo "== security headers on the SPA"
H="$(headers fbsec-denied "$T2/")"
check "X-Frame-Options DENY"            yes "$(echo "$H" | grep -qi '^X-Frame-Options: DENY' && echo yes || echo no)"
check "X-Content-Type-Options nosniff"  yes "$(echo "$H" | grep -qi '^X-Content-Type-Options: nosniff' && echo yes || echo no)"
check "Referrer-Policy"                 yes "$(echo "$H" | grep -qi '^Referrer-Policy: same-origin' && echo yes || echo no)"
check "Permissions-Policy"              yes "$(echo "$H" | grep -qi '^Permissions-Policy: camera=()' && echo yes || echo no)"
check "CSP enforced (not report-only)"  yes "$(echo "$H" | grep -qi '^Content-Security-Policy: ' && echo yes || echo no)"
check "CSP has no unsafe-inline/eval"   yes "$(echo "$H" | grep -i '^Content-Security-Policy' | grep -qiE 'unsafe-(inline|eval)' && echo no || echo yes)"
check "CSP allows the theme script by hash" yes "$(echo "$H" | grep -i '^Content-Security-Policy' | grep -q "script-src 'self' 'sha256-" && echo yes || echo no)"
check "CSP allows sonner's style by hash"   yes "$(echo "$H" | grep -i '^Content-Security-Policy' | grep -q "style-src 'self' 'sha256-" && echo yes || echo no)"
check "frame-ancestors 'none'"          yes "$(echo "$H" | grep -i '^Content-Security-Policy' | grep -q "frame-ancestors 'none'" && echo yes || echo no)"
check "assets carry the headers too"    yes "$(headers fbsec-denied "$T2/favicon.svg" | grep -qi '^X-Content-Type-Options' && echo yes || echo no)"
check "nginx version hidden"            "Server: nginx" "$(echo "$H" | grep -i '^Server:' | tr -d '\r')"

echo "== access log redaction (no reset/invite secrets)"
SECRET="s3cr3tT0kenXYZ"
for u in "/reset-password/MQ/$SECRET" "/invite/$SECRET" "/api/invitations/preview/$SECRET/"          "/login?next=%2Finvite%2F$SECRET" "/api/x/?token=$SECRET" "/api/projects/?page=7"; do
    docker exec fbsec-denied wget -q -O /dev/null -T 5 "$T2$u" >/dev/null 2>&1
done
sleep 1
LOG="$(docker logs fbsec-t2 2>&1)"
check "no secret in any nginx log line"            no  "$(echo "$LOG" | grep -q "$SECRET" && echo yes || echo no)"
check "reset URL logged as redacted"           yes "$(echo "$LOG" | grep -qF '"GET /reset-password/[REDACTED] HTTP/1.1" 200' && echo yes || echo no)"
check "SPA invite URL logged as redacted"      yes "$(echo "$LOG" | grep -qF '"GET /invite/[REDACTED] HTTP/1.1" 200' && echo yes || echo no)"
check "invite preview API logged as redacted"  yes "$(echo "$LOG" | grep -qF '"GET /api/invitations/preview/[REDACTED] HTTP/1.1" 502' && echo yes || echo no)"
check "secret query values redacted"           yes "$(echo "$LOG" | grep -qF '"GET /login?[REDACTED] HTTP/1.1"' && echo "$LOG" | grep -qF '"GET /api/x/?[REDACTED] HTTP/1.1"' && echo yes || echo no)"
docker exec fbsec-denied wget -q -O /dev/null -T 5 "$T2/api/projects/?page=8" >/dev/null 2>&1; sleep 1
check "ordinary upstream errors still logged in detail" yes "$(docker logs fbsec-t2 2>&1 | grep -q 'connect() failed.*request: "GET /api/projects/?page=8' && echo yes || echo no)"
check "quiet location is not reachable directly" 404 "$(status fbsec-denied "$T2/__fb_quiet/api/projects/")"
check "token routes keep the security headers" yes "$(headers fbsec-denied "$T2/invite/abc" | grep -qi '^Content-Security-Policy: ' && echo yes || echo no)"
check "upstream failure visible in the access log" yes "$(echo "$LOG" | grep -qF '/api/invitations/preview/[REDACTED] HTTP/1.1" 502 ' && echo "$LOG" | grep -q 'ups=502' && echo yes || echo no)"
check "ordinary path kept, with status/timing" yes "$(echo "$LOG" | grep -E '"GET /api/projects/\?page=7 HTTP/1.1" 502 [0-9]+ rt=[0-9.]+ ups=' >/dev/null && echo yes || echo no)"

echo "== config validation"
docker run --rm -e ADMIN_ALLOWLIST="1.2.3.4; allow all" -e BACKEND_UPSTREAM=127.0.0.1:9 "$IMG" nginx -t >/dev/null 2>&1
check "malformed ADMIN_ALLOWLIST stops the container" 1 "$( [ $? -ne 0 ] && echo 1 || echo 0)"
docker run --rm -e CSP_HEADER=X-Custom -e BACKEND_UPSTREAM=127.0.0.1:9 "$IMG" nginx -t >/dev/null 2>&1
check "unknown CSP_HEADER stops the container"         1 "$( [ $? -ne 0 ] && echo 1 || echo 0)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
