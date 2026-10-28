import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProviderSettingsPanel from "@/components/ProviderSettingsPanel";
import {
  fetchIntegrations,
  saveIntegration,
  type ProviderSettings,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchIntegrations: vi.fn(),
  saveIntegration: vi.fn(),
}));

const mFetch = vi.mocked(fetchIntegrations);
const mSave = vi.mocked(saveIntegration);

const google = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  provider: "google",
  configured: false,
  source: null,
  clientId: null,
  hasClientSecret: false,
  tenant: null,
  redirectUri: "https://mail.example.com/api/admin/gmail/callback",
  connectedMailboxes: 0,
  updatedAt: null,
  ...over,
});

function respond(p: ProviderSettings, encryptionKeyConfigured = true) {
  mFetch.mockResolvedValue({ encryptionKeyConfigured, providers: [p] });
}

beforeEach(() => {
  mFetch.mockReset();
  mSave.mockReset();
});

describe("ProviderSettingsPanel", () => {
  it("opens by itself when Google is not set up, showing the redirect URI to register", async () => {
    respond(google());
    render(<ProviderSettingsPanel provider="google" />);

    expect(
      (await screen.findByTestId("google-settings-status")).textContent,
    ).toBe("Not set up");
    expect(screen.getByTestId("google-redirect-uri").textContent).toBe(
      "https://mail.example.com/api/admin/gmail/callback",
    );
    expect(screen.getByTestId("google-client-id")).toBeTruthy();
  });

  it("stays closed once set up, and keeps the stored secret when left blank", async () => {
    respond(
      google({
        configured: true,
        source: "database",
        clientId: "abc.apps.googleusercontent.com",
        hasClientSecret: true,
      }),
    );
    mSave.mockResolvedValue(
      google({ configured: true, source: "database", clientId: "abc" }),
    );
    render(<ProviderSettingsPanel provider="google" />);

    expect(
      (await screen.findByTestId("google-settings-status")).textContent,
    ).toBe("Set up");
    expect(screen.queryByTestId("google-client-id")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /google settings/i }));
    fireEvent.click(screen.getByTestId("google-settings-save"));

    await waitFor(() => expect(mSave).toHaveBeenCalled());
    expect(mSave).toHaveBeenCalledWith("google", {
      clientId: "abc.apps.googleusercontent.com",
    });
  });

  it("requires a secret before the first save, then sends it", async () => {
    respond(google());
    mSave.mockResolvedValue(google({ configured: true, source: "database" }));
    render(<ProviderSettingsPanel provider="google" />);

    fireEvent.change(await screen.findByTestId("google-client-id"), {
      target: { value: " id-1 " },
    });
    const save = screen.getByTestId(
      "google-settings-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("google-client-secret"), {
      target: { value: "s3cret" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(mSave).toHaveBeenCalledWith("google", {
        clientId: "id-1",
        clientSecret: "s3cret",
      }),
    );
    // The secret field is cleared once it has been sent.
    await waitFor(() =>
      expect(
        (screen.getByTestId("google-client-secret") as HTMLInputElement).value,
      ).toBe(""),
    );
  });

  it("asks for the secret again when moving settings off env vars", async () => {
    respond(
      google({
        configured: true,
        source: "env",
        clientId: "env-id",
        hasClientSecret: true,
      }),
    );
    render(<ProviderSettingsPanel provider="google" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /google settings/i }),
    );

    expect(screen.getByText(/GOOGLE_OAUTH_CLIENT_ID/)).toBeTruthy();
    expect(
      (screen.getByTestId("google-settings-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("warns that connected mailboxes need reconnecting when the client id changes", async () => {
    respond(
      google({
        configured: true,
        source: "database",
        clientId: "old-id",
        hasClientSecret: true,
        connectedMailboxes: 2,
      }),
    );
    render(<ProviderSettingsPanel provider="google" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /google settings/i }),
    );
    expect(screen.queryByTestId("google-client-change-warning")).toBeNull();

    fireEvent.change(screen.getByTestId("google-client-id"), {
      target: { value: "new-id" },
    });
    expect(
      screen.getByTestId("google-client-change-warning").textContent,
    ).toMatch(/2 mailboxes were connected/);
  });

  it("explains TOKEN_ENCRYPTION_KEY and disables the form without it", async () => {
    respond(google(), false);
    render(<ProviderSettingsPanel provider="google" />);

    expect(
      (await screen.findByTestId("google-settings-status")).textContent,
    ).toMatch(/TOKEN_ENCRYPTION_KEY/);
    expect(
      screen.getByText(/wrangler secret put TOKEN_ENCRYPTION_KEY/),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("google-client-id") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows the server's reason when saving fails", async () => {
    respond(google());
    mSave.mockRejectedValue(new Error("A client secret is required."));
    render(<ProviderSettingsPanel provider="google" />);

    fireEvent.change(await screen.findByTestId("google-client-id"), {
      target: { value: "id" },
    });
    fireEvent.change(screen.getByTestId("google-client-secret"), {
      target: { value: "s" },
    });
    fireEvent.click(screen.getByTestId("google-settings-save"));

    expect((await screen.findByTestId("google-save-error")).textContent).toBe(
      "A client secret is required.",
    );
  });
});
