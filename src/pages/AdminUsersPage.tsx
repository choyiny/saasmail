import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import {
  fetchUsers,
  fetchInvites,
  createInvite,
  updateUserRole,
  deleteUser,
} from "@/lib/api";
import type { User, Invite } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("7");
  const [generatedLink, setGeneratedLink] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const [u, i] = await Promise.all([fetchUsers(), fetchInvites()]);
      setUsers(u);
      setInvites(i);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session?.user?.role === "admin") loadData();
  }, [session]);

  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  async function handleCreateInvite() {
    setInviteLoading(true);
    try {
      const invite = await createInvite({
        role: inviteRole,
        email: inviteEmail || undefined,
        expiresInDays: parseInt(inviteExpiry) || 7,
      });
      setGeneratedLink(`${window.location.origin}/invite/${invite.token}`);
      setCopied(false);
      await loadData();
    } catch {
      // ignore
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
  }

  async function handleRoleChange(userId: string, role: "admin" | "member") {
    await updateUserRole(userId, role);
    await loadData();
  }

  async function handleDelete(userId: string) {
    if (!confirm("Are you sure you want to delete this user?")) return;
    await deleteUser(userId);
    await loadData();
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleDateString();
  }

  function inviteStatus(invite: Invite): string {
    if (invite.usedBy) return "used";
    if (invite.expiresAt * 1000 < Date.now()) return "expired";
    return "pending";
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="rounded-lg border border-border bg-white ring-1 ring-gray-200">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-xs font-semibold text-text-primary">Users</h2>
            <Dialog
              open={inviteDialogOpen}
              onOpenChange={(open) => {
                setInviteDialogOpen(open);
                if (!open) {
                  setGeneratedLink("");
                  setInviteEmail("");
                  setInviteRole("member");
                  setInviteExpiry("7");
                }
              }}
            >
              <DialogTrigger asChild>
                <button className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">
                  Invite User
                </button>
              </DialogTrigger>
              <DialogContent className="border-border bg-white ring-1 ring-gray-200 text-text-primary">
                <DialogHeader>
                  <DialogTitle className="text-text-primary">
                    Create Invitation
                  </DialogTitle>
                </DialogHeader>
                {!generatedLink ? (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-text-secondary">
                        Role
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setInviteRole("member")}
                          className={`rounded-md px-3 py-1.5 text-xs ${
                            inviteRole === "member"
                              ? "bg-accent text-white"
                              : "border border-border text-text-secondary hover:bg-bg-muted"
                          }`}
                        >
                          Member
                        </button>
                        <button
                          onClick={() => setInviteRole("admin")}
                          className={`rounded-md px-3 py-1.5 text-xs ${
                            inviteRole === "admin"
                              ? "bg-accent text-white"
                              : "border border-border text-text-secondary hover:bg-bg-muted"
                          }`}
                        >
                          Admin
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-text-secondary">
                        Email (optional)
                      </label>
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder="user@example.com"
                        className="h-8 w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-text-secondary">
                        Expires in (days)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={inviteExpiry}
                        onChange={(e) => setInviteExpiry(e.target.value)}
                        className="h-8 w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </div>
                    <button
                      onClick={handleCreateInvite}
                      disabled={inviteLoading}
                      className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {inviteLoading ? "Creating..." : "Create Invite"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-text-secondary">
                      Share this link with the user:
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={generatedLink}
                        readOnly
                        className="h-8 flex-1 rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 text-xs text-text-primary focus:outline-none"
                      />
                      <button
                        onClick={handleCopy}
                        className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                      >
                        {copied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>
          <div>
            {loading ? (
              <p className="p-4 text-xs text-text-tertiary">Loading...</p>
            ) : (
              users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between border-b border-border px-4 py-2.5 last:border-b-0"
                >
                  <div>
                    <p className="text-xs font-medium text-text-primary">
                      {user.name}
                    </p>
                    <p className="text-[11px] text-text-tertiary">
                      {user.email}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        user.hasPasskey
                          ? "bg-accent/20 text-accent"
                          : "bg-bg-muted text-text-tertiary"
                      }`}
                    >
                      {user.hasPasskey ? "Passkey" : "No passkey"}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        user.role === "admin"
                          ? "bg-accent/20 text-accent"
                          : "border border-border text-text-tertiary"
                      }`}
                    >
                      {user.role || "member"}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {formatDate(user.createdAt)}
                    </span>
                    {user.id !== session?.user?.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="rounded px-1.5 py-0.5 text-xs text-text-tertiary hover:bg-bg-muted hover:text-text-secondary">
                            ...
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-white ring-1 ring-gray-200 border-border text-text-primary"
                        >
                          <DropdownMenuItem
                            onClick={() =>
                              handleRoleChange(
                                user.id,
                                user.role === "admin" ? "member" : "admin",
                              )
                            }
                            className="text-xs text-text-secondary focus:bg-bg-muted focus:text-text-primary"
                          >
                            Make {user.role === "admin" ? "member" : "admin"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(user.id)}
                            className="text-xs text-destructive focus:bg-bg-muted"
                          >
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-white ring-1 ring-gray-200">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-xs font-semibold text-text-primary">
              Invitations
            </h2>
          </div>
          <div>
            {invites.length === 0 ? (
              <p className="p-4 text-xs text-text-tertiary">
                No invitations yet.
              </p>
            ) : (
              invites.map((invite) => {
                const st = inviteStatus(invite);
                return (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between border-b border-border px-4 py-2.5 last:border-b-0"
                  >
                    <div>
                      <p className="text-xs font-medium text-text-primary">
                        {invite.email || "Any email"}
                      </p>
                      <p className="text-[10px] text-text-tertiary">
                        Role: {invite.role} | Expires:{" "}
                        {formatDate(invite.expiresAt)}
                      </p>
                    </div>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        st === "used"
                          ? "bg-accent/20 text-accent"
                          : st === "expired"
                            ? "bg-bg-muted text-text-tertiary"
                            : "border border-border text-text-secondary"
                      }`}
                    >
                      {st}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
