export function parseData(text:string):unknown { return Bun.YAML.parse(text); }
