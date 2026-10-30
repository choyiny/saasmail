export const DEFAULT_AGENT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-sol",
  workersAi: "@cf/moonshotai/kimi-k2.6",
} as const;

export const AGENT_NOT_CONFIGURED_MESSAGE =
  "Mail agent is not configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or configure the Workers AI binding.";
