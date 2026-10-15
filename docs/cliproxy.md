# AI gateway (CLIProxyAPI)

Give this prompt to a coding agent in the repository owning your infrastructure:

```text
Read the installed 2server docs/cliproxy.md. Prepare a named ai App from the
cliproxy template on my existing connected VM, with one client key per consuming
app and the model aliases they request. Show me the source manifest and the
exact operator commands. Do not apply, sign in accounts or print credential values.
```

The `cliproxy` template runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
a single Go binary that serves OpenAI-, Claude- and Gemini-compatible APIs over
provider accounts signed in with OAuth (Codex, Antigravity, Claude, xAI, Kimi).
Apps call it like any OpenAI-compatible endpoint; the gateway picks an account,
refreshes its tokens and retries another account when one fails.

The template pins `eceasy/cli-proxy-api:v8.0.29` and runs it unprivileged with a
read-only root and a 256 MiB limit. An idle instance uses about 20 MiB of memory
and no measurable CPU. Its web control panel, file logs, request logs, usage
statistics and plugins are off; the management API answers only inside the
container, and the `app` commands below reach it there.

## Install on an existing VM

Prepare a private env file outside Git with two random single-line values of
20–72 characters from `A–Z a–z 0–9 _ . : + / = -`:

- `CLIPROXY_CLIENT_KEY`: the bearer key an app sends.
- `CLIPROXY_MANAGEMENT_KEY`: used only by the `app` commands. Only its bcrypt
  hash reaches the container.

```sh
2srv init app ai --template cliproxy -o platform/ai.yaml
2srv validate -f platform/ai.yaml
2srv secret set --app ai --env-file /private/ai.env --apply
2srv plan -f platform/ai.yaml
2srv deploy -f platform/ai.yaml --apply
2srv app ai help
```

An example source with one key per consuming app and three aliases:

```yaml
apiVersion: 2server.app/v1
kind: App
metadata: {name: ai}
template: cliproxy
spec:
  clientKeyEnv: [AI_KEY_WEB, AI_KEY_WORKER]
  managementKeyEnv: CLIPROXY_MANAGEMENT_KEY
  routing: round-robin
  models:
  - {alias: fast, channel: antigravity, name: gemini-3.8-flash}
  - {alias: smart, channel: codex, name: gpt-5.6}
  - {alias: smart, channel: xai, name: grok-4.6}
  excludedModels:
  - {channel: antigravity, pattern: '*-image*'}
secrets:
  AI_KEY_WEB: {provider: vm, key: AI_KEY_WEB}
  AI_KEY_WORKER: {provider: vm, key: AI_KEY_WORKER}
  CLIPROXY_MANAGEMENT_KEY: {provider: vm, key: CLIPROXY_MANAGEMENT_KEY}
```

Each `clientKeyEnv` entry needs its own value, different from the management
key. Rotating one app's key is a `secret set` plus a deploy; the other apps keep
working. Accounts live in `/opt/2server/data/ai/auths` (mode 0700) and survive
redeploys; the config file is regenerated from the source on every deploy, so
edit the source, not the VM.

## Models and routing

Clients request upstream model names, or an `alias` you declare per channel.
`fork: true` keeps the upstream name requestable next to the alias.

- One alias resolves to one upstream model on each channel. Declaring it twice
  on the same channel is rejected.
- The same alias on several channels pools their accounts. A failing account is
  retried on the next one, up to `requestRetry` times.
- `routing: round-robin` spreads requests across the ready accounts of the
  highest priority. `fill-first` uses one account until it fails or hits its
  limit.
- Priority makes a fallback. Every account starts at 0; requests go to the
  highest priority that has a ready account, on any channel. Give the accounts
  of a slower or costlier model a lower priority and the alias uses them only
  while every higher one is cooling down or failing:

  ```sh
  2srv app ai priority xai-me.json -10 --apply
  ```

- An account that answers 429 or a quota error cools down until the time the
  provider gives. Cooldowns are saved beside the accounts, so a deploy or
  restart does not send requests to accounts whose quota is already spent.
- A stream that fails before its first byte reaches the client is retried on
  another account once (`streamBootstrapRetries`, default 1).
- Request bodies over `maxRequestBodyMb` (default 32) answer 413.

Upstream models differ in the request fields they accept. Before pointing an
alias at a new model, send it the shapes your apps use, such as
`response_format` or tools; a model that rejects one answers 400.

`app ai models` prints exactly what clients can request, aliases included.

## Accounts

```sh
2srv app ai accounts                       # name, provider, label, state; never tokens
2srv app ai login codex --apply            # also: antigravity, claude, xai, kimi
2srv app ai import --file /private/codex-me.json --apply
2srv app ai priority codex-me.json 5 --apply  # higher is tried first (default 0)
2srv app ai disable codex-me.json --apply  # stop routing, keep tokens
2srv app ai enable codex-me.json --apply
2srv app ai remove codex-me.json --apply   # delete the account and its tokens
```

`login` prints the provider's sign-in address. Codex, Antigravity, Claude and
Kimi then redirect the browser to `http://localhost:PORT/...`; the command
listens on that port on your machine and forwards the redirect to the gateway.
If the browser runs on another machine, or the port is taken, paste the address
the browser ends on (it may show a connection error). xAI uses a device code
instead, which the command prints. The command waits up to five minutes for the
gateway to store the account.

`import` uploads an auth file in CLIProxyAPI's format. The file must be private
(`chmod 600`), JSON with a provider `type`, and named `*.json`; an account with
the same name is replaced. Most providers rotate refresh tokens: an account
active in two gateways at once logs one of them out. Move an account (sign in
again, or import and then stop the old gateway), do not copy it.

Without `--apply`, mutating commands print what they would do. With it, they
hold the instance's deploy lock, so they never interleave with a deploy of the
same app. Keys travel on stdin to a private temp directory on the VM, never in
arguments or the process list.

## Clients

No host port is published. Apps on the VM's 2server network bind the endpoint:

```yaml
bindings:
  AI_BASE_URL: {extension: ai, output: endpoint}
```

The endpoint is `http://two-SERVER_NAME-ai:8317`; OpenAI SDKs use
`$AI_BASE_URL/v1` with their client key. Internal traffic does not leave the VM.

For clients elsewhere, add an HTTPS Domain. The example server is named
`example`; substitute your server and zone:

```yaml
apiVersion: 2server.app/v1
kind: Domain
metadata: {name: ai}
spec:
  zone: example.com
  hosts: [ai.example.com]
  cache: app
  upstream: {kind: proxy, target: 'two-example-ai:8317'}
```

Every request still needs a client key. `streamKeepaliveSeconds` (default 15)
sends SSE comments while a started stream is idle, so proxies with an idle
timeout (Cloudflare: 100 s) keep long streams open. A non-streaming request
that takes longer than such a timeout fails at the proxy; apps on the VM should
use the internal endpoint. After adding a Domain,
check one streaming request end to end.

## Upgrade and retirement

Bump `image` in the source and deploy; the release is verified with an
authenticated `GET /v1/models` before it becomes current, and the previous
release is restored if it fails. Restarting or deleting the App keeps its
accounts. `2srv app ai delete --purge --apply` removes everything, including
the accounts and the app's VM secrets; see
[extension purge](extensions.md#removing-an-app-completely). Delete or reroute
its Domain first.
