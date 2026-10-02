import { quote,remote,run } from "../../../shared/infrastructure/process";
import type { Config } from "../../config/application/config";
export const vmOperations = { run, remote };
export function vmArgs(c: Config, action: "get" | "start" | "stop") {
  if (c.ssh.kind === "gcp")
    return [
      "gcloud",
      "compute",
      "instances",
      action === "get" ? "describe" : action,
      c.ssh.instance,
      `--project=${c.ssh.project}`,
      `--zone=${c.ssh.zone}`,
      "--format=json",
      "--quiet",
    ];
  if (c.vm)
    return [
      "aws",
      "ec2",
      action === "get" ? "describe-instances" : `${action}-instances`,
      "--instance-ids",
      c.vm.instanceId,
      "--region",
      c.vm.region,
      "--output",
      "json",
    ];
  throw new Error(
    "Cloud lifecycle requires GCP ssh identity or vm: {kind: aws, region, instanceId}; direct SSH alone cannot verify power state",
  );
}
export async function vmAction(
  c: Config,
  action: "get" | "start" | "stop",
  ops = vmOperations,
) {
  const result = JSON.parse(await ops.run(vmArgs(c, action)));
  if (action !== "get") {
    if (c.vm)
      await ops.run([
        "aws",
        "ec2",
        "wait",
        action === "start" ? "instance-running" : "instance-stopped",
        "--instance-ids",
        c.vm.instanceId,
        "--region",
        c.vm.region,
      ]);
    return vmAction(c, "get", ops);
  }
  if (c.ssh.kind === "gcp")
    return {
      name: result.name,
      status: result.status,
      machineType: result.machineType,
      disks: result.disks?.map((d: any) => ({
        source: d.source,
        boot: d.boot,
        autoDelete: d.autoDelete,
      })),
    };
  const vm = result.Reservations?.[0]?.Instances?.[0];
  if (!vm || vm.InstanceId !== c.vm?.instanceId)
    throw new Error("Provider returned unexpected VM identity");
  return {
    id: vm.InstanceId,
    state: vm.State?.Name,
    type: vm.InstanceType,
    publicIp: vm.PublicIpAddress,
    disks: vm.BlockDeviceMappings,
  };
}
export type Disk = Config["disks"][number];
export async function inspectDisk(
  c: Config,
  d: Disk,
  ops = vmOperations,
): Promise<{ sizeGb: number; deviceCheck: string }> {
  const p = d.provider;
  if (p.kind === "gcp") {
    if (
      c.ssh.kind !== "gcp" ||
      p.project !== c.ssh.project ||
      p.zone !== c.ssh.zone
    )
      throw new Error("Disk project/zone does not match the VM");
    const vm = JSON.parse(await ops.run(vmArgs(c, "get")));
    const attachment = vm.disks?.find((a: any) =>
      a.source.endsWith(`/zones/${p.zone}/disks/${p.disk}`),
    );
    if (!attachment || attachment.boot)
      throw new Error("Disk must be a non-boot disk attached to this VM");
    const disk = JSON.parse(
      await ops.run([
        "gcloud",
        "compute",
        "disks",
        "describe",
        p.disk,
        `--project=${p.project}`,
        `--zone=${p.zone}`,
        "--format=json",
      ]),
    );
    if (!/^[a-zA-Z0-9_-]+$/.test(attachment.deviceName))
      throw new Error("Invalid provider device name");
    return {
      sizeGb: Number(disk.sizeGb),
      deviceCheck: `test "$(readlink -f ${quote(d.device)})" = "$(readlink -f /dev/disk/by-id/google-${attachment.deviceName})"`,
    };
  }
  if (!c.vm || c.vm.instanceId !== p.instanceId || c.vm.region !== p.region)
    throw new Error("Disk instance/region does not match vm identity");
  const result = JSON.parse(
    await ops.run([
      "aws",
      "ec2",
      "describe-volumes",
      "--volume-ids",
      p.volumeId,
      "--region",
      p.region,
      "--output",
      "json",
    ]),
  );
  const volume = result.Volumes?.[0];
  if (
    volume?.VolumeId !== p.volumeId ||
    volume.Attachments?.length !== 1 ||
    volume.Attachments[0].InstanceId !== p.instanceId ||
    volume.Attachments[0].State !== "attached"
  )
    throw new Error("Volume must be attached exclusively to this VM");
  const vm = JSON.parse(await ops.run(vmArgs(c, "get"))).Reservations?.[0]
    ?.Instances?.[0];
  if (vm?.RootDeviceName === volume.Attachments[0].Device)
    throw new Error("Refusing root disk operation");
  // Nitro exposes the immutable EBS volume ID as the NVMe serial; never trust /dev/nvmeN order.
  return {
    sizeGb: Number(volume.Size),
    deviceCheck: `test "$(lsblk -dn -o SERIAL ${quote(d.device)} | tr -d ' -')" = ${quote(p.volumeId.replaceAll("-", ""))}`,
  };
}
export function diskPreflight(d: Disk, deviceCheck: string, mounted = true) {
  return `set -euo pipefail
${deviceCheck}
test -b ${quote(d.device)}
test "$(lsblk -dn -o TYPE ${quote(d.device)})" = disk
# Whole-disk filesystems only: partitioned/LVM/encrypted layouts need a specific adapter.
test "$(lsblk -nr -o NAME ${quote(d.device)} | wc -l | tr -d ' ')" = 1
${
  mounted
    ? `mountpoint -q ${quote(d.mountPath)}
test "$(readlink -f "$(findmnt -n -o SOURCE --target ${quote(d.mountPath)})")" = "$(readlink -f ${quote(d.device)})"
case "$(findmnt -n -o FSTYPE --target ${quote(d.mountPath)})" in ext4|xfs) ;; *) exit 1;; esac`
    : ""
}
`;
}
export async function initializeDisk(c: Config, d: Disk, ops = vmOperations) {
  const inspected = await inspectDisk(c, d, ops);
  await ops.remote(
    c,
    `${diskPreflight(d, inspected.deviceCheck, false)}
exec 5>/var/lock/2server-disk-${d.name}.lock
flock -w 120 5
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
if mountpoint -q ${quote(d.mountPath)}; then
  test "$(readlink -f "$(findmnt -n -o SOURCE --target ${quote(d.mountPath)})")" = "$(readlink -f ${quote(d.device)})"
  exit 0
fi
test -z "$(lsblk -dn -o MOUNTPOINTS ${quote(d.device)})"
test -z "$(wipefs -n --noheadings ${quote(d.device)})"
mkdir -p ${quote(d.mountPath)}
test -z "$(ls -A ${quote(d.mountPath)})"
if grep -F ${quote(" " + d.mountPath + " ")} /etc/fstab; then echo 'Mount already declared in fstab' >&2; exit 1; fi
# No -F: mkfs refuses to overwrite detected filesystems.
mkfs.ext4 ${quote(d.device)} >/dev/null
uuid=$(blkid -s UUID -o value ${quote(d.device)})
test -n "$uuid"
if grep -F ${quote(" " + d.mountPath + " ")} /etc/fstab; then echo 'Mount already declared in fstab' >&2; exit 1; fi
printf 'UUID=%s ${d.mountPath} ext4 defaults 0 2\\n' "$uuid" >> /etc/fstab
systemctl daemon-reload
mount ${quote(d.mountPath)}
`,
  );
}
export async function resizeDisk(
  c: Config,
  d: Disk,
  sizeGb: number,
  ops = vmOperations,
) {
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536)
    throw new Error("--size-gb must be 1..65536");
  const before = await inspectDisk(c, d, ops);
  if (sizeGb < before.sizeGb)
    throw new Error("Disk shrinking is not supported");
  await ops.remote(c, diskPreflight(d, before.deviceCheck));
  if (sizeGb > before.sizeGb) {
    const p = d.provider;
    await ops.run(
      p.kind === "gcp"
        ? [
            "gcloud",
            "compute",
            "disks",
            "resize",
            p.disk,
            `--project=${p.project}`,
            `--zone=${p.zone}`,
            `--size=${sizeGb}GB`,
            "--quiet",
          ]
        : [
            "aws",
            "ec2",
            "modify-volume",
            "--volume-id",
            p.volumeId,
            "--size",
            String(sizeGb),
            "--region",
            p.region,
          ],
    );
  }
  await ops.remote(
    c,
    `${diskPreflight(d, before.deviceCheck)}
exec 5>/var/lock/2server-disk-${d.name}.lock
flock -w 120 5
ready=false
for attempt in $(seq 1 60); do
  if [ "$(blockdev --getsize64 ${quote(d.device)})" -ge ${sizeGb * 1024 ** 3} ]; then ready=true; break; fi
  sleep 2
done
[ "$ready" = true ] || { echo 'Provider resize requested; guest has not observed it yet. Retry resize to finish filesystem growth.' >&2; exit 1; }
case "$(findmnt -n -o FSTYPE --target ${quote(d.mountPath)})" in
  ext4) resize2fs ${quote(d.device)};;
  xfs) xfs_growfs ${quote(d.mountPath)};;
esac
df -h ${quote(d.mountPath)}
`,
  );
}
