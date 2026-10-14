import { quote } from './process';

// A bash condition that holds when the host can reach `container` directly on
// `network`, and sets `probe_ip` to its IPv4 address there.
//
// Probing through a throwaway curl container costs ~1.5s and ~2s of host CPU on
// a busy 2-vCPU VM; host curl to the address takes ~25ms. Docker routes the
// host to a non-internal bridge network, so that is the only case taken: an
// internal network, a host without curl or a container without an IPv4 address
// there must keep the containerized probe, which also resolves Docker DNS names.
// `container` is a shell word: a quoted literal or a quoted expansion.
export function hostReachable(network: string, container: string): string {
  const address = quote(`{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{.IPAddress}}{{end}}`);
  return `probe_ip=$(timeout --signal=KILL 2 docker inspect -f ${address} ${container} 2>/dev/null) && [[ "$probe_ip" =~ ^[0-9]{1,3}(\\.[0-9]{1,3}){3}$ ]] && command -v curl >/dev/null 2>&1 && [ "$(timeout --signal=KILL 2 docker network inspect -f '{{.Internal}}' ${quote(network)} 2>/dev/null)" = false ]`;
}
