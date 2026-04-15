import { createAuthClient } from "better-auth/react";
import { adminClient, invitationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [adminClient(), invitationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
