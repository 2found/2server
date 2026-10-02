import { quote } from '../../../shared/infrastructure/process';
import type { Config } from '../../config/application/config';
import type { App } from '../domain/schema';

// Run once per applied release (not per replica), under the app's rollout lock.
// The candidate image supplies the program; secrets stay in a private VM file.
// No app volumes, published ports, host mounts or Docker socket are exposed.
export function preDeployScript(c: Config, a: App, envFile: string): string {
  if (!a.preDeploy || !a.replicas) return '';
  const [entrypoint, ...args] = a.preDeploy.command;
  const container = `two-predeploy-${a.name}-${crypto.randomUUID()}`;
  const log = envFile.replace(/[^/]+$/, 'pre-deploy.log');
  return `(
  umask 077
  trap 'docker rm -f ${quote(container)} >/dev/null 2>&1 || true' EXIT
  echo 'Running preDeploy: ${a.name}'
  if timeout --signal=TERM --kill-after=5 ${a.preDeploy.timeoutSeconds} docker run --rm --init \
    --name ${quote(container)} --network ${quote(c.edge.network)} \
    --label io.2server.owner=${c.name} --label io.2server.app=${a.name} --label io.2server.task=preDeploy \
    --memory ${a.memoryMb}m --cpus ${a.cpus} --pids-limit 256 \
    --security-opt no-new-privileges:true --cap-drop ALL ${a.capabilities.map(v=>`--cap-add ${quote(v)}`).join(' ')} --log-driver none \
    --env-file ${quote(envFile)} --entrypoint ${quote(entrypoint!)} ${quote(a.image)} ${args.map(quote).join(' ')} > ${quote(log)} 2>&1; then
    echo 'preDeploy succeeded: ${a.name}'
  else
    echo 'preDeploy failed or timed out: ${a.name}; inspect the private VM release log' >&2
    exit 1
  fi
)
`;
}
