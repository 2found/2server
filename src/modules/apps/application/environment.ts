import type { Bindings } from "../../../shared/domain/schema";
import { run } from "../../../shared/infrastructure/process";
import { vmSecret } from "../../../shared/infrastructure/vm-secrets";
import { type Config } from "../../config/application/config";
import { resolveBindings } from "../../extensions/application/bindings";
import { type App } from "../domain/schema";
export async function resolveEnvMap(a: Pick<App, "name" | "env" | "secrets"> & { bindings?: Bindings }, c?: Config): Promise<Record<string, string>> {
  if (Object.keys(a.bindings ?? {}).length && !c) throw new Error('Binding resolution requires the server config');
  const values = { ...a.env, ...(c ? resolveBindings(c, a.bindings ?? {}) : {}) };
  for (const [key, s] of Object.entries(a.secrets)) {
    let value: string | undefined;
    if (s.provider === "env") value = process.env[s.key];
    if (s.provider === "vm") value = vmSecret(a.name,s.key);
    if (s.provider === "gcp")
      value = await run([
        "gcloud",
        "secrets",
        "versions",
        "access",
        s.version,
        `--secret=${s.secret}`,
        `--project=${s.project}`,
      ]);
    if (s.provider === "aws")
      value = (
        JSON.parse(
          await run([
            "aws",
            "secretsmanager",
            "get-secret-value",
            "--secret-id",
            s.id,
            "--region",
            s.region,
            "--output",
            "json",
          ]),
        ) as { SecretString?: string }
      ).SecretString;
    if(s.provider==='vm' && value===undefined)throw new Error(`${a.name}: VM secret ${s.key} missing; use 2server secret set --app ${a.name} --env-file PRIVATE_FILE --apply`);
    if (value === undefined || (s.provider !== "vm" && !value) || /[\r\n\0]/.test(value))
      throw new Error(
        `${a.name}: secret ${key} missing or multiline (env-file values must be single-line)`,
      );
    values[key] = value;
  }
  return values;
}
export async function resolveEnv(a: Pick<App, "name" | "env" | "secrets"> & { bindings?: Bindings }, c?: Config): Promise<string> {
  const values = await resolveEnvMap(a, c);
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}
