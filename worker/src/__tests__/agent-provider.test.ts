import { describe, expect, it } from "vitest";
import {
  getAgentStatus,
  selectModel,
  type AgentModelEnv,
} from "../lib/agent/provider";
import {
  AGENT_NOT_CONFIGURED_MESSAGE,
  DEFAULT_AGENT_MODELS,
} from "../lib/agent/constants";

const fakeAi = { run: async () => ({}) } as unknown as Ai;

describe("agent provider selection", () => {
  it("prefers Anthropic, then OpenAI, then Workers AI", () => {
    const all = selectModel({
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      AI: fakeAi,
    });
    expect(all).toMatchObject({
      ok: true,
      provider: "anthropic",
      modelId: DEFAULT_AGENT_MODELS.anthropic,
    });

    const noAnthropic = selectModel({
      OPENAI_API_KEY: "openai-key",
      AI: fakeAi,
    });
    expect(noAnthropic).toMatchObject({
      ok: true,
      provider: "openai",
      modelId: DEFAULT_AGENT_MODELS.openai,
    });

    const workers = selectModel({ AI: fakeAi });
    expect(workers).toMatchObject({
      ok: true,
      provider: "workers-ai",
      modelId: DEFAULT_AGENT_MODELS.workersAi,
    });
  });

  it("uses AGENT_MODEL for the selected provider", () => {
    for (const env of [
      { ANTHROPIC_API_KEY: "a", AGENT_MODEL: "custom-anthropic" },
      { OPENAI_API_KEY: "o", AGENT_MODEL: "custom-openai" },
      { AI: fakeAi, AGENT_MODEL: "@cf/custom/model" },
    ] satisfies AgentModelEnv[]) {
      const selected = selectModel(env);
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.modelId).toBe(env.AGENT_MODEL);
    }
  });

  it("reports configured and unconfigured status without exposing secrets", () => {
    const secret = "anthropic-secret-that-must-not-leak";
    expect(getAgentStatus({})).toEqual({
      configured: false,
      provider: null,
      model: null,
    });

    const configured = getAgentStatus({ ANTHROPIC_API_KEY: secret });
    expect(configured).toEqual({
      configured: true,
      provider: "anthropic",
      model: DEFAULT_AGENT_MODELS.anthropic,
    });
    expect(JSON.stringify(configured)).not.toContain(secret);
  });

  it("returns a clear not-configured result instead of throwing", () => {
    expect(selectModel({})).toEqual({
      ok: false,
      error: AGENT_NOT_CONFIGURED_MESSAGE,
    });
    expect(selectModel({ ANTHROPIC_API_KEY: " ", OPENAI_API_KEY: "" })).toEqual(
      {
        ok: false,
        error: AGENT_NOT_CONFIGURED_MESSAGE,
      },
    );
  });
});
