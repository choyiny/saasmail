import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
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

function avatarColor(seed: string): { bg: string; fg: string } {
  // Same opaque palette as the group-thread avatars so identity colors
  // feel consistent across the app.
  const PALETTE = [
    { bg: "#efebff", fg: "#5b3ce6" },
    { bg: "#e4f8ec", fg: "#15803d" },
    { bg: "#fdebf5", fg: "#be185d" },
    { bg: "#fef0e4", fg: "#c2410c" },
    { bg: "#e3f6fe", fg: "#0369a1" },
    { bg: "#f3e7fe", fg: "#7e22ce" },
    { bg: "#def5f3", fg: "#0f766e" },
    { bg: "#fcf3d7", fg: "#a16207" },
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

type InviteStatus = "pending" | "used" | "expired";
function inviteStatus(invite: Invite): InviteStatus {
  if (invite.usedBy) return "used";
  if (invite.expiresAt * 1000 < Date.now()) return "expired";
  return "pending";
}

const INVITE_STATUS_META: Record<
  InviteStatus,
  { label: string; chipClass: string; color: string }
> = {
  pending: {
    label: "Pending",
    chipClass: "bg-emerald-50 ring-emerald-200/60 dark:bg-emerald-500/10",
    color: "#047857",
  },
  used: {
    label: "Accepted",
    chipClass: "bg-violet/10 ring-violet/20",
    color: "#7c5cfc",
  },
  expired: {
    label: "Expired",
    chipClass: "bg-bg-muted ring-border",
    color: "#6b7280",
  },
};

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
              <button className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90">
                <Plus size={14} />
                Invite user
              </button>
            </DialogTrigger>
            <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
              <DialogHeader>
                <DialogTitle className="text-text-primary">
                  {generatedLink ? "Invitation ready" : "Create invitation"}
                </DialogTitle>
              </DialogHeader>
              {!generatedLink ? (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
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
                      className="block text-[11px] font-medium uppercase tracking-wider text-text-tertiary"
                    >
                      Email{" "}
                      <span className="text-text-tertiary/60">— optional</span>
                    </label>
                    <input
                      id="invite-email"
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
                    />
                    <p className="text-[11px] font-light text-text-tertiary">
                      Lock the invite to one address, or leave blank for any
                      teammate to accept.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="invite-expiry"
                      className="block text-[11px] font-medium uppercase tracking-wider text-text-tertiary"
                    >
                      Expires in (days)
                    </label>
                    <input
                      id="invite-expiry"
                      type="number"
                      min="1"
                      max="30"
                      value={inviteExpiry}
                      onChange={(e) => setInviteExpiry(e.target.value)}
                      className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
                    />
                  </div>

                  <button
                    onClick={handleCreateInvite}
                    disabled={inviteLoading}
                    className="w-full rounded-[8px] bg-text-primary py-2 text-sm font-medium text-white transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {inviteLoading ? "Creating…" : "Create invite"}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs font-light text-text-secondary">
                    Share this link — it expires in {inviteExpiry} day
                    {inviteExpiry === "1" ? "" : "s"}.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={generatedLink}
                      readOnly
                      className="h-10 flex-1 rounded-[6px] border border-border bg-bg-subtle px-3 text-xs text-text-primary focus:outline-none"
                    />
                    <button
                      onClick={handleCopy}
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        }
      />

      <div className="max-w-4xl space-y-6">
        {/* --- Members --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Users}
              title={`Members (${users.length})`}
              subtitle="Everyone with a login on this saasmail instance."
            />
          </div>

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              Loading…
            </p>
          ) : users.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members yet"
              hint="Invite your first teammate above."
            />
          ) : (
            <ul className="divide-y divide-border/60">
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
                        <p className="truncate text-sm font-medium text-text-primary">
                          {user.name || user.email}
                        </p>
                        {isMe && (
                          <span className="inline-flex items-center rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
                            you
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
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
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="border-border bg-card text-text-primary ring-1 ring-border"
                        >
                          <DropdownMenuItem
                            onClick={() =>
                              handleRoleChange(
                                user.id,
                                isAdmin ? "member" : "admin",
                              )
                            }
                            className="text-xs text-text-secondary focus:bg-bg-muted focus:text-text-primary"
                          >
                            Make {isAdmin ? "member" : "admin"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(user.id)}
                            className="text-xs text-destructive focus:bg-bg-muted"
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
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
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
            <ul className="divide-y divide-border/60">
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                const meta = INVITE_STATUS_META[status];
                return (
                  <li
                    key={invite.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <Mail size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {invite.email || "Open invite"}
                        </p>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                            meta.chipClass,
                          )}
                          style={{ color: meta.color }}
                        >
                          {meta.label}
                        </span>
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
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
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="border-border bg-card text-text-primary ring-1 ring-border"
                        >
                          <DropdownMenuItem
                            onClick={() => handleRevoke(invite.id)}
                            className="text-xs text-destructive focus:bg-bg-muted"
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
      onClick={onClick}
      className={cn(
        "rounded-[8px] border px-3 py-2 text-left transition-colors",
        active
          ? "border-text-primary/30 bg-text-primary/5"
          : "border-border bg-card hover:bg-bg-muted",
      )}
    >
      <span
        className={cn(
          "block text-xs font-semibold",
          active ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {label}
      </span>
      <span className="block text-[11px] font-light text-text-tertiary">
        {hint}
      </span>
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
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
        active
          ? "bg-violet/10 ring-violet/20"
          : "bg-bg-muted ring-border text-text-tertiary",
      )}
      style={active ? { color: "#7c5cfc" } : undefined}
    >
      <Icon size={9} />
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
    <div className="px-5 py-10 text-center">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-violet/10">
        <Icon size={16} style={{ color: "#7c5cfc" }} />
      </span>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-1 text-xs font-light text-text-tertiary">{hint}</p>
    </div>
  );
}
