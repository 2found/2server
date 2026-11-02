// Upstream quota probes shared by `app NAME quota` (cli.ts) and the optional
// VM-side quota alert (quota-alert.ts), so both ask the same questions about
// the same models and cannot drift apart.
export const ANTIGRAVITY_QUOTA_MODELS: Array<[string, string]> = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B'],
];
export const CODEX_QUOTA_MODEL = 'codex-primary';
// Every model key a quota probe can report; the only valid `quotaAlert.models`.
export const QUOTA_MODEL_KEYS = [...ANTIGRAVITY_QUOTA_MODELS.map(([key]) => key), CODEX_QUOTA_MODEL];
export const ANTIGRAVITY_DEFAULT_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_ENDPOINT_PATTERN = '^https://[a-z0-9.-]+$';
export const ANTIGRAVITY_USER_AGENT = 'antigravity/hub/2.9.1';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_USER_AGENT = 'codex_cli_agent/0.1.0';
