import { homedir } from 'node:os';
import { join } from 'node:path';

let sessionState: string | undefined;
export function operatorState(name: string) {
  return sessionState ?? join(homedir(), '.local', 'state', '2server', name);
}
export function setSessionState(path?: string) { sessionState = path; }
