import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, invitation } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { Resend } from "resend";

export function createAuth(env?: CloudflareBindings) {
  const db = env ? drizzle(env.DB, { schema, logger: true }) : ({} as any);
  const resend = env ? new Resend(env.RESEND_API_KEY) : null;
  const fromEmail = env?.RESEND_EMAIL_FROM!;

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      admin(),
      openAPI(),
      invitation({
        sendInvitationEmail: async ({ email, invitedBy, url }) => {
          if (!resend) return;
          await resend.emails.send({
            from: fromEmail,
            to: email,
            subject: `You've been invited to cmail`,
            html: `<p>${invitedBy.name || invitedBy.email} invited you to cmail.</p><p><a href="${url}">Accept invitation</a></p>`,
          });
        },
      }),
    ],
    advanced: {
      cookiePrefix: "cmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: [
      "http://localhost:8080",
    ],
  });
}

export const auth = createAuth();
