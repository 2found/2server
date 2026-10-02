import { configSchema,type Config } from "../application/config";
export async function readConfig(file: string): Promise<Config> {
  return configSchema.parse(await Bun.file(file).json());
}
