#!/usr/bin/env bash
set -euo pipefail

label="${LABEL:-ai.hermes.shadow-collector}"
repo_root="${REPO_ROOT:-$(pwd)}"
vault_root="${VAULT_ROOT:-${repo_root}/Vault}"
node_bin="${NODE_BIN:-$(command -v node)}"
hour="${HOUR:-23}"
minute="${MINUTE:-35}"
log_dir="${LOG_DIR:-${HOME}/.openclaw/logs}"
plist_path="${PLIST_PATH:-${HOME}/Library/LaunchAgents/${label}.plist}"
uid="$(id -u)"

if [[ ! -x "${node_bin}" ]]; then
  echo "node binary is not executable: ${node_bin}" >&2
  exit 1
fi

xml_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

repo_root_xml="$(printf '%s' "${repo_root}" | xml_escape)"
vault_root_xml="$(printf '%s' "${vault_root}" | xml_escape)"
node_bin_xml="$(printf '%s' "${node_bin}" | xml_escape)"
label_xml="$(printf '%s' "${label}" | xml_escape)"
stdout_path="${log_dir}/hermes-shadow-collector.out.log"
stderr_path="${log_dir}/hermes-shadow-collector.err.log"
stdout_path_xml="$(printf '%s' "${stdout_path}" | xml_escape)"
stderr_path_xml="$(printf '%s' "${stderr_path}" | xml_escape)"

mkdir -p "${log_dir}" "$(dirname "${plist_path}")"

cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label_xml}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "${repo_root_xml}" &amp;&amp; HERMES_VAULT_ROOT="${vault_root_xml}" "${node_bin_xml}" output/hermes-codex-runtime/collect-hermes-shadow.mjs --days=7 --vault-root="${vault_root_xml}" --apply</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${stdout_path_xml}</string>
  <key>StandardErrorPath</key>
  <string>${stderr_path_xml}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

plutil -lint "${plist_path}" >/dev/null

launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${uid}" "${plist_path}"
launchctl enable "gui/${uid}/${label}"

echo "installed ${label}"
launchctl print "gui/${uid}/${label}" | sed -n '1,80p'
