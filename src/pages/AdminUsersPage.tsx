import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import {
  fetchUsers,
  fetchInvites,
  createInvite,
  updateUserRole,
  deleteUser,
} from "@/lib/api";
import type { User, Invite } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    if (session?.user?.role === "admin") {
      loadData();
    }
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
      const link = `${window.location.origin}/invite/${invite.token}`;
      setGeneratedLink(link);
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
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold">
          <Link to="/">cmail</Link>
        </h1>
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            Inbox
          </Link>
          <Link
            to="/templates"
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            Templates
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Users</CardTitle>
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
                  <Button size="sm">Invite User</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Invitation</DialogTitle>
                  </DialogHeader>
                  {!generatedLink ? (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Role</Label>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant={
                              inviteRole === "member" ? "default" : "outline"
                            }
                            onClick={() => setInviteRole("member")}
                          >
                            Member
                          </Button>
                          <Button
                            size="sm"
                            variant={
                              inviteRole === "admin" ? "default" : "outline"
                            }
                            onClick={() => setInviteRole("admin")}
                          >
                            Admin
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="invite-email">
                          Email (optional — restricts who can accept)
                        </Label>
                        <Input
                          id="invite-email"
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="user@example.com"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="invite-expiry">Expires in (days)</Label>
                        <Input
                          id="invite-expiry"
                          type="number"
                          min="1"
                          max="30"
                          value={inviteExpiry}
                          onChange={(e) => setInviteExpiry(e.target.value)}
                        />
                      </div>
                      <Button
                        className="w-full"
                        onClick={handleCreateInvite}
                        disabled={inviteLoading}
                      >
                        {inviteLoading ? "Creating..." : "Create Invite"}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-sm text-neutral-600">
                        Share this link with the user:
                      </p>
                      <div className="flex gap-2">
                        <Input value={generatedLink} readOnly />
                        <Button size="sm" variant="outline" onClick={handleCopy}>
                          {copied ? "Copied!" : "Copy"}
                        </Button>
                      </div>
                    </div>
                  )}
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-neutral-500">Loading...</p>
              ) : (
                <div className="divide-y">
                  {users.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between py-3"
                    >
                      <div>
                        <p className="font-medium">{user.name}</p>
                        <p className="text-sm text-neutral-500">{user.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            user.hasPasskey ? "default" : "secondary"
                          }
                        >
                          {user.hasPasskey ? "Passkey" : "No passkey"}
                        </Badge>
                        <Badge
                          variant={
                            user.role === "admin" ? "default" : "outline"
                          }
                        >
                          {user.role || "member"}
                        </Badge>
                        <span className="text-xs text-neutral-400">
                          {formatDate(user.createdAt)}
                        </span>
                        {user.id !== session?.user?.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                ...
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  handleRoleChange(
                                    user.id,
                                    user.role === "admin" ? "member" : "admin",
                                  )
                                }
                              >
                                Make{" "}
                                {user.role === "admin" ? "member" : "admin"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleDelete(user.id)}
                                className="text-red-600"
                              >
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Invitations</CardTitle>
            </CardHeader>
            <CardContent>
              {invites.length === 0 ? (
                <p className="text-sm text-neutral-500">No invitations yet.</p>
              ) : (
                <div className="divide-y">
                  {invites.map((invite) => {
                    const st = inviteStatus(invite);
                    return (
                      <div
                        key={invite.id}
                        className="flex items-center justify-between py-3"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {invite.email || "Any email"}
                          </p>
                          <p className="text-xs text-neutral-500">
                            Role: {invite.role} | Expires:{" "}
                            {formatDate(invite.expiresAt)}
                          </p>
                        </div>
                        <Badge
                          variant={
                            st === "used"
                              ? "default"
                              : st === "expired"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {st}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
