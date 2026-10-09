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
  observe_extension() {
    local app="$1" root="$2" compose targets n
    [ ! -f "$root/retired" ] || return 0
    compose="$root/current/compose.json"
    [ -f "$compose" ] || compose="$root/compose.json"
    if [ ! -f "$compose" ]; then
      printf 'two_extension_config_healthy{app="%s"} 0\\n' "$app"
      return
    fi
    targets=$(jq -er '[.services[].container_name] |
      if length > 0 and all(.[]; type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9_.-]*$"))
      then join("\\n") else error("Invalid extension containers") end' "$compose")
    printf 'two_extension_config_healthy{app="%s"} 1\\n' "$app"
    while IFS= read -r n; do probe "$n" no; done <<< "$targets"
  }
  retired_containers="|"
  retired_upstreams="|"
  # Retained generation contracts identify intentionally removed managed apps.
  # Do not infer retirement merely because Docker cannot find a container.
  for root in /opt/2server/apps/*; do
    [ ! -f "$root/current" ] || continue
    app="\${root##*/}"
    [[ "$app" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
    for color in blue green; do
      saved="$root/$color.json"
      [ -f "$saved" ] || continue
      retired=$(jq -cer --arg server '${c.name}' --arg app "$app" --arg color "$color" '
        {containers: (if .compose then [.compose.containers[]]
          else [range(1; ((.replicas // 1) + 1)) | "two-" + $server + "-" + $app + "-" + $color + (if . == 1 then "" else "-" + tostring end)] end),
         upstream: (.compose.upstreamFile // "")}' "$saved")
      while IFS= read -r n; do
        [ -z "$n" ] || retired_containers="$retired_containers$n|"
      done <<< "$(jq -r '.containers[]' <<< "$retired")"
      file=$(jq -r .upstream <<< "$retired")
      [ -z "$file" ] || retired_upstreams="$retired_upstreams$file|"
    done
  done
  for root in /opt/2server/extensions/*; do
    [ -f "$root/retired" ] || continue
    compose="$root/current/compose.json"
    [ -f "$compose" ] || compose="$root/compose.json"
    [ -f "$compose" ] || continue
    targets=$(jq -er '[.services[].container_name] | join("\\n")' "$compose")
    while IFS= read -r n; do
      [ -z "$n" ] || retired_containers="$retired_containers$n|"
    done <<< "$targets"
  done
  config=/opt/2server/control/current/server.json
  observers=${quote(JSON.stringify(fallback))}
  installed=""
  if [ -f "$config" ]; then
    # Read inventory and this collector's observers in one atomic revision.
    snapshot=$(jq -cer --arg server '${c.name}' --arg instance ${quote(c.instance?.name ?? '')} '
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
      else error("Invalid monitoring control config") end' "$config")
    observers=$(jq -c .observers <<< "$snapshot")
    installed=$(jq -r '.installed | map(@tsv) | join("\\n")' <<< "$snapshot")
  fi
  # Explicit observations follow current configuration, with managed retirement
  # taking precedence over a stale compatibility observer.
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$retired_containers" in *"|$n|"*) continue;; esac
    probe "$n" no
  done <<< "$(jq -r '.containers[]' <<< "$observers")"
  upstreams=$(jq -c '.upstreams[]' <<< "$observers")
  while IFS= read -r upstream; do
    [ -n "$upstream" ] || continue
    file=$(jq -r .file <<< "$upstream")
    case "$retired_upstreams" in *"|$file|"*) continue;; esac
    name=$(jq -r .name <<< "$upstream")
    health_path=$(jq -r '.healthPath // "/healthz"' <<< "$upstream")
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
    while IFS=$'\\t' read -r app root; do
      [ -z "$app" ] || observe_extension "$app" "$root"
    done <<< "$installed"
  `;
}
