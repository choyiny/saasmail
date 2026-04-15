import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [adminClient(), passkeyClient(), oauthProviderClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
