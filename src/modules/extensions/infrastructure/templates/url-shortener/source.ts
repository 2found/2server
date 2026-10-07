import type { ExternalRuntime } from '../../../domain/types';
import { deployCloudflareWorker, workerTemplateFiles } from './deploy';
import { workerSpecSchema } from './domain/spec';

export const workerRuntime: ExternalRuntime = {
  schema: workerSpecSchema,
  source: {
    operations: ['plan', 'apply', 'deploy'],
    connection: 'none',
    initHint: 'set CLOUDFLARE_API_TOKEN privately in the local environment; no VM connection is used',
    planMessage: 'Plan only; pass --apply to deploy. No VM connection is used.',
    validateDocument(document) {
      if (document.domains.length || document.requires.length || Object.keys(document.secrets).length || document.webhooks.length)
        throw new Error('Worker apps use Cloudflare directly; omit VM domains, requires, secrets and webhooks');
    },
    async run({spec, template, apply}) {
      return deployCloudflareWorker(workerSpecSchema.parse(spec), apply, workerTemplateFiles(template));
    },
  },
};
