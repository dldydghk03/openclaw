#!/usr/bin/env bash
set -euo pipefail

repo_root="${REPO_ROOT:-$(pwd)}"
vault_root="${VAULT_ROOT:-${repo_root}/Vault}"
node_bin="${NODE_BIN:-$(command -v node)}"
cron_expr="${CRON_EXPR:-35 23 * * *}"
log_file="${LOG_FILE:-${HOME}/.openclaw/logs/hermes-shadow-collector.log}"
marker_begin="# BEGIN HERMES_SHADOW_COLLECTOR"
marker_end="# END HERMES_SHADOW_COLLECTOR"

if [[ ! -x "${node_bin}" ]]; then
  echo "node binary is not executable: ${node_bin}" >&2
  exit 1
fi

mkdir -p "$(dirname "${log_file}")"

tmp_current="$(mktemp)"
tmp_next="$(mktemp)"
trap 'rm -f "${tmp_current}" "${tmp_next}"' EXIT

crontab -l > "${tmp_current}" 2>/dev/null || true

awk -v begin="${marker_begin}" -v end="${marker_end}" '
  $0 == begin { skip = 1; next }
  $0 == end { skip = 0; next }
  skip != 1 { print }
' "${tmp_current}" > "${tmp_next}"

{
  echo "${marker_begin}"
  printf '%s cd %q && HERMES_VAULT_ROOT=%q %q output/hermes-codex-runtime/collect-hermes-shadow.mjs --days=7 --vault-root=%q --apply >> %q 2>&1\n' \
    "${cron_expr}" \
    "${repo_root}" \
    "${vault_root}" \
    "${node_bin}" \
    "${vault_root}" \
    "${log_file}"
  echo "${marker_end}"
} >> "${tmp_next}"

crontab "${tmp_next}"

echo "installed Hermes shadow collector cron:"
crontab -l | awk -v begin="${marker_begin}" -v end="${marker_end}" '
  $0 == begin { show = 1 }
  show == 1 { print }
  $0 == end { show = 0 }
'
