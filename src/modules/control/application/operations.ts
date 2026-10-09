import { remote,run } from '../../../shared/infrastructure/process';
import { upload } from '../../domains/infrastructure/edge';
import { setup } from '../../server/application/setup';
import { saveConnection } from "../infrastructure/files";
export const controlOperations = { remote, upload, run, setup, saveConnection, lockEvent: (event:Record<string,unknown>) => { console.error(`[2srv lock] ${JSON.stringify(event)}`); } };
