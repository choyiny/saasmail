import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import {
  Check,
  Copy,
  Fingerprint,
  Mail,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import {
  fetchUsers,
  fetchInvites,
  createInvite,
  updateUserRole,
  deleteUser,
  revokeInvite,
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
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";
import { avatarColor, initials } from "@/lib/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString();
}

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600) return diff < 0 ? "just now" : "in <1h";
  if (abs < 86400)
    return diff < 0
      ? `${Math.floor(abs / 3600)}h ago`
      : `in ${Math.floor(abs / 3600)}h`;
  const days = Math.floor(abs / 86400);
  return diff < 0 ? `${days}d ago` : `in ${days}d`;
}

type InviteStatus = "pending" | "used" | "expired";
function inviteStatus(invite: Invite): InviteStatus {
  if (invite.usedBy) return "used";
  if (invite.expiresAt * 1000 < Date.now()) return "expired";
  return "pending";
}

const INVITE_STATUS_META: Record<
  InviteStatus,
  { label: string; chip: string }
> = {
  pending: { label: "Pending", chip: "ok" },
  used: { label: "Accepted", chip: "accent" },
  expired: { label: "Expired", chip: "" },
};

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  // `?invite=1` (the command palette's "Invite a teammate") opens the
  // invite dialog, on arrival or while already on this page. The param is
  // dropped once read, so asking again changes the URL and reopens it.
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteParam = searchParams.get("invite") === "1";
  useEffect(() => {
    if (!inviteParam) return;
    setInviteDialogOpen(true);
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.delete("invite");
        return sp;
      },
      { replace: true },
    );
  }, [inviteParam, setSearchParams]);
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
    if (!confirm("Delete this user? This can't be undone.")) return;
    await deleteUser(userId);
    await loadData();
  }

  async function handleRevoke(inviteId: string) {
    if (!confirm("Revoke this invitation? This cannot be undone.")) return;
    await revokeInvite(inviteId);
    await loadData();
  }

  return (
    <PageContainer>
      <PageHeader
        title="Users"
        subtitle="Invite teammates, manage roles, and track passkey adoption."
        action={
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
              <Button>
                <Plus />
                Invite user
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {generatedLink ? "Invitation ready" : "Create invitation"}
                </DialogTitle>
              </DialogHeader>
              {!generatedLink ? (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <span className="block text-[13px] font-medium text-text-primary">
                      Role
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <RoleButton
                        active={inviteRole === "member"}
                        onClick={() => setInviteRole("member")}
                        label="Member"
                        hint="Limited inboxes"
                      />
                      <RoleButton
                        active={inviteRole === "admin"}
                        onClick={() => setInviteRole("admin")}
                        label="Admin"
                        hint="Full access"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="invite-email"
                      className="block text-[13px] font-medium text-text-primary"
                    >
                      Email{" "}
                      <span className="font-normal text-text-tertiary">
                        (optional)
                      </span>
                    </label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="user@example.com"
                    />
                    <p className="text-xs text-text-tertiary">
                      Lock the invite to one address, or leave blank for any
                      teammate to accept.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="invite-expiry"
                      className="block text-[13px] font-medium text-text-primary"
                    >
                      Expires in (days)
                    </label>
                    <Input
                      id="invite-expiry"
                      type="number"
                      min="1"
                      max="30"
                      value={inviteExpiry}
                      onChange={(e) => setInviteExpiry(e.target.value)}
                      className="tabular"
                    />
                  </div>

                  <Button
                    onClick={handleCreateInvite}
                    disabled={inviteLoading}
                    size="lg"
                    className="w-full"
                  >
                    {inviteLoading ? "Creating…" : "Create invite"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-[13px] text-text-secondary">
                    Share this link — it expires in {inviteExpiry} day
                    {inviteExpiry === "1" ? "" : "s"}.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={generatedLink}
                      readOnly
                      className="font-code flex-1 bg-bg-subtle text-xs"
                    />
                    <Button variant="outline" onClick={handleCopy}>
                      {copied ? <Check /> : <Copy />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        }
      />

      <div className="max-w-4xl space-y-5">
        {/* --- Members --- */}
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Users}
              title={`Members (${users.length})`}
              subtitle="Everyone with a login on this saasmail instance."
            />
          </div>

          {loading ? (
            <div className="space-y-3 px-5 py-4" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="pt-skel h-9 w-9 rounded-full" />
                  <span className="flex-1 space-y-1.5">
                    <span className="pt-skel h-3 w-1/3" />
                    <span className="pt-skel h-2.5 w-1/2" />
                  </span>
                </div>
              ))}
            </div>
          ) : users.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members yet"
              hint="Invite your first teammate above."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {users.map((user) => {
                const color = avatarColor(user.email);
                const isMe = user.id === session?.user?.id;
                const isAdmin = user.role === "admin";
                return (
                  <li
                    key={user.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                      style={{
                        backgroundColor: color.bg,
                        color: color.fg,
                      }}
                    >
                      {initials(user.name, user.email)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[14px] font-medium text-text-primary">
                          {user.name || user.email}
                        </p>
                        {isMe && <span className="pt-chip">You</span>}
                      </div>
                      <p className="truncate text-[13px] text-text-tertiary">
                        {user.email} · joined {formatDate(user.createdAt)}
                      </p>
                    </div>

                    <div className="hidden shrink-0 items-center gap-2 sm:flex">
                      <UserBadge
                        active={user.hasPasskey}
                        icon={Fingerprint}
                        labelOn="Passkey"
                        labelOff="No passkey"
                      />
                      <UserBadge
                        active={isAdmin}
                        icon={ShieldCheck}
                        labelOn="Admin"
                        labelOff="Member"
                      />
                    </div>

                    {!isMe && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            aria-label="More actions"
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              handleRoleChange(
                                user.id,
                                isAdmin ? "member" : "admin",
                              )
                            }
                          >
                            Make {isAdmin ? "member" : "admin"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(user.id)}
                            className="text-destructive focus:bg-destructive-subtle focus:text-destructive"
                          >
                            Delete user
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* --- Invitations --- */}
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Mail}
              title={`Invitations (${invites.length})`}
              subtitle="Outstanding and historical invites."
            />
          </div>

          {invites.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="No invitations yet"
              hint="Create one above to onboard your first teammate."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                const meta = INVITE_STATUS_META[status];
                return (
                  <li
                    key={invite.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <Mail size={15} className="text-text-secondary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[14px] font-medium text-text-primary">
                          {invite.email || "Open invite"}
                        </p>
                        <span className={cn("pt-chip", meta.chip)}>
                          {meta.label}
                        </span>
                      </div>
                      <p className="truncate text-[13px] text-text-tertiary">
                        {invite.role} ·{" "}
                        {status === "expired"
                          ? `expired ${formatDate(invite.expiresAt)}`
                          : status === "used"
                            ? `accepted ${invite.usedAt ? formatDate(invite.usedAt) : ""}`
                            : `expires ${relativeTime(invite.expiresAt)}`}
                      </p>
                    </div>
                    {status === "pending" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            aria-label="More actions"
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleRevoke(invite.id)}
                            className="text-destructive focus:bg-destructive-subtle focus:text-destructive"
                          >
                            Revoke invitation
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  );
}

/* --------------------------------- helpers --------------------------------- */

function RoleButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "rounded-xl border px-3 py-2.5 text-left transition-[border-color,box-shadow,background-color]",
        active
          ? "border-accent bg-accent-subtle/50 shadow-[0_0_0_1px_var(--sm-accent)]"
          : "border-border bg-card hover:border-border-strong",
      )}
    >
      <span className="block text-[13.5px] font-semibold text-text-primary">
        {label}
      </span>
      <span className="block text-xs text-text-secondary">{hint}</span>
    </button>
  );
}

function UserBadge({
  active,
  icon: Icon,
  labelOn,
  labelOff,
}: {
  active: boolean;
  icon: React.ElementType;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <span className={cn("pt-chip", active ? "accent" : "")}>
      <Icon />
      {active ? labelOn : labelOff}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint: string;
}) {
  return (
    <div className="pt-empty">
      <span className="ic">
        <Icon size={18} />
      </span>
      <p className="font-medium text-text-primary">{title}</p>
      <p className="-mt-2 text-[13px]">{hint}</p>
    </div>
  );
}
