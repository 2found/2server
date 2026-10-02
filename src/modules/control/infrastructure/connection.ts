import { dirname,resolve } from 'node:path';
import { parseData } from "../../../shared/infrastructure/serialization";
import { sshSchema } from '../../server/domain/schema';
export async function connection(opts: Record<string, string>) {
  if (!!opts['--ssh'] === !!opts['--connection']) throw new Error('Use --ssh user@host OR --connection connection.json');
  if (opts['--connection'] && (opts['--port'] || opts['--identity'])) throw new Error('Put port/identityFile in the connection object');
  const [user, host, extra] = (opts['--ssh'] ?? '').split('@');
  if (opts['--ssh'] && (!user || !host || extra)) throw new Error('Expected --ssh user@host');
  const value=sshSchema.parse(opts['--connection'] ? parseData(await Bun.file(opts['--connection']).text()) : {
    kind: 'ssh', user, host, port: Number(opts['--port'] ?? 22), identityFile: opts['--identity'],
  });
  if(value.kind==='ssh'&&value.identityFile&&opts['--connection'])value.identityFile=resolve(dirname(resolve(opts['--connection'])),value.identityFile);
  return value;
}
