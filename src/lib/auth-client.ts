import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [adminClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
