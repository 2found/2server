import { requireCloudflareToken } from '../../../../domains/infrastructure/cloudflare';
import type { ExternalRuntime } from '../../../domain/types';
import { inspectEmailRouting, reconcileEmailRouting } from './deploy';
import { emailRoutingSpecSchema } from './domain/spec';

export const emailRoutingRuntime: ExternalRuntime = {
  schema: emailRoutingSpecSchema,
  source: {
    operations: ['plan', 'apply', 'deploy', 'get'],
    connection: 'optional',
    initHint: 'use a private CLOUDFLARE_API_TOKEN or --connection to read VM-owned credentials',
    planMessage: 'Plan only; pass --apply to configure Email Routing.',
    validateDocument(document) {
      if (document.domains.length || document.requires.length || Object.keys(document.secrets).length || document.webhooks.length)
        throw new Error('Email Routing uses Cloudflare directly; omit VM domains, requires, secrets and webhooks');
    },
    async run({operation, spec, instance, apply, config}) {
      const token = requireCloudflareToken(config?.cloudflare.tokenEnv ?? 'CLOUDFLARE_API_TOKEN');
      const input = emailRoutingSpecSchema.parse(spec);
      return operation === 'get'
        ? inspectEmailRouting(input, token)
        : reconcileEmailRouting(input, instance, apply, token);
    },
  },
};
