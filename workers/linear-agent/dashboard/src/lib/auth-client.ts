// Better Auth client for the linear-agent dashboard.
//
// The Worker mounts the Better Auth handler at `/api/auth/*`. The
// client is configured with the organization plugin so the dashboard
// can list/create/switch orgs and read membership.
//
// Usage in components:
//
//   import { authClient } from "../lib/auth-client";
//   const { data: session, isPending } = authClient.useSession();
//
//   await authClient.signIn.email({ email, password });
//   await authClient.signUp.email({ email, password, name });
//   await authClient.signOut();
//   await authClient.organization.create({ name, slug });
//   await authClient.organization.setActive({ organizationId });

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // The dashboard is served from the same origin as the Worker. The
  // dev proxy in vite.config.ts forwards /api/auth/* to wrangler dev.
  baseURL:
    typeof window !== "undefined" ? window.location.origin : undefined,
  plugins: [organizationClient({ teams: { enabled: true } })],
});

export type AuthSession = NonNullable<
  ReturnType<typeof authClient.useSession>["data"]
>;
