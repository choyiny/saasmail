import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type Status = "checking" | "available" | "unavailable";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("checking");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as { setupRequired: boolean };
        if (cancelled) return;
        setStatus(data.setupRequired ? "available" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Setup failed");
        if (res.status === 403) setStatus("unavailable");
        return;
      }
      const result = await signIn.emailAndPassword({ email, password });
      if (result.error) {
        // Account created but auto sign-in failed — send to login.
        navigate("/login", { replace: true });
        return;
      }
      window.location.href = "/setup-passkey";
    } catch {
      setError("Setup failed");
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">Setup complete</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-neutral-600">
              An administrator account already exists for this instance. Please
              sign in instead.
            </p>
            <Button className="w-full" onClick={() => navigate("/login")}>
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Welcome to cmail</CardTitle>
          <p className="text-sm text-neutral-500">
            Create the first administrator account to get started.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <p className="text-xs text-neutral-500">
                At least 8 characters.
              </p>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating account..." : "Create administrator"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
