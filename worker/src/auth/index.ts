import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";

export function createAuth(env?: CloudflareBindings) {
  const db = env ? drizzle(env.DB, { schema, logger: true }) : ({} as any);

  return betterAuth({
    baseURL: env?.BASE_URL || "https://mail.givefeedback.dev",
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    plugins: [
      admin(),
      openAPI(),
      passkey(),
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
    advanced: {
      cookiePrefix: "cmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: [
      "http://localhost:8080",
      "https://mail.givefeedback.dev",
    ],
  });
}

export const auth = createAuth();
