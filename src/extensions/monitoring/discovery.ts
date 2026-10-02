import type { Config } from '../../config';

// The monitoring extension owns discovery. Read desired names from the existing
// control config and expected containers from each app's actual Compose bundle.
// Never enumerate only running containers: missing containers must still alert.
export function extensionDiscovery(c: Config): string {
  return `
  observe_extension() {
    local app="$1" root="$2" compose targets n
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
  config=/opt/2server/control/current/server.json
  if [ -f "$config" ]; then
    # Parse once so an atomic control revision change cannot mix install states.
    installed=$(jq -er --arg server '${c.name}' '
      if .version == 1 and .name == $server then [
        ((.extensionApps // {}) | keys[] | [., "/opt/2server/extensions/" + .]),
        ((.extensions.services // {}) | keys[] | [., "/opt/2server/extensions/" + .]),
        ((.extensions // {}) | to_entries[] |
          select(.value and (.key != "services" and .key != "webhooks" and .key != "alertWebhookEnv")) |
          [.key, (if .key == "monitoring" then "/opt/2server/monitoring"
            elif .key == "imageProxy" then "/opt/2server/imgproxy"
            else "/opt/2server/extensions/" + .key end)])
      ] | if all(.[]; .[0] | test("^[a-z][a-zA-Z0-9-]*$"))
        then map(@tsv) | join("\\n") else error("Invalid extension names") end
      else error("Invalid monitoring control config") end' "$config")
    while IFS=$'\\t' read -r app root; do
      [ -z "$app" ] || observe_extension "$app" "$root"
    done <<< "$installed"
  fi`;
}
