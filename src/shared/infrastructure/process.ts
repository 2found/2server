import { createHash } from "node:crypto";
import { lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync } from "node:fs";
import type { Config } from "../../modules/config/application/config";
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
// The logical command for a transport. It is also an identity (connectionDigest),
// so connection reuse adds its options through `extra` and never changes this form.
export function sshArgs(config: Config, command: string, extra: string[] = []): string[] {
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
      ...extra,
    ];
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    ...extra,
    "-p",
    String(s.port),
    ...(s.identityFile ? ["-i", s.identityFile] : []),
    `${s.user}@${s.host}`,
    command,
  ];
}

// Connection reuse. Every remote step used to pay a full connection: through
// `gcloud compute ssh --tunnel-through-iap` that is a Python start, an instance
// lookup, an IAP tunnel and an SSH handshake, 4-7 seconds measured, and a deploy
// takes dozens of steps, many while it holds a control reservation. One OpenSSH
// master per transport carries every later step in ~0.15s, shared by concurrent
// CLI processes and kept for MUX_PERSIST seconds after the last use.
const MUX_PERSIST = 120;
const DRY_RUN_MARKER = "__2server_remote_command__";
type Mux = { path: string; options: string[]; live?: Promise<string[] | undefined>; first?: Promise<unknown>; direct?: Promise<string[] | undefined> };
const muxes = new Map<string, Mux>();
// A short private directory: socket paths are limited to ~104 bytes, and a
// socket another user could replace would hand them this operator's session.
export function muxDirectory(base = "/tmp", uid = process.getuid?.()): string | undefined {
  if (process.platform === "win32" || uid === undefined || process.env.TWO_SERVER_SSH_MUX === "0") return undefined;
  const dir = `${base}/2srv-ssh-${uid}`;
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  try {
    const s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o077) !== 0) return undefined;
  } catch {
    return undefined;
  }
  return dir;
}
function multiplexer(s: Config['ssh']): Mux | undefined {
  const dir = muxDirectory();
  if (!dir) return undefined;
  const key = createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 20);
  let mux = muxes.get(key);
  if (!mux) {
    const path = `${dir}/${key}`;
    mux = { path, options: ["-o", "ControlMaster=auto", "-o", `ControlPath=${path}`, "-o", `ControlPersist=${MUX_PERSIST}`] };
    muxes.set(key, mux);
  }
  return mux;
}
// gcloud prints the exact ssh command it would run, quoting only arguments that
// contain spaces. Anything else (an embedded quote, another binary, a missing
// command slot) is not trusted: callers keep going through gcloud.
export function parseDryRun(output: string): string[] | undefined {
  const line = output.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return directCommand([...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!));
}
function directCommand(argv: unknown): string[] | undefined {
  if (!Array.isArray(argv) || argv.length < 3 || argv.some((a) => typeof a !== "string" || a.includes('"'))) return undefined;
  if (!/(^|\/)ssh$/.test(argv[0]) || argv.at(-1) !== DRY_RUN_MARKER || argv.at(-2) !== "--") return undefined;
  return argv as string[];
}
async function directGcp(c: Config, mux: Mux): Promise<string[] | undefined> {
  const args = sshArgs(c, DRY_RUN_MARKER), split = args.indexOf("--");
  try {
    const argv = parseDryRun(await run([...args.slice(0, split), "--dry-run", ...args.slice(split)]));
    if (argv) {
      // Kept beside the socket so the next CLI process can reuse a live master
      // without starting gcloud at all.
      writeFileSync(`${mux.path}.argv.tmp`, JSON.stringify(argv), { mode: 0o600 });
      renameSync(`${mux.path}.argv.tmp`, `${mux.path}.argv`);
    }
    return argv;
  } catch {
    return undefined;
  }
}
// A master that is already up has authorized this key: start ssh directly.
async function reusable(mux: Mux): Promise<string[] | undefined> {
  try {
    const argv = directCommand(JSON.parse(readFileSync(`${mux.path}.argv`, "utf8")));
    if (!argv) return undefined;
    await run(["ssh", "-O", "check", "-o", `ControlPath=${mux.path}`, "2server-mux"]);
    return argv;
  } catch {
    return undefined;
  }
}
export async function ssh(c: Config, command: string, input?: string | Uint8Array): Promise<string> {
  const s = sessionTransport ?? c.ssh;
  const mux = multiplexer(s);
  if (!mux) return run(sshArgs(c, command), input);
  if (s.kind === "ssh") return run(sshArgs(c, command, mux.options), input);
  const live = await (mux.live ??= reusable(mux));
  if (live) return run([live[0]!, ...mux.options, ...live.slice(1, -1), command], input);
  if (!mux.first) {
    // The first step goes through gcloud: it authorizes the key and opens the
    // master. Later steps start ssh directly with gcloud's own arguments.
    mux.direct = directGcp(c, mux);
    const first = run(sshArgs(c, command, mux.options), input);
    mux.first = first.catch(() => undefined);
    return first;
  }
  await mux.first;
  const direct = await mux.direct;
  if (!direct) return run(sshArgs(c, command, mux.options), input);
  return run([direct[0]!, ...mux.options, ...direct.slice(1, -1), command], input);
}
export async function remote(c: Config, script: string) {
  return ssh(c, "sudo -n bash -se", script);
}
