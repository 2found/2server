import type { Request } from "./resource-request";
export const count = (
  value: string | undefined,
  min: number,
  max: number,
  flag: string,
) => {
  if (!value || !/^\d+$/.test(value) || +value < min || +value > max)
    throw new Error(`${flag} must be ${min}..${max}`);
  return +value;
};

export function resourceContext(r: Request, serverName: string) {
  const { verb, resource, name, options } = r;
  const inspect = ["get", "describe"].includes(verb);
  const dry = () => {
    if (r.apply) return false;
    console.log(
      `${verb} ${resource} ${name ?? serverName}: pass --apply to execute`,
    );
    return true;
  };
  const emit = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  const needName = () => {
    if (!name) throw new Error(`${verb} ${resource} requires NAME`);
    return name;
  };
  const spec = async () => {
    if (!options.spec) throw new Error("--spec <resource.json> is required");
    return Bun.file(options.spec).json();
  };
  return { inspect, dry, emit, needName, spec };
}
