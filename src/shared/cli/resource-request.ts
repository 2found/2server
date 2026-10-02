const verbs = [
  "adopt",
  "deploy",
  "get",
  "describe",
  "create",
  "update",
  "delete",
  "reload",
  "get-log",
  "logs",
  "scale",
  "start",
  "stop",
  "backup",
  "check-backup",
  "restore",
  "resize",
  "rollback",
  "test",
];
const aliases: Record<string, string> = {
  webhooks: "webhook",
  apps: "app",
  service: "app",
  services: "app",
  pods: "pod",
  workload: "pod",
  instance: "pod",
  domains: "domain",
  vms: "vm",
  extensions: "extension",
  disks: "disk",
  monitoring: "monitor",
};
const nouns = [
  "app",
  "pod",
  "domain",
  "vm",
  "extension",
  "disk",
  "monitor",
  "postgres",
  "backup-storage",
  "recovery",
  "webhook",
];
const valueFlags = [
  "-f",
  "--file",
  "--spec",
  "--replicas",
  "--image",
  "--tail",
  "--database",
  "--id",
  "--recovery",
  "--target-time",
  "--size-gb",
];
export type Request = {
  verb: string;
  resource: string;
  name?: string;
  file: string;
  apply: boolean;
  options: Record<string, string>;
};
export function resourceOperation(args: string[]): {verb: string; resource: string} | undefined {
  let [verb, resource] = args;
  if (nouns.includes(aliases[verb] ?? verb) && verbs.includes(resource))
    [verb, resource] = [resource, verb];
  resource = aliases[resource] ?? resource;
  if (!verbs.includes(verb) || !nouns.includes(resource)) return undefined;
  return {verb: verb === "get-log" ? "logs" : verb, resource};
}
export function parseResource(args: string[]): Request | undefined {
  const operation = resourceOperation(args);
  if (!operation) return undefined;
  const {verb, resource} = operation;
  const rest = args.slice(2);
  // Preserve the old `rollback <manifest>` entrypoint.
  const options: Record<string, string> = {};
  let name: string | undefined,
    apply = false;
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--migrations-applied") {
      if (options["migrations-applied"]) throw new Error("Duplicate --migrations-applied");
      options["migrations-applied"]="true";
    } else if (arg === "--apply") {
      if (apply) throw new Error("Duplicate --apply");
      apply = true;
    } else if (valueFlags.includes(arg)) {
      const value = rest.shift();
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      const key = ["-f", "--file"].includes(arg) ? "file" : arg.slice(2);
      if (key in options) throw new Error(`Duplicate ${arg}`);
      options[key] = value;
    } else if (arg.startsWith("-") || name)
      throw new Error(`Unexpected argument: ${arg}`);
    else name = arg;
  }
  if (!options.file)
    throw new Error("Resource commands require -f <manifest.json>");
  const allowed = new Set(["file"]);
  if (
    ["create", "update", "adopt"].includes(verb) &&
    ["app", "domain", "extension", "webhook"].includes(resource)
  )
    allowed.add("spec");
  if (["deploy", "update"].includes(verb) && resource === "app") allowed.add("migrations-applied");
  if (verb === "deploy" && resource === "app") allowed.add("image");
  if (verb === "scale" && resource === "app") allowed.add("replicas");
  if (["logs", "get-log"].includes(verb)) allowed.add("tail");
  if (verb === "restore") {
    allowed.add("id");
    allowed.add("database");
    allowed.add("recovery");
    allowed.add("target-time");
  }
  if (verb === "resize") allowed.add("size-gb");
  for (const key of Object.keys(options))
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for ${verb}`);
  if (name && !/^[a-z][a-z0-9-]{0,150}$/.test(name))
    throw new Error("Invalid resource name");
  return {
    verb: verb === "get-log" ? "logs" : verb,
    resource,
    name,
    file: options.file,
    apply,
    options,
  };
}
