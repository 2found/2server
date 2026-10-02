import { isDeepStrictEqual as equal } from 'node:util';
import type { Config } from '../../config/application/config';

type SnapshotData = {config: Config; env: Record<string,string>; appSecrets?: Record<string,Record<string,string>>; state: Record<string,string>};
// Merge resource records, never individual fields inside an app contract. A
// conflicting writer must be reconciled, not silently resolved by last-writer-wins.
function records<T>(base: Record<string,T>, next: Record<string,T>, current: Record<string,T>): Record<string,T> {
  const result = {...current};
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (equal(base[key], next[key])) continue;
    if (!equal(base[key], current[key]) && !equal(next[key], current[key]))
      throw new Error('Concurrent control state conflict; private recovery required');
    if (Object.hasOwn(next,key)) result[key] = next[key]; else delete result[key];
  }
  return result;
}
const byName = <T extends {name:string}>(rows:T[]) => Object.fromEntries(rows.map(row=>[row.name,row]));
export function mergeControl<T extends SnapshotData>(base:T, next:T, current:T):T {
  const {apps:ba, domains:bd, ...bc} = base.config;
  const {apps:na, domains:nd, ...nc} = next.config;
  const {apps:ca, domains:cd, ...cc} = current.config;
  const state = records(base.state,next.state,current.state);
  // History retention is evaluated on the merged set, including records that
  // arrived after this session started.
  const history = Object.keys(state).filter(path=>path.startsWith('deployments/'));
  const time = (path:string) => {try {return Date.parse(JSON.parse(state[path]).appliedAt)||0;} catch {return 0;}};
  for (const path of history.sort((a,b)=>time(b)-time(a)||a.localeCompare(b)).slice(20)) delete state[path];
  return {...next,
    config: {...records(bc,nc,cc), apps:Object.values(records(byName(ba),byName(na),byName(ca))), domains:Object.values(records(byName(bd),byName(nd),byName(cd)))} as Config,
    env: records(base.env,next.env,current.env),
    appSecrets: records(base.appSecrets??{},next.appSecrets??{},current.appSecrets??{}),
    state,
  };
}
