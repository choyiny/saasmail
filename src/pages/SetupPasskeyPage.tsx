import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Register a Passkey</CardTitle>
          <p className="text-sm text-neutral-500">
            For security, you must register a passkey before accessing cmail.
            This will be used for all future sign-ins.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button
            className="w-full"
            onClick={handleRegister}
            disabled={loading}
          >
            {loading ? "Registering..." : "Register Passkey"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
