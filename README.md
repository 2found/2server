# 2server

Deploy apps on your own VM with one App file and one release command.
2server manages Docker, Caddy, Cloudflare domains and optional services over SSH.
Configuration lives in your repository; secrets, deployment history and applied
state live on the VM. The CLI requires no resident control plane.

```sh
2server deploy -f api/2server/deploy.yaml --apply
```

Use an existing Debian/Ubuntu VM, or provision one on GCP or AWS. HTTP apps get
readiness-gated blue/green releases and traffic rollback. PostgreSQL, Redis, NATS,
monitoring and imgproxy are optional, named App templates.

[Quick start](#quick-start) · [App files](docs/source-config.md) ·
[Operator guide](docs/operator-guide.md) · [Release](docs/release.md) ·
[Roadmap](docs/roadmap.md)

## Install

Install **Bun >= 1.3** and **Node >= 20**, then:

```sh
npm install -g @2server/cli
2server help
```

Additional tools depend on the operation: Terraform for cloud provisioning,
`gcloud` for GCP IAP, `age` for encrypted control backups. Docker/build tooling is
needed locally only when building images. Registry pull authentication must work
for root on the VM.

## Quick start

Run from the repository containing your app. The VM must run Debian 12/13 or
Ubuntu 22.04/24.04, with Python 3, key-based SSH, a trusted host key and
passwordless sudo. For a new VM, follow [provisioning](docs/operator-guide.md#provisioning)
with `--output server.local.json`, then skip `init server` below.

**1. Prepare the server once.**

```sh
2server init server my-server -o server.local.json
# Edit its SSH connection (direct SSH or GCP IAP) and optional originIp.
2server server bootstrap -f server.local.json --apply
```

For Cloudflare domains, create a private `secrets.env` containing
`CLOUDFLARE_API_TOKEN`, set file mode `0600`, and add `--env-file secrets.env`
to bootstrap. The zone must already use Cloudflare nameservers; see
[required token permissions](docs/operator-guide.md#cloudflare-access-and-ownership).
Keep server files and secret files ignored by Git.

Bootstrap installs Docker/Caddy, publishes initial control state and saves the
private `.2server/connection.yaml`. It requires an empty server manifest and a VM
without published 2server state. On an already published VM, use `connect` instead.

**2. Define and deploy an app.**

```sh
2server init app api -o api/2server/deploy.yaml
# Edit image, port, healthPath, resource limits and domain.
# Remove domains if this app has no public hostname.
2server deploy -f api/2server/deploy.yaml --apply
```

The image must already be pushed. Deploy resolves its digest, waits for readiness,
switches traffic, then reconciles the file's domains and verifies public HTTPS.
Every subsequent release uses that same deploy command; pass `--image IMAGE`
to deploy the immutable digest produced by your build.

Apps needing secrets declare `spec.secrets` with `provider: vm`. Before deploying:

```sh
2server secret set --app api --env-file /private/api.env --apply
```

For schema migrations, use `spec.preDeploy.command` and optional task-only
`spec.preDeploy.secrets`; the runtime can keep its less privileged DB login.
See the [App and pre-deploy contract](docs/source-config.md).

## Daily operations

| Task | Command |
| --- | --- |
| List installed apps | `2server app` |
| Inspect an app | `2server app api get` |
| Read logs | `2server app api logs` |
| Validate a file offline | `2server validate -f api/2server/deploy.yaml` |
| Preview a release | `2server plan -f api/2server/deploy.yaml` |
| Deploy | `2server deploy -f api/2server/deploy.yaml --apply` |
| Roll back traffic | `2server app api rollback --apply` |
| Discover an app's commands | `2server app api help` |

Remote mutations require `--apply`. Bootstrap without it is an offline intent
check; App plans inspect the VM, registry and declared Cloudflare domains and may
pull image layers. Plans do not run migrations or prove health/write permissions.
A domain error after rollout can leave a healthy app release with unfinished DNS;
inspect the reported state before retrying.

## Extensions are apps

Choose an instance name; deploy and operate it like any other app:

```sh
2server init app orders-db --template postgres -o platform/orders-db.yaml
# Review the generated config and prepare its declared secrets privately.
2server secret set --app orders-db --env-file /private/orders-db.env --apply
2server deploy -f platform/orders-db.yaml --apply
2server app orders-db help
```

Templates: `postgres`, `redis`, `nats`, `monitoring`, `image-proxy`, `url-shortener`.
Only installed templates contribute extra commands to `app NAME help`:
PostgreSQL supplies backup/recovery, monitoring supplies webhook operations.
Core CLI help stays small. Multiple instances of one template have distinct names,
secrets and data paths.

`url-shortener` is the one template that does not run on the VM: it deploys a
Cloudflare Worker with a D1 database and a custom hostname, from the same
`plan`/`deploy -f FILE --apply` workflow and without opening an SSH session. See
[Worker apps](docs/extensions.md#worker-apps).

PostgreSQL backup is opt-in: configure it before relying on `app orders-db backup`.
Stateful apps update in place; restore uses an isolated target and deletion retains
data. See [PostgreSQL recovery](docs/postgres.md),
[template configuration and bindings](docs/source-config.md#apps-from-templates)
and [template authoring](docs/extensions.md).

## Secrets and recovery

The VM stores secrets in root-only control state and private release files.
This is a filesystem permission boundary; root/Docker administrators can read
runtime credentials. Connected commands use VM secrets, without local `.env`
fallback. Secret updates take effect when the affected workload is redeployed.

Connect from another machine and keep an encrypted copy off the VM:

```sh
2server connect --ssh ubuntu@vm.example --identity ~/.ssh/server_key
# GCP IAP: connect --connection FILE containing the structured GCP SSH settings.
2server server backup --output server.age --recipient-file recipients.txt
```

Control backups contain config, secrets and certificates. Database/volume data,
Terraform state and the private age identity need their own recovery plan.
See [control state and recovery](docs/control-state.md).

## Operating limits

- One VM is one failure domain. Replicas and traffic rollback do not provide
  host-level HA or reverse database migrations. Allow capacity for both app
  generations during a rollout.
- Monitoring discovers installed workloads and provides alerts. External delivery
  needs a receiver; whole-VM outages need an external monitor with notifications.
- Bridge containers cannot access cloud metadata unless explicitly allowed with
  `spec.labels.cloud-metadata: allow`; that grants the VM's shared cloud identity.
  See [workload identity boundaries](docs/operator-guide.md#applications).
- Cloudflare Workers are a shipped App runtime for the `url-shortener` template;
  portable object storage and a managed Soot template remain
  [proposed next steps](docs/roadmap.md).

Shared Cloudflare rate limits and optional `spec.cacheRules` use a `kind: Zone` file. Run
`2server apply -f platform/cloudflare-zone.yaml --apply` to reconcile that zone
without restarting apps. The CLI checks plan capacity and preserves foreign
rules. Turnstile is application-owned. See [zone policy](docs/source-config.md#cloudflare-zone-policy).

## Docs and development

| Need | Read |
| --- | --- |
| Provisioning, DNS, Compose adoption, compatibility commands | [Operator guide](docs/operator-guide.md) |
| Health, alerts, failure recovery and capacity | [Reliability](docs/reliability.md) |
| Config schemas and release behavior | [Source configuration](docs/source-config.md) |
| Module ownership and local checks | [Architecture](docs/architecture.md), [development](docs/development.md) |
| Package verification and publishing | [Release runbook](docs/release.md), [changelog](CHANGELOG.md) |
| Workers, storage adapters and Soot research | [Roadmap](docs/roadmap.md) |

For source development, run `bun install --frozen-lockfile` then `bun run check`.
Use `bun src/cli.ts` in place of `2server`. `bun run release:check` tests, packs
and smoke-tests the npm artifact without publishing it.

The [2server agent skill](skills/2server/SKILL.md) follows the same CLI and source
files. Link `skills/2server` from a retained checkout into your agent's skill
directory and invoke `$2server`; its helper scripts import the product code.

Package license is currently **UNLICENSED**. Public npm availability does not
grant an open-source license; see the [release decision](docs/release.md#license).
