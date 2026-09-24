import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import AgentPanel from "@/components/AgentPanel";
import {
  AgentContextProvider,
  useAgentContext,
  type AgentNavigationContext,
} from "@/agent/AgentContext";
import * as api from "@/lib/api";
import type { ComposePrefill } from "@/pages/ComposeModal";

const sdk = vi.hoisted(() => ({
  useAgent: vi.fn(),
  useAgentChat: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  regenerate: vi.fn(),
}));

vi.mock("agents/react", () => ({
  useAgent: sdk.useAgent,
}));
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: sdk.useAgentChat,
}));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchAgentStatus: vi.fn(),
    fetchAgentSessions: vi.fn(),
    createAgentSession: vi.fn(),
    updateAgentSession: vi.fn(),
    deleteAgentSession: vi.fn(),
    fetchDraft: vi.fn(),
  };
});

const session = (
  id: string,
  title: string | null,
  updatedAt: number,
  archivedAt: number | null = null,
): api.AgentSession => ({
  id,
  title,
  createdAt: updatedAt,
  updatedAt,
  archivedAt,
  instanceName: `u-user-s-${id}`,
});

function SeedContext({ value }: { value: AgentNavigationContext }) {
  const { publish } = useAgentContext();
  useEffect(() => {
    publish(value);
  }, [publish, value]);
  return null;
}

function renderPanel(options?: {
  context?: AgentNavigationContext;
  onOpenCompose?: (prefill?: ComposePrefill, contextKey?: string) => void;
}) {
  const onOpenCompose = options?.onOpenCompose ?? vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <AgentContextProvider>
            {options?.context && <SeedContext value={options.context} />}
            <AgentPanel onClose={() => {}} onOpenCompose={onOpenCompose} />
          </AgentContextProvider>
        ),
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return { router, onOpenCompose };
}

beforeEach(() => {
  vi.restoreAllMocks();
  sdk.sendMessage.mockReset();
  sdk.stop.mockReset();
  sdk.regenerate.mockReset();
  sdk.useAgent.mockReturnValue({
    agent: "mail-agent",
    name: "u-user-s-newer",
    path: [{ agent: "mail-agent", name: "u-user-s-newer" }],
    getHttpUrl: () => "http://localhost/agents/mail-agent/u-user-s-newer",
    connectionError: null,
  });
  sdk.useAgentChat.mockReturnValue({
    messages: [],
    sendMessage: sdk.sendMessage,
    stop: sdk.stop,
    regenerate: sdk.regenerate,
    error: null,
    status: "ready",
    isStreaming: false,
  });
  vi.mocked(api.fetchAgentStatus).mockResolvedValue({
    configured: true,
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  vi.mocked(api.fetchAgentSessions).mockResolvedValue({
    sessions: [session("older", "Older", 1), session("newer", "Newer", 2)],
  });
  vi.mocked(api.fetchDraft).mockResolvedValue(null);
});

describe("AgentPanel", () => {
  it("supports session create, rename, archive, delete, and archived visibility", async () => {
    vi.mocked(api.createAgentSession).mockResolvedValue(
      session("new", null, 3),
    );
    vi.mocked(api.updateAgentSession)
      .mockResolvedValueOnce(session("new", "Renamed", 4))
      .mockResolvedValueOnce(session("new", "Renamed", 5, 5));
    vi.mocked(api.deleteAgentSession).mockResolvedValue({ success: true });
    vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();

    expect(await screen.findByText("Newer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("agent-new-session"));
    await waitFor(() => expect(api.createAgentSession).toHaveBeenCalled());

    fireEvent.click(
      await screen.findByRole("button", { name: "Rename session" }),
    );
    await waitFor(() =>
      expect(api.updateAgentSession).toHaveBeenCalledWith("new", {
        title: "Renamed",
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Archive Renamed" }),
    );
    await waitFor(() =>
      expect(api.updateAgentSession).toHaveBeenCalledWith("new", {
        archived: true,
      }),
    );
    expect(screen.queryByText("Renamed")).toBeNull();

    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByText("Renamed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete Renamed" }));
    await waitFor(() =>
      expect(api.deleteAgentSession).toHaveBeenCalledWith("new"),
    );
  });

  it("titles only an untitled session from the first user message", async () => {
    const untitled = session("untitled", null, 3);
    vi.mocked(api.fetchAgentSessions).mockResolvedValue({
      sessions: [untitled],
    });
    vi.mocked(api.updateAgentSession).mockImplementation(async (id, patch) => ({
      ...untitled,
      id,
      title: patch.title ?? null,
      updatedAt: 4,
    }));

    renderPanel();

    await waitFor(() =>
      expect(
        (screen.getByTestId("agent-composer") as HTMLTextAreaElement).disabled,
      ).toBe(false),
    );
    const composer = screen.getByTestId(
      "agent-composer",
    ) as HTMLTextAreaElement;
    const text = "A".repeat(75);
    fireEvent.change(composer, { target: { value: text } });
    expect(composer.value).toBe(text);
    fireEvent.submit(composer.closest("form")!);

    await waitFor(() =>
      expect(sdk.sendMessage).toHaveBeenCalledWith({
        role: "user",
        parts: [{ type: "text", text }],
      }),
    );
    await waitFor(() =>
      expect(api.updateAgentSession).toHaveBeenCalledWith("untitled", {
        title: "A".repeat(60),
      }),
    );
  });

  it("shows inline setup text and disables the composer when no provider is configured", async () => {
    vi.mocked(api.fetchAgentStatus).mockResolvedValue({
      configured: false,
      provider: null,
      model: null,
    });

    renderPanel();

    const hint = await screen.findByTestId("agent-not-configured");
    expect(hint.textContent).toContain(
      "Set ANTHROPIC_API_KEY or OPENAI_API_KEY as a Worker secret",
    );
    expect(hint.querySelector("a")).toBeNull();
    expect(
      (screen.getByTestId("agent-composer") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });

  it("shows a service error instead of the not-configured hint when initial loading fails", async () => {
    vi.mocked(api.fetchAgentStatus).mockRejectedValue(new Error("offline"));

    renderPanel();

    expect(
      (await screen.findByTestId("agent-service-error")).textContent,
    ).toContain("Couldn't reach the agent service");
    expect(screen.queryByTestId("agent-not-configured")).toBeNull();
  });

  it("passes the latest navigation context in the SDK request body", async () => {
    renderPanel({
      context: {
        inbox: "support@example.com",
        folder: "inbox",
        selectedMessageRef: "received:one",
        personId: "person-1",
      },
    });

    await waitFor(() => expect(sdk.useAgentChat).toHaveBeenCalled());
    const options = sdk.useAgentChat.mock.calls.at(-1)?.[0] as {
      body: () => Record<string, unknown>;
    };
    expect(options.body()).toEqual({
      context: {
        inbox: "support@example.com",
        folder: "inbox",
        selectedMessageRef: "received:one",
        personId: "person-1",
      },
    });
  });

  it("shows streaming errors inline, including the provider-not-configured text", async () => {
    sdk.useAgentChat.mockReturnValue({
      messages: [],
      sendMessage: sdk.sendMessage,
      stop: sdk.stop,
      regenerate: sdk.regenerate,
      error: new Error(
        "No agent model provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or bind Workers AI.",
      ),
      status: "error",
      isStreaming: false,
    });

    renderPanel();

    const error = await screen.findByTestId("agent-chat-error");
    expect(error.textContent).toContain(
      "No agent model provider is configured",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("expands tool badges and opens a new-message draft through compose", async () => {
    const onOpenCompose = vi.fn();
    sdk.useAgentChat.mockReturnValue({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "tool-draft_message",
              toolCallId: "tool-1",
              state: "output-available",
              input: { fromAddress: "support@example.com" },
              output: {
                id: "draft-1",
                contextKey: "draft:draft-1",
                fromAddress: "support@example.com",
              },
            },
          ],
        },
      ],
      sendMessage: sdk.sendMessage,
      stop: sdk.stop,
      regenerate: sdk.regenerate,
      error: null,
      status: "ready",
      isStreaming: false,
    });

    renderPanel({ onOpenCompose });

    const badge = await screen.findByTestId("agent-tool-draft_message");
    fireEvent.click(badge);
    expect((await screen.findAllByText(/fromAddress/)).length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
    expect(onOpenCompose).toHaveBeenCalledWith(undefined, "draft:draft-1");
  });

  it("opens reply drafts through the mail reply-resume route, including an existing draft", async () => {
    vi.mocked(api.fetchDraft).mockResolvedValue({
      id: "reply-draft",
      contextKey: "reply:email-1",
      fromAddress: "support@example.com",
      toAddress: null,
      cc: null,
      subject: null,
      bodyHtml: "<p>kept</p>",
      bodyText: null,
      replyToEmailId: "email-1",
      updatedAt: 1,
    });
    sdk.useAgentChat.mockReturnValue({
      messages: [
        {
          id: "assistant-2",
          role: "assistant",
          parts: [
            {
              type: "tool-draft_reply",
              toolCallId: "tool-2",
              state: "output-available",
              input: { emailId: "email-1", bodyHtml: "<p>new</p>" },
              output: {
                saved: false,
                reason: "existing_draft",
                draftId: "reply-draft",
              },
            },
          ],
        },
      ],
      sendMessage: sdk.sendMessage,
      stop: sdk.stop,
      regenerate: sdk.regenerate,
      error: null,
      status: "ready",
      isStreaming: false,
    });

    const { router } = renderPanel();

    expect(
      await screen.findByText("Your existing draft was kept."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/mail/support%40example.com/inbox",
      ),
    );
    expect(router.state.location.search).toContain("m=received%3Aemail-1");
    expect(router.state.location.search).toContain("reply=1");
  });
});
