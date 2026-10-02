import { extensionProject, requiredSecret } from "../../stateful";
import type { ExtensionHooks } from "../types";
import type { ExtensionSpecs } from "../specs.generated";
import {catalogDefinition,renderDeclaration} from "../catalog";

const definition = catalogDefinition("nats");
export const natsHooks = {
  refineSpec(value, ctx) {
    const n = value as NonNullable<ExtensionSpecs["nats"]>;
    if (n.maxMemoryMb > n.memoryMb * 0.5)
      ctx.addIssue({code:"custom", message:"JetStream memory must leave at least 50% container overhead"});
  },
  stateful: {
    files(c, files, service) {
      const n = c.extensions.nats!;
      files["nats.conf"] = JSON.stringify({
        server_name: extensionProject(c, "nats"),
        ...renderDeclaration(definition.settings.config, {spec:n,server:c,edge:c.edge}),
        max_payload: n.maxPayloadKb * 1024,
        authorization: { token: requiredSecret(n.tokenEnv,c) },
        ...(n.jetstream
          ? {
              jetstream: {
                ...renderDeclaration(definition.settings.jetstream, {spec:n,server:c,edge:c.edge}),
                max_memory_store: n.maxMemoryMb * 1024 * 1024,
                max_file_store: n.maxFileGb * 1024 ** 3,
              },
            }
          : {}),
      });
      (service.healthcheck as Record<string, unknown>).test = [
        "CMD-SHELL",
        `wget -T 2 -qO- 'http://127.0.0.1:8222/healthz${n.jetstream ? "?js-enabled-only=true" : ""}' >/dev/null`,
      ];
    },
  },
} satisfies ExtensionHooks;
