import { extensionProject, requiredSecret } from '../../../application/stateful';
import type { ExtensionSpecs } from '../../../domain/specs.generated';
import type { ExtensionHooks } from '../../../domain/types';

export const meilisearchHooks = {
  refineSpec(value, ctx) {
    const spec = value as NonNullable<ExtensionSpecs['meilisearch']>;
    if (spec.indexingMemoryMb > spec.memoryMb * 0.5)
      ctx.addIssue({code:'custom', message:'Meilisearch indexing memory must leave at least 50% container overhead'});
  },
  stateful: {
    files(c, files) {
      const spec = c.extensions.meilisearch!;
      const key = requiredSecret(spec.masterKeyEnv, c);
      files['meilisearch.toml'] = [
        'env = "production"',
        'http_addr = "0.0.0.0:7700"',
        'db_path = "/meili_data/data.ms"',
        'dump_dir = "/meili_data/dumps"',
        'snapshot_dir = "/meili_data/snapshots"',
        'no_analytics = true',
        `master_key = ${JSON.stringify(key)}`,
        `max_indexing_memory = "${spec.indexingMemoryMb} MiB"`,
        `max_indexing_threads = ${Math.max(1, Math.floor(spec.cpus))}`,
      ].join('\n') + '\n';
      // Authentication readiness without a secret in argv or command output.
      files['verify.conf'] = [
        'silent', 'show-error', 'fail', 'max-time = 5',
        'output = "/dev/null"',
        'url = "http://127.0.0.1:7700/indexes?limit=1"',
        `header = ${JSON.stringify('Authorization: Bearer ' + key)}`,
      ].join('\n') + '\n';
    },
    verify: c => `docker exec ${extensionProject(c, 'meilisearch')} curl --config /run/secrets/verify.conf`,
  },
} satisfies ExtensionHooks;
