#!/usr/bin/env python3
"""Keep Docker workloads away from the VM identity unless explicitly allowed.

Matches the host veth as well as source IP so recycled container IPs never inherit
an earlier workload's metadata access. No credentials are read or requested.
"""
import fcntl
import ipaddress
import json
import pathlib
import re
import subprocess
import sys

CHAIN = 'TWO-METADATA'
ALLOW_FILE = pathlib.Path('/opt/2server/security/metadata-allow.json')

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30, **kwargs).stdout

def rules(containers, peers, legacy_names):
    result = []
    for c in containers:
        name = c['Name'].lstrip('/')
        labels = c['Config'].get('Labels') or {}
        permission = labels.get('io.2server.cloud-metadata', labels.get('cloud-metadata'))
        allowed = permission == 'allow' or (permission is None and name in legacy_names)
        if not c['State']['Running'] or not allowed or c['HostConfig']['NetworkMode'] == 'host':
            continue
        for address, interface in peers(c):
            ip = ipaddress.IPv4Address(address)
            if not re.fullmatch(r'veth[a-zA-Z0-9]{1,15}', interface):
                raise ValueError('Unexpected host veth name')
            result.append(f'-A {CHAIN} -s {ip}/32 -m physdev --physdev-in {interface} -j ACCEPT')
    return sorted(set(result)) + [f'-A {CHAIN} -j REJECT --reject-with icmp-port-unreachable']

def main():
    with open('/run/lock/2server-metadata.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        initialize = sys.argv[1:] == ['--initialize']
        if sys.argv[1:] and not initialize:
            raise ValueError('Only --initialize is supported')
        ids = [] if initialize else run(['docker', 'ps', '-q']).split()
        containers = json.loads(run(['docker', 'inspect', *ids])) if ids else []
        legacy = json.loads(ALLOW_FILE.read_text()) if ALLOW_FILE.exists() else []
        if not isinstance(legacy, list) or any(not isinstance(n, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', n) for n in legacy):
            raise ValueError('Invalid metadata allow list')
        interfaces = {int(p.read_text()): p.parent.name for p in pathlib.Path('/sys/class/net').glob('veth*/ifindex')}
        def peers(c):
            links = json.loads(run(['nsenter', '-t', str(c['State']['Pid']), '-n', 'ip', '-j', 'link', 'show']))
            addresses = json.loads(run(['nsenter', '-t', str(c['State']['Pid']), '-n', 'ip', '-j', '-4', 'address', 'show']))
            by_name = {link['ifname']: interfaces.get(link.get('link_index')) for link in links}
            return [(a['local'], by_name[d['ifname']]) for d in addresses if by_name.get(d['ifname']) for a in d.get('addr_info', []) if a['family'] == 'inet']
        desired = rules(containers, peers, set(legacy))
        if initialize:
            # Docker preserves this user-owned chain; install the default deny
            # before its daemon can start containers after a reboot/restart.
            present = subprocess.run(['iptables', '-w', '10', '-S', 'DOCKER-USER'], capture_output=True, timeout=15)
            if present.returncode:
                run(['iptables', '-w', '10', '-N', 'DOCKER-USER'])
        existing = subprocess.run(['iptables', '-w', '10', '-S', CHAIN], capture_output=True, text=True, timeout=15)
        if existing.returncode or existing.stdout.splitlines()[1:] != desired:
            # One atomic table transaction, preserving every other firewall rule.
            table = '\n'.join(['*filter', f':{CHAIN} - [0:0]', f'-F {CHAIN}', *desired, 'COMMIT', ''])
            run(['iptables-restore', '-w', '10', '--noflush'], input=table)
        jump = ['DOCKER-USER', '-d', '169.254.169.254/32', '-p', 'tcp', '-m', 'multiport', '--dports', '80,443', '-j', CHAIN]
        found = subprocess.run(['iptables', '-w', '10', '-C', *jump], capture_output=True, timeout=15)
        if found.returncode:
            run(['iptables', '-w', '10', '-I', 'DOCKER-USER', '1', *jump[1:]])

if __name__ == '__main__':
    main()
