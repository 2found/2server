# VM lifecycle and connection

## Declare the connection once

For normal operations, use ignored `.2server/connection.yaml` or explicit SSH
flags; see [control state](control-state.md). The manifest's `ssh` object retains
bootstrap/provider identity.
`src/shared/infrastructure/process.ts:sshArgs` derives the command used by all remote operations.
Use structured fields, not an arbitrary shell command string in JSON.

GCP (IAP and OS Login):

```json
"ssh": {
  "kind": "gcp", "project": "example-project",
  "zone": "asia-southeast1-a", "instance": "two-server", "iap": true
}
```

AWS EC2 or another VM reachable with SSH:

```json
"ssh": {
  "kind": "ssh", "host": "203.0.113.10", "user": "ubuntu",
  "port": 22, "identityFile": "/absolute/private/path/operator.pem"
},
"originIp": "203.0.113.10"
```

Choose the login user from the actual AMI/OS; do not assume `ubuntu` on Debian.
Use an SSH config alias with `ProxyJump` when needed; explicitly set `originIp`
to the public service address, not the jump host. The existing adapter does not
support AWS SSM sessions. If the user supplies an SSM/custom wrapper connection,
implement and test a structured transport adapter before using it; do not
pretend it is plain SSH or interpolate an untrusted shell string.

The bundled helper prints a safely quoted read-only connectivity command without
running it (from the product root):

```bash
bun skills/2server/scripts/ssh-command.ts server.local.json
```

Its default remote command is `sudo -n true`. A second argument replaces that
remote command. Review the printed command and run it through the normal shell
execution tool when connectivity checking is in scope. Host keys must already
be trusted from a verified source; never disable strict host-key checking.
GCP needs authenticated gcloud, IAP access and OS Login sudo rights. Direct SSH
needs a key/agent and passwordless sudo. A failure here is not a reason to alter
cloud firewalls broadly.

GCP provisioning keeps VM IAM empty unless `workload_access` grants named
resources. Use `terraform/gcp/access` for an existing VM's scoped IAM; never
apply the compute root over it without import. GCS URL signing needs Token
Creator on the VM service account itself, not on the project.

Setup installs Docker metadata isolation. Apps needing the VM cloud identity
must declare `spec.labels.cloud-metadata: allow` in source and applied state; other apps
default to deny. Before adopting an existing host, inventory its cloud-dependent
workloads and prepare the root-only `metadata-allow.json` migration list described
in `docs/operator-guide.md#applications`. Host-network jobs retain host identity access. Runtime updates and
reboots remain deliberate maintenance; bootstrap no longer creates permanent
Docker package holds, and existing holds require explicit review/removal.

## Provision or adopt

For an existing VM, inspect it through the declared connection, choose
`edge.mode: "existing"` for the existing Compose Caddy or `"managed"` for a new
edge, then validate and run `setup --apply`. Existing-mode adoption can recreate
Caddy once; review its Compose mount/import changes and retain them in the
owning repository. Do not replace another manifest's edge owner.

For a new VM, use the provider root and an ignored tfvars file:

```bash
2server provision gcp /stable/path/server.tfvars --output server.local.json
2server provision gcp /stable/path/server.tfvars --output server.local.json --apply
# AWS: add --ssh-user matching the verified AMI (e.g. ubuntu).
2server server bootstrap -f server.local.json --env-file /private/server.env
2server server bootstrap -f server.local.json --env-file /private/server.env --apply
```

Review Terraform creates/replacements/deletes. `--output` writes a private
manifest from actual outputs only after apply; it refuses overwrite. It includes
provider identity and disks, so do not manually copy outputs or guess IPs.
Verify/trust the new SSH host key before bootstrap; direct SSH uses your agent,
SSH config, or the manifest's identityFile. The VM needs Python 3 and sudo.
Bootstrap requires an empty manifest; install reviewed Extension/App files next.
`init app NAME -o app/2server/deploy.yaml` includes a domain; one deploy applies
both after readiness. For an existing published VM, connect instead of bootstrap.

Terraform state is under the path printed by provision:
`~/.local/state/2server/terraform/<provider>/<sha256-of-absolute-tfvars-path[0:16]>/terraform.tfstate`.
Keep the tfvars path stable and back up state separately. Moving the path selects
new state and can duplicate infrastructure. Never apply a new root over an
existing VM without an explicit import/state migration. Without `--output`,
read outputs with `terraform -chdir=terraform/<provider> output
-state=<absolute-state-path> -json`. GCP uses IAP; AWS needs a verified
Debian/Ubuntu amd64 AMI, public key and restricted operator CIDRs.

## Shutdown and restart

Interpret shutdown as a graceful **stop** retaining disks and configuration.
Stop every workload on that VM only when that VM is the requested target;
inspect its current workload list and pause any CI schedule that would restart
or mutate it. Inventory attached disks and local/ephemeral storage before a
stop; do not choose a discard/force flag implicitly.

GCP, using the manifest identity:

```bash
gcloud compute instances stop INSTANCE --project=PROJECT --zone=ZONE
gcloud compute instances describe INSTANCE --project=PROJECT --zone=ZONE --format='value(status)'
# Restart when requested:
gcloud compute instances start INSTANCE --project=PROJECT --zone=ZONE
```

AWS: verify the account with STS, resolve the exact instance ID from the recorded
state/runbook and confirm it with `describe-instances` in the selected region:

```bash
aws ec2 stop-instances --instance-ids INSTANCE_ID --region REGION
aws ec2 wait instance-stopped --instance-ids INSTANCE_ID --region REGION
# Restart when requested:
aws ec2 start-instances --instance-ids INSTANCE_ID --region REGION
aws ec2 wait instance-running --instance-ids INSTANCE_ID --region REGION
```

For an unmanaged SSH VM with no cloud lifecycle API, use `sudo systemctl poweroff`
through the declared transport. SSH disconnection alone is not proof that it
powered off; use the provider console/status API where available, otherwise
report shutdown requested and final power state unverified. After restart check
SSH, container health, origin address, and public HTTPS before restoring CI.
Stopped VMs can retain storage/address charges. Destruction is a separate
explicit request: the Terraform roots deliberately enable `prevent_destroy`
for data disks and provider deletion protection for VMs. Prepare a resource-specific data-retention
and DNS-retirement plan before changing those protections; never map shutdown
to `terraform destroy` or terminate-instances.

Provider references: [GCP stop](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/stop),
[AWS stop](https://awscli.amazonaws.com/v2/documentation/api/latest/reference/ec2/stop-instances.html).

## Resource CLI

Use `get vm`, `get-log vm`, `start vm`, `stop vm` and `reload vm` with `-f server.local.json`; mutations need
`--apply`. For AWS, add `vm: {kind: "aws", region, instanceId}` from Terraform
outputs; SSH remains declared separately. `create vm gcp|aws -f original.tfvars`
and `update vm` reuse the provisioning workflow. `delete vm` plans destruction
of that isolated Terraform root, not an arbitrary SSH host. Default provider
protection rejects deletion; for authorized destruction, set `allow_destroy =
true` in the same tfvars and apply the reviewed update first. Data disks retain
`prevent_destroy` and require a deliberate data/state retention procedure before
a root can be destroyed. Never remove that protection just to pass the command.

`get monitor -f ...` reads CPU/memory/disk/container usage and backup timer state.
See [Stateful services](stateful.md) for separate provider disks and online growth.

`reload vm` stops then starts the selected provider instance, so it interrupts
all workloads on that VM. `scale vm gcp|aws -f original.tfvars --apply` applies a
reviewed machine-type change from Terraform; stop the VM first if required by
its provider. Keep the same Terraform state and verify app health after restart.
