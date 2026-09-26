/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { runMailAgentChat, type MailAgentEnv } from "../agent/mail-agent";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";

const MOCK_USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// Step 1 reasons slowly and then calls a read-only tool; step 2 answers.
function twoStepModel() {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 50,
            chunkDelayInMs: 60,
            chunks: [
              { type: "reasoning-start" as const, id: "r1" },
              ...Array.from({ length: 8 }, () => ({
                type: "reasoning-delta" as const,
                id: "r1",
                delta: "thinking ",
              })),
              { type: "reasoning-end" as const, id: "r1" },
              {
                type: "tool-call" as const,
                toolCallId: "call-inboxes",
                toolName: "list_inboxes",
                input: "{}",
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: "tool" },
                usage: MOCK_USAGE,
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: 20,
          chunks: [
            { type: "text-start" as const, id: "t1" },
            {
              type: "text-delta" as const,
              id: "t1",
              delta: "You have no inboxes.",
            },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: MOCK_USAGE,
            },
          ],
        }),
      };
    },
  });
}

type AgentInstance = {
  messages: UIMessage[];
  name: string;
  env: MailAgentEnv;
  onChatMessage: (
    onFinish: unknown,
    options?: { body?: Record<string, unknown>; abortSignal?: AbortSignal },
  ) => Promise<Response>;
};

async function startSession(apiKey: string) {
  const res = await authFetch("/api/agent/sessions", {
    method: "POST",
    apiKey,
    body: JSON.stringify({ title: "Disconnect" }),
  });
  const session = (await res.json()) as { instanceName: string };
  const stub = env.MAIL_AGENT.get(
    env.MAIL_AGENT.idFromName(session.instanceName),
  );
  await runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as AgentInstance;
    const model = twoStepModel();
    agent.onChatMessage = async (_onFinish, options) =>
      runMailAgentChat({
        db: getDb(),
        env: agent.env,
        instanceName: agent.name,
        messages: agent.messages,
        body: options?.body,
        abortSignal: options?.abortSignal,
        modelOverride: model,
      });
  });
  return { stub, instanceName: session.instanceName };
}

async function connect(instanceName: string, apiKey: string) {
  const res = await exports.default.fetch(
    `http://localhost/agents/mail-agent/${instanceName}`,
    { headers: { Upgrade: "websocket", Authorization: `Bearer ${apiKey}` } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed: ${res.status}`);
  ws.accept();
  const chunkTypes: string[] = [];
  ws.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as {
        type?: string;
        body?: string;
      };
      if (frame.type === "cf_agent_use_chat_response" && frame.body) {
        chunkTypes.push((JSON.parse(frame.body) as { type: string }).type);
      }
    } catch {
      // ignore non-JSON frames
    }
  });
  return { ws, chunkTypes };
}

function sendTurn(ws: WebSocket, text: string) {
  const user: UIMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
  ws.send(
    JSON.stringify({
      id: `req-${Date.now()}`,
      type: "cf_agent_use_chat_request",
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [user], trigger: "submit-message" }),
      },
    }),
  );
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

async function persistedAnswer(stub: ReturnType<typeof env.MAIL_AGENT.get>) {
  return waitFor(() =>
    runInDurableObject(stub, async (instance) => {
      const messages = (instance as unknown as AgentInstance).messages;
      const last = messages.at(-1);
      if (last?.role !== "assistant") return undefined;
      if (!last.parts.some((part) => part.type === "text")) return undefined;
      return last.parts.map((part) => part.type);
    }),
  );
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("MailAgent turn persistence across a client disconnect", () => {
  it("keeps every step when the client stays connected", async () => {
    const user = await createTestUser({ id: "disc-a", email: "a@example.com" });
    const { stub, instanceName } = await startSession(user.apiKey);
    const { ws } = await connect(instanceName, user.apiKey);

    sendTurn(ws, "Which inboxes can I access?");

    expect(await persistedAnswer(stub)).toEqual([
      "step-start",
      "reasoning",
      "tool-list_inboxes",
      "step-start",
      "text",
    ]);
    ws.close();
  });

  it("keeps every step when the client disconnects mid-reasoning", async () => {
    const user = await createTestUser({ id: "disc-b", email: "b@example.com" });
    const { stub, instanceName } = await startSession(user.apiKey);
    const { ws, chunkTypes } = await connect(instanceName, user.apiKey);

    sendTurn(ws, "Which inboxes can I access?");
    await waitFor(async () =>
      chunkTypes.includes("reasoning-delta") ? true : undefined,
    );
    expect(chunkTypes).not.toContain("tool-input-available");
    ws.close();

    expect(await persistedAnswer(stub)).toEqual([
      "step-start",
      "reasoning",
      "tool-list_inboxes",
      "step-start",
      "text",
    ]);
  });
});
