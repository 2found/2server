import { hostReachable } from '../../../shared/infrastructure/probe';
import { quote } from '../../../shared/infrastructure/process';

export type ProbeTarget = { name: string } | { variable: string };
// One HTTP readiness probe as a bash condition; sets `code`. It runs a dozen
// times per rollout, all inside the app's lock: host curl when the container is
// reachable from the host (see hostReachable), a curl container otherwise.
export function httpProbe(network: string, target: ProbeTarget, port: number, path: string, maxTime: number, bounded = false): string {
  const limit = bounded ? 'timeout --signal=KILL "$remaining" ' : '';
  const curl = `-s --connect-timeout 2 --max-time ${maxTime} -o /dev/null -w '%{http_code}'`;
  const container = 'name' in target ? quote(target.name) : `"$${target.variable}"`;
  const url = 'name' in target ? quote(`http://${target.name}:${port}${path}`) : `"http://$${target.variable}:${port}${path}"`;
  return `code=$(if ${hostReachable(network, container)}; then ${limit}curl ${curl} "http://$probe_ip:${port}${path}"; else ${limit}docker run --rm --network ${quote(network)} curlimages/curl:8.12.1 ${curl} ${url}; fi 2>/dev/null) && [[ "$code" =~ ^2[0-9][0-9]$ ]]`;
}

// A digest names immutable content: when the VM already holds it (the source
// flow pulls before reserving), asking the registry again only adds a manifest
// round trip and a credential-helper token mint under the app lock. Tags and
// absent digests still pull.
export function pullUnlessPresent(image: string, pull: string): string {
  if (!image.includes('@sha256:')) return pull;
  return `if ! docker image inspect ${quote(image)} >/dev/null 2>&1; then
${pull}
fi`;
}

// Every rollout of one app serializes on its VM lock, held on fd 8. The wait
// covers a previous rollout's background drain and stop before giving up.
export function appLock(a: { name: string; drainSeconds: number; stopTimeoutSeconds: number }) {
  return `exec 8>/var/lock/2server-app-${a.name}.lock\nflock -w ${120 + a.drainSeconds + a.stopTimeoutSeconds} 8`;
}

// After the route is committed the previous generation only drains and stops.
// That used to keep the operator's control reservation (and every server-scoped
// operation behind it) waiting for drainSeconds plus the stop. The subshell
// inherits fd 8, so this app's VM lock stays held until the stop finishes and
// the next rollout of this app still waits for it; nothing else does. stdio is
// detached so the SSH session can close, and a hangup does not cut the drain.
export function drainInBackground(app: string, seconds: number, stop: string) {
  return `(
 exec 9>&-
 trap '' HUP
 sleep ${seconds}
 ${stop} || logger -t 2server ${quote(`app ${app}: the previous generation did not stop after its drain`)} || true
) </dev/null >/dev/null 2>&1 &`;
}
