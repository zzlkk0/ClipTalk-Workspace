#!/usr/bin/env bash
# Creates a private CA and an HTTPS certificate for IP addresses (no domain needed).
#   bash scripts/tls-ip-cert.sh TLS_DIR IP[,IP...]
# Keeps the CA across runs. Re-issues the server certificate when it is missing,
# its addresses changed, or it expires within 30 days. Clients trust TLS_DIR/ca.pem.
set -Eeuo pipefail
umask 077
dir=${1:?TLS directory required}
ips=${2:?comma-separated IP addresses required}
command -v openssl >/dev/null || { printf 'openssl is required to create HTTPS certificates.\n' >&2; exit 1; }
mkdir -p "$dir"
san='IP:127.0.0.1,DNS:localhost'
IFS=',' read -r -a list <<< "$ips"
for ip in "${list[@]}"; do
  ip=${ip//[[:space:]]/}
  [[ -z "$ip" ]] && continue
  if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$ip" =~ ^[0-9A-Fa-f:]+$ ]]; then
    [[ "$ip" == 127.0.0.1 ]] || san="$san,IP:$ip"
  else
    printf 'Not an IP address: %s\n' "$ip" >&2; exit 2
  fi
done
# Separate subjects: a server certificate whose subject equals its issuer looks self-signed.
write_cnf() {
  printf '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = %s\n[v3_ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n' "$2" > "$1"
}
if [[ ! -s "$dir/ca.key" || ! -s "$dir/ca.pem" ]]; then
  write_cnf "$dir/ca.cnf" "ClipTalk private CA $(date -u +%Y%m%d%H%M%S)"
  openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days 3650 -keyout "$dir/ca.key" -out "$dir/ca.pem" \
    -config "$dir/ca.cnf" -extensions v3_ca 2>/dev/null
  printf 'Created a private certificate authority: %s/ca.pem\n' "$dir"
fi
chmod 644 "$dir/ca.pem"
renew=0
if [[ ! -s "$dir/server.crt" || ! -s "$dir/server.key" ]]; then renew=1
elif [[ "$(cat "$dir/san.txt" 2>/dev/null)" != "$san" ]]; then renew=1
elif ! openssl x509 -checkend 2592000 -noout -in "$dir/server.crt" >/dev/null; then renew=1
fi
if ((renew)); then
  # Browsers accept at most 825 days for certificates from locally trusted CAs.
  printf 'basicConstraints = CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = %s\n' "$san" > "$dir/server.ext"
  write_cnf "$dir/server.cnf" "ClipTalk server"
  openssl req -new -nodes -newkey rsa:2048 -keyout "$dir/server.key.new" -out "$dir/server.csr" -config "$dir/server.cnf" 2>/dev/null
  openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" -CAserial "$dir/ca.srl" -CAcreateserial \
    -days 825 -sha256 -extfile "$dir/server.ext" -out "$dir/server.crt.new" 2>/dev/null
  mv "$dir/server.key.new" "$dir/server.key"; mv "$dir/server.crt.new" "$dir/server.crt"
  printf '%s\n' "$san" > "$dir/san.txt"
  rm -f "$dir/server.csr"
  printf 'Issued an HTTPS certificate for %s\n' "${san//IP:/}"
else
  printf 'Kept the existing HTTPS certificate for %s\n' "$(sed 's/IP://g' "$dir/san.txt")"
fi
chmod 600 "$dir/ca.key" "$dir/server.key"
