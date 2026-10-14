import type { Config } from '../../../../config/application/config';
import { quote } from '../../../../../shared/infrastructure/process';

// The monitoring extension owns discovery. Read desired names from the existing
// control config and expected containers from each app's actual Compose bundle.
// Never enumerate only running containers: missing containers must still alert.
export function extensionDiscovery(c: Config): string {
  // Only public observation fields enter the bootstrap fallback, never secrets.
  const fallback = typeof c.extensions.monitoring === 'object'
    ? {containers: c.extensions.monitoring.containers ?? [], upstreams: c.extensions.monitoring.upstreams ?? []}
    : {containers: [], upstreams: []};
  return `
  retired_containers="|"
  retired_upstreams="|"
  # Every file is read by one jq per kind, not one or three per app: each jq
  # start costs ~40ms of CPU, and this collector runs every minute.
  # Retained generation contracts identify intentionally removed managed apps.
  # Do not infer retirement merely because Docker cannot find a container.
  saved=()
  for root in /opt/2server/apps/*; do
    [ ! -f "$root/current" ] || continue
    app="\${root##*/}"
    [[ "$app" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
    for color in blue green; do
      if [ -f "$root/$color.json" ]; then saved+=("$root/$color.json"); fi
    done
  done
  if [ "\${#saved[@]}" -gt 0 ]; then
    retired=$(jq -r --arg server '${c.name}' '
      (input_filename | capture("/(?<app>[^/]+)/(?<color>blue|green)[.]json$")) as $id |
      ((if .compose then [.compose.containers[]]
        else [range(1; ((.replicas // 1) + 1)) | "two-" + $server + "-" + $id.app + "-" + $id.color + (if . == 1 then "" else "-" + tostring end)] end)[] |
        "c\\t" + tostring),
      (.compose.upstreamFile // "" | tostring | select(. != "") | "u\\t" + .)' "\${saved[@]}")
    while IFS=$'\\t' read -r kind value; do
      [ -n "$value" ] || continue
      case "$kind" in
        c) retired_containers="$retired_containers$value|";;
        u) retired_upstreams="$retired_upstreams$value|";;
      esac
    done <<< "$retired"
  fi
  composes=()
  for root in /opt/2server/extensions/*; do
    [ -f "$root/retired" ] || continue
    compose="$root/current/compose.json"
    [ -f "$compose" ] || compose="$root/compose.json"
    if [ -f "$compose" ]; then composes+=("$compose"); fi
  done
  if [ "\${#composes[@]}" -gt 0 ]; then
    targets=$(jq -r '.services[].container_name | if type == "string" then . else error("Invalid extension containers") end' "\${composes[@]}")
    while IFS= read -r n; do
      [ -z "$n" ] || retired_containers="$retired_containers$n|"
    done <<< "$targets"
  fi
  config=/opt/2server/control/current/server.json
  # One tagged line per observation: c<TAB>container, u<TAB>file US name US
  # healthPath, i<TAB>app<TAB>root.
  emit='(.observers.containers[] | "c\\t" + .),
    (.observers.upstreams[] | "u\\t" + ([.file, .name, (.healthPath // "/healthz")] | map(tostring) | join("\\u001f"))),
    (.installed[]? | "i\\t" + (map(tostring) | join("\\t")))'
  if [ -f "$config" ]; then
    # Read inventory and this collector's observers in one atomic revision.
    snapshot=$(jq -r --arg server '${c.name}' --arg instance ${quote(c.instance?.name ?? '')} '
      def safe_path: type == "string" and test("^/[a-zA-Z0-9_./-]*$") and (contains("..") | not);
      if .version == 1 and .name == $server then
      {observers: (if $instance == "" then (.extensions.monitoring // {})
        elif .extensionApps[$instance] == null then {}
        elif .extensionApps[$instance].template == "monitoring" then .extensionApps[$instance].spec
        else error("Invalid monitoring instance") end), installed: [
        ((.extensionApps // {}) | keys[] | [., "/opt/2server/extensions/" + .]),
        ((.extensions.services // {}) | keys[] | [., "/opt/2server/extensions/" + .]),
        ((.extensions // {}) | to_entries[] |
          select(.value and (.key != "services" and .key != "webhooks" and .key != "alertWebhookEnv")) |
          [.key, (if .key == "monitoring" then "/opt/2server/monitoring"
            elif .key == "imageProxy" then "/opt/2server/imgproxy"
            else "/opt/2server/extensions/" + .key end)])
      ]} |
      .observers |= (if type == "boolean" then {} else . end) |
      if (.observers | type != "object") then error("Invalid monitoring observers") else . end |
      .observers |= {containers: (.containers // []), upstreams: (.upstreams // [])} |
      if (.observers.containers | type == "array" and length <= 100 and all(.[]; type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"))) and
         (.observers.upstreams | type == "array" and length <= 100 and all(.[];
           type == "object" and (.name | type == "string" and test("^[a-z][a-z0-9-]{0,47}$")) and
           (.file | safe_path) and ((.healthPath // "/healthz") | safe_path))) and
         (.installed | all(.[]; .[0] | test("^[a-z][a-zA-Z0-9-]*$")))
        then . else error("Invalid monitoring discovery configuration") end
      else error("Invalid monitoring control config") end | '"$emit" "$config")
  else
    snapshot=$(jq -r '{observers: .} | '"$emit" <<< ${quote(JSON.stringify(fallback))})
  fi
  observed="" upstreams="" installed=""
  while IFS=$'\\t' read -r kind first second; do
    case "$kind" in
      c) observed="$observed$first"$'\\n';;
      u) upstreams="$upstreams$first"$'\\n';;
      i) installed="$installed$first"$'\\t'"$second"$'\\n';;
    esac
  done <<< "$snapshot"
  # Explicit observations follow current configuration, with managed retirement
  # taking precedence over a stale compatibility observer.
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$retired_containers" in *"|$n|"*) continue;; esac
    probe "$n" no
  done <<< "$observed"
  while IFS= read -r upstream; do
    [ -n "$upstream" ] || continue
    IFS=$'\\x1f' read -r file name health_path <<< "$upstream"
    case "$retired_upstreams" in *"|$file|"*) continue;; esac
    targets=$(awk '/^[[:space:]]*reverse_proxy[[:space:]]/{for(i=2;i<=NF;i++) if ($i ~ /^[a-zA-Z0-9][a-zA-Z0-9_.-]*:[0-9]+$/) print $i}' "$file" 2>/dev/null || true)
    if [ -z "$targets" ]; then
      printf 'two_app_ready{container="missing-upstream-%s"} 0\\n' "$name"
    fi
    for target in $targets; do
      n="\${target%:*}"
      case "$retired_containers" in *"|$n|"*) continue;; esac
      probe "$n" no "\${target##*:}" "$health_path"
    done
  done <<< "$upstreams"
  # Installed extensions: the containers of each actual Compose bundle, read
  # together. A bundle without services or with an unsafe name fails the run.
  composes=()
  while IFS=$'\\t' read -r app root; do
    [ -n "$app" ] && [ ! -f "$root/retired" ] || continue
    compose="$root/current/compose.json"
    [ -f "$compose" ] || compose="$root/compose.json"
    if [ ! -f "$compose" ]; then
      printf 'two_extension_config_healthy{app="%s"} 0\\n' "$app"
      continue
    fi
    printf 'two_extension_config_healthy{app="%s"} 1\\n' "$app"
    composes+=("$compose")
  done <<< "$installed"
  if [ "\${#composes[@]}" -gt 0 ]; then
    targets=$(jq -r '[.services[].container_name] |
      if length > 0 and all(.[]; type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9_.-]*$"))
      then .[] else error("Invalid extension containers") end' "\${composes[@]}")
    while IFS= read -r n; do
      [ -z "$n" ] || probe "$n" no
    done <<< "$targets"
  fi
  `;
}
