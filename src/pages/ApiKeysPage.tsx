import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  type ApiKey,
  type CreatedApiKey,
} from "@/lib/api";

function formatDate(ts: number | null) {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

function keyStatus(k: ApiKey): { label: string; tone: string } {
  if (k.revokedAt) return { label: "Revoked", tone: "text-red-600" };
  if (k.expiresAt && k.expiresAt < Date.now())
    return { label: "Expired", tone: "text-red-600" };
  return { label: "Active", tone: "text-green-600" };
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<CreatedApiKey | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const { data: keys, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: fetchApiKeys,
  });

  const createMutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (created) => {
      setNewKey(created);
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      setRevokingId(null);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-neutral-500 hover:underline">
            &larr; Back
          </Link>
          <h1 className="text-lg font-semibold">API Keys</h1>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          Create API key
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl">
          <p className="mb-6 text-sm text-neutral-600">
            API keys let you authenticate programmatic requests to the cmail API.
            Pass the key in the <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs">Authorization</code> header:
            <br />
            <code className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 text-xs">
              Authorization: Bearer cmail_&lt;your-key&gt;
            </code>
          </p>

          {isLoading ? (
            <p className="text-neutral-500">Loading...</p>
          ) : !keys || keys.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-neutral-500">
              <p>You don't have any API keys yet.</p>
              <Button
                className="mt-4"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                Create your first key
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Key</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Last used</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 font-medium">Expires</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const status = keyStatus(k);
                    const disabled = !!k.revokedAt;
                    return (
                      <tr key={k.id} className="border-t">
                        <td className="px-4 py-3 font-medium">{k.name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                          {k.keyPrefix}...
                        </td>
                        <td className={`px-4 py-3 ${status.tone}`}>
                          {status.label}
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          {formatDate(k.lastUsedAt)}
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          {formatDate(k.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          {k.expiresAt ? formatDate(k.expiresAt) : "Never"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!disabled && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              onClick={() => setRevokingId(k.id)}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <CreateApiKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => createMutation.mutate(input)}
        pending={createMutation.isPending}
        error={
          createMutation.error instanceof Error
            ? createMutation.error.message
            : null
        }
      />

      <NewKeyDialog
        createdKey={newKey}
        onClose={() => setNewKey(null)}
      />

      <RevokeConfirmDialog
        keyToRevoke={keys?.find((k) => k.id === revokingId) ?? null}
        onCancel={() => setRevokingId(null)}
        onConfirm={() => {
          if (revokingId) revokeMutation.mutate(revokingId);
        }}
        pending={revokeMutation.isPending}
      />
    </div>
  );
}

function CreateApiKeyDialog({
  open,
  onClose,
  onCreate,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; expiresInDays?: number }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("");

  function handleClose() {
    if (pending) return;
    setName("");
    setExpiresInDays("");
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            Give the key a memorable name. The full key will be shown once after
            creation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="e.g. CLI script"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="expires">Expires in (days, optional)</Label>
            <Input
              id="expires"
              type="number"
              min={1}
              max={3650}
              placeholder="Never"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating..." : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewKeyDialog({
  createdKey,
  onClose,
}: {
  createdKey: CreatedApiKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  function handleClose() {
    setCopied(false);
    onClose();
  }

  return (
    <Dialog
      open={!!createdKey}
      onOpenChange={(v) => !v && handleClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your new API key</DialogTitle>
          <DialogDescription>
            Copy this key now. You won't be able to see it again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-neutral-50 p-3">
            <code className="break-all font-mono text-xs">
              {createdKey?.key}
            </code>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={handleClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeConfirmDialog({
  keyToRevoke,
  onCancel,
  onConfirm,
  pending,
}: {
  keyToRevoke: ApiKey | null;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog
      open={!!keyToRevoke}
      onOpenChange={(v) => !v && !pending && onCancel()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke API key?</DialogTitle>
          <DialogDescription>
            Revoking{" "}
            <span className="font-medium">{keyToRevoke?.name}</span> will
            immediately invalidate it. Any applications using this key will stop
            working. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Revoking..." : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
