import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { WordmarkLarge } from "@/components/Wordmark";

export default function SetupPasskeyPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    setLoading(true);
    setError("");
    try {
      const result = await authClient.passkey.addPasskey();
      if (result?.error) {
        setError(result.error.message || "Passkey registration failed");
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Passkey registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
      <WordmarkLarge />
      <div className="pt-auth-card">
        <div className="mb-6">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
            Register a passkey
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-secondary">
            For security, you must register a passkey before accessing saasmail.
          </p>
        </div>
        {error && (
          <p
            className="mb-4 rounded-lg border border-destructive/25 bg-destructive-subtle px-3 py-2 text-[13px] text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
        <button
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          onClick={handleRegister}
          disabled={loading}
        >
          {loading ? "Registering…" : "Register passkey"}
        </button>
      </div>
    </div>
  );
}
