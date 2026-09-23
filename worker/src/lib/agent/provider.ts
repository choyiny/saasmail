import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  AGENT_NOT_CONFIGURED_MESSAGE,
  DEFAULT_AGENT_MODELS,
} from "./constants";

export type AgentProvider = "anthropic" | "openai" | "workers-ai";

export type AgentModelEnv = {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AGENT_MODEL?: string;
  AI?: Ai;
};

export type SelectedAgentModel =
  | {
      ok: true;
      provider: AgentProvider;
      modelId: string;
      model: LanguageModel;
    }
  | {
      ok: false;
      error: string;
    };

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function selectModel(env: AgentModelEnv): SelectedAgentModel {
  const override = configured(env.AGENT_MODEL);
  const anthropicKey = configured(env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    const modelId = override ?? DEFAULT_AGENT_MODELS.anthropic;
    return {
      ok: true,
      provider: "anthropic",
      modelId,
      model: createAnthropic({ apiKey: anthropicKey })(modelId),
    };
  }

  const openaiKey = configured(env.OPENAI_API_KEY);
  if (openaiKey) {
    const modelId = override ?? DEFAULT_AGENT_MODELS.openai;
    return {
      ok: true,
      provider: "openai",
      modelId,
      model: createOpenAI({ apiKey: openaiKey })(modelId),
    };
  }

  if (env.AI) {
    const modelId = override ?? DEFAULT_AGENT_MODELS.workersAi;
    return {
      ok: true,
      provider: "workers-ai",
      modelId,
      model: createWorkersAI({ binding: env.AI })(modelId),
    };
  }

  return { ok: false, error: AGENT_NOT_CONFIGURED_MESSAGE };
}
