# VM lifecycle and connection

## Declare the connection once

The manifest's `ssh` object is the authoritative connection declaration.
`src/process.ts:sshArgs` derives the command used by all remote operations.
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

## Provision or adopt

For an existing VM, inspect it through the declared connection, choose
`edge.mode: "existing"` for the existing Compose Caddy or `"managed"` for a new
edge, then validate and run `setup --apply`. Existing-mode adoption can recreate
Caddy once; review its Compose mount/import changes and retain them in the
owning repository. Do not replace another manifest's edge owner.

For a new VM, inspect `terraform/gcp/main.tf` or `terraform/aws/main.tf`, prepare
an ignored tfvars file, and use:

```bash
bun src/cli.ts provision gcp server.tfvars
bun src/cli.ts provision gcp server.tfvars --apply
# Substitute aws for EC2.
```

Read the resulting plan for creates, replacements and deletes. For AWS, verify
the region, AMI owner/OS/architecture, public key and restricted operator CIDRs.
The initial AWS root requires a verified Debian/Ubuntu amd64 AMI. GCP uses OS
Login/IAP. Both roots reserve an address and restrict web ingress to Cloudflare.

The CLI stores Terraform state under
`~/.local/state/2server/terraform/<provider>/<sha256-of-absolute-tfvars-path[0:16]>/terraform.tfstate`.
Keep the tfvars path stable; moving it selects different state. Reuse the exact
state for output, refresh and future applies; never initialize a second state
for the same VM. Read outputs with `terraform -chdir=terraform/<provider> output
-state=<absolute-state-path> -json`; copy GCP `ssh` output or AWS `ssh_host` plus
the known login/key into the manifest. Record cloud account, region/zone and
instance ID in the deployment's operator runbook; the AWS SSH address alone is
not sufficient identity for stopping an instance.

Then run `validate`, `setup --apply`, app deployment, enabled `extensions --apply`,
`domains --apply`, and `verify`, as applicable. No enabled monitoring? Skip the
extension step. Retain the verified connection and manifest for CI.

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
and provider deletion protection. Prepare a resource-specific data-retention
and DNS-retirement plan before changing those protections; never map shutdown
to `terraform destroy` or terminate-instances.

Provider references: [GCP stop](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/stop),
[AWS stop](https://awscli.amazonaws.com/v2/documentation/api/latest/reference/ec2/stop-instances.html).
