export function options(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.includes(flag) || flag in result) throw new Error('Unknown or duplicate connection option; use help');
    if (flag === '--apply') result[flag] = 'true';
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}
export function connectionOptions(args: string[]) {
  const flags = ['--ssh', '--port', '--identity', '--connection'];
  const rest: string[] = [], conn: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) conn.push(args[i], args[++i]);
    else rest.push(args[i]);
  }
  return {opts: options(conn, flags), rest};
}
