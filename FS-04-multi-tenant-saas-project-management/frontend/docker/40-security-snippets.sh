#!/bin/sh
# Runs from the nginx image entrypoint (/docker-entrypoint.d/) before nginx starts. Generates:
#   /etc/nginx/snippets/admin-access.conf     from ADMIN_ALLOWLIST
#   /etc/nginx/snippets/real-ip.conf          from TRUSTED_PROXY_CIDRS
#   /etc/nginx/snippets/security-headers.conf (CSP with the hash of index.html's inline script)
# Any malformed value stops the container instead of producing a permissive config.
set -eu

SNIPPETS=/etc/nginx/snippets
mkdir -p "$SNIPPETS"

fail() { echo "40-security-snippets: $*" >&2; exit 1; }

# IPv4/IPv6 address or CIDR: hex digits, dots, colons and one optional /prefix. Nothing else gets into the config.
valid_cidr() { echo "$1" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$'; }

list() { echo "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true; }

# --- Admin access -------------------------------------------------------------------------------------
# Empty (the production default): nobody. "*": everyone (local development only). Otherwise a list of IPs/CIDRs.
ADMIN_ALLOWLIST="${ADMIN_ALLOWLIST:-}"
{
    echo "# generated from ADMIN_ALLOWLIST"
    if [ "$ADMIN_ALLOWLIST" = "*" ]; then
        echo "allow all;"
    else
        for entry in $(list "$ADMIN_ALLOWLIST"); do
            valid_cidr "$entry" || fail "invalid ADMIN_ALLOWLIST entry: $entry"
            echo "allow $entry;"
        done
        echo "deny all;"
    fi
} > "$SNIPPETS/admin-access.conf"

# --- Trusted proxies ----------------------------------------------------------------------------------
# X-Forwarded-For is honoured only from these peers; from anyone else it's ignored and $remote_addr stays the
# TCP peer, so a client can't spoof its way into the admin allowlist or around the login rate limit.
TRUSTED_PROXY_CIDRS="${TRUSTED_PROXY_CIDRS:-}"
{
    echo "# generated from TRUSTED_PROXY_CIDRS"
    entries="$(list "$TRUSTED_PROXY_CIDRS")"
    if [ -n "$entries" ]; then
        for entry in $entries; do
            valid_cidr "$entry" || fail "invalid TRUSTED_PROXY_CIDRS entry: $entry"
            echo "set_real_ip_from $entry;"
        done
        echo "real_ip_header X-Forwarded-For;"
        echo "real_ip_recursive on;"
    fi
} > "$SNIPPETS/real-ip.conf"

# --- Security headers + CSP ---------------------------------------------------------------------------
# CSP_HEADER: Content-Security-Policy (enforce, default) or Content-Security-Policy-Report-Only (observe).
CSP_HEADER="${CSP_HEADER:-Content-Security-Policy}"
case "$CSP_HEADER" in
    Content-Security-Policy|Content-Security-Policy-Report-Only) ;;
    *) fail "CSP_HEADER must be Content-Security-Policy or Content-Security-Policy-Report-Only" ;;
esac

# The only inline script is index.html's theme bootstrap; allow exactly that script by hash (no 'unsafe-inline').
# Computed here from the built file, so the hash can never drift from the page.
INDEX=/usr/share/nginx/html/index.html
hashes=""
b64sha256() { sha256sum | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'; }
if [ -f "$INDEX" ]; then
    # The browser hashes the exact text between <script> and </script>, newlines and indentation included.
    rest="$(cat "$INDEX")"
    while case "$rest" in *"<script>"*"</script>"*) true ;; *) false ;; esac; do
        body="${rest#*<script>}"
        body="${body%%</script>*}"
        hashes="$hashes 'sha256-$(printf '%s' "$body" | b64sha256)'"
        rest="${rest#*<script>}"
        rest="${rest#*</script>}"
    done
fi

# Inline <style> elements created at runtime (sonner's toasts): exact hashes computed at build time
# (scripts/csp-style-hashes.mjs). Each line must be a hash source; anything else stops the container.
STYLE_HASH_FILE=/etc/nginx/csp-style-hashes.txt
style_hashes=""
if [ -f "$STYLE_HASH_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [ -z "$line" ] && continue
        echo "$line" | grep -Eq "^'sha256-[A-Za-z0-9+/]+={0,2}'\$" || fail "invalid style hash in $STYLE_HASH_FILE: $line"
        style_hashes="$style_hashes $line"
    done < "$STYLE_HASH_FILE"
else
    echo "40-security-snippets: $STYLE_HASH_FILE missing; style-src stays 'self' only (toasts will be unstyled)" >&2
fi

CSP="default-src 'self'; script-src 'self'$hashes; style-src 'self'$style_hashes; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

cat > "$SNIPPETS/security-headers.conf" <<EOF
# generated: security headers for nginx-served SPA responses (Django sets its own on /api and /admin)
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "same-origin" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
add_header $CSP_HEADER "$CSP" always;
EOF

echo "40-security-snippets: admin=$( [ "$ADMIN_ALLOWLIST" = "*" ] && echo open || ([ -n "$ADMIN_ALLOWLIST" ] && echo allowlist || echo closed) ), trusted_proxies=$( [ -n "$TRUSTED_PROXY_CIDRS" ] && echo set || echo none ), csp=$CSP_HEADER"
