import type { Config, Webhook } from "../../config";

export function hasAlertReceivers(c: Config): boolean {
  return !!c.extensions.alertWebhookEnv || c.extensions.webhooks.some(w => w.enabled);
}
export function discordUrl(w: Webhook): string {
  const value = process.env[w.urlEnv];
  if (!value)
    throw new Error(`Set ${w.urlEnv} in the ignored 2server/.env (chmod 600); copy the Discord channel's webhook URL there. Never put it in the manifest or CLI arguments.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid Discord webhook URL in ${w.urlEnv}`); }
  if (value !== value.trim() || /[\x00-\x20\x7f]/.test(value) || value.length > 2048 ||
      url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
      !["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"].includes(url.hostname) ||
      !/^\/api\/(?:v[0-9]+\/)?webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(url.pathname))
    throw new Error(`Invalid Discord webhook URL in ${w.urlEnv}; expected an HTTPS Discord /api/webhooks/ID/TOKEN URL without query parameters`);
  return url.toString();
}
export function alertmanagerConfig(c: Config) {
  const receiver: Record<string, unknown> = { name: "operator" };
  if (c.extensions.alertWebhookEnv) {
    const url = process.env[c.extensions.alertWebhookEnv];
    if (!url || !URL.canParse(url) || new URL(url).protocol !== "https:")
      throw new Error("Alert webhook must be an HTTPS secret environment value");
    receiver.webhook_configs = [{ url, send_resolved: true }];
  }
  const active = c.extensions.webhooks.filter(w => w.enabled);
  if (active.length) receiver.discord_configs = active.map(w => ({
    webhook_url: discordUrl(w),
    send_resolved: w.sendResolved,
    username: "2server",
    title: `[${c.name}] {{ .Status | toUpper }}: {{ .CommonLabels.alertname }}`,
    message: '{{ range .Alerts }}**{{ .Labels.alertname }}**{{ if .Labels.container }} — {{ .Labels.container }}{{ end }}{{ if .Annotations.summary }}\n{{ .Annotations.summary }}{{ end }}\n{{ end }}',
    http_config: { follow_redirects: false },
  }));
  return {
    route: { receiver: "operator", group_by: ["alertname"], group_wait: "30s", group_interval: "5m", repeat_interval: "4h" },
    receivers: [receiver],
  };
}

// Sends one direct message from the operator machine, not an alert routed by
// the VM. Never automatically retry an ambiguous send (it could duplicate).
export type WebhookFetch = (url: URL, init: RequestInit) => Promise<Response>;
export async function testWebhook(c: Config, w: Webhook, fetcher: WebhookFetch = fetch) {
  const url = new URL(discordUrl(w));
  url.searchParams.set("wait", "true");
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "2server",
        content: `2server test: server=${c.name}, webhook=${w.name}. This is a test notification.`,
        allowed_mentions: { parse: [] },
      }),
    });
  } catch {
    throw new Error(`Discord test ${w.name}: connection, TLS, redirect or timeout failure; delivery status is unknown. Check the channel before retrying.`);
  }
  if (response.status === 429) {
    const after = response.headers.get("retry-after");
    await response.body?.cancel();
    throw new Error(`Discord test ${w.name}: rate limited (429)${after && /^[0-9]+(?:\.[0-9]+)?$/.test(after) ? `; retry after ${after}s` : ""}. No automatic retry.`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Discord test ${w.name}: HTTP ${response.status}; ${[401,403,404].includes(response.status) ? "check the webhook URL/permissions or whether it was deleted" : "message delivery was not confirmed"}`);
  }
  let result: unknown;
  try { result = await response.json(); } catch {}
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !/^[0-9]+$/.test(result.id))
    throw new Error(`Discord test ${w.name}: message confirmation missing; check the channel before retrying`);
  return { webhook: w.name, provider: w.provider, messageId: result.id, sentFrom: "operator" };
}
