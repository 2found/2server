import type { Config } from "./config";
export function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export async function run(
  args: string[],
  input?: string | Uint8Array,
): Promise<string> {
  const p = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : new Blob([input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, , code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  // Commands may handle secrets: never include argv, stdout or stderr in errors.
  if (code !== 0)
    throw new Error(
      `${args[0]} failed (exit ${code}); inspect the operation on the target, no secret output logged`,
    );
  return out;
}
let sessionTransport: Config['ssh'] | undefined;
export function setSshTransport(ssh?: Config['ssh']) { sessionTransport = ssh; }
export function sshArgs(config: Config, command: string): string[] {
  const s = sessionTransport ?? config.ssh;
  if (s.kind === "gcp")
    return [
      "gcloud",
      "compute",
      "ssh",
      s.instance,
      `--project=${s.project}`,
      `--zone=${s.zone}`,
      ...(s.iap ? ["--tunnel-through-iap"] : []),
      "--quiet",
      `--command=${command}`,
      "--",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
    ];
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-p",
    String(s.port),
    ...(s.identityFile ? ["-i", s.identityFile] : []),
    `${s.user}@${s.host}`,
    command,
  ];
}
export async function remote(c: Config, script: string) {
  return run(sshArgs(c, "sudo -n bash -se"), script);
}
