export interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  clientIdSecret: string;
  clientSecretSecret: string;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  linear: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: "read write",
    clientIdSecret: "LINEAR_CLIENT_ID",
    clientSecretSecret: "LINEAR_CLIENT_SECRET",
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: "user:email repo",
    clientIdSecret: "GITHUB_CLIENT_ID",
    clientSecretSecret: "GITHUB_CLIENT_SECRET",
  },
};
