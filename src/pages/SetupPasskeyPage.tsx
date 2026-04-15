import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
    <div className="flex min-h-screen items-center justify-center bg-main">
      <Card className="w-full max-w-sm border-border-dark bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">
            Register a Passkey
          </CardTitle>
          <p className="text-xs text-text-secondary">
            For security, you must register a passkey before accessing cmail.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleRegister}
            disabled={loading}
          >
            {loading ? "Registering..." : "Register Passkey"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
