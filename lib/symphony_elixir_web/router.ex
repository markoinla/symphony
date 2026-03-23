defmodule SymphonyElixirWeb.Router do
  @moduledoc """
  Router for Symphony's JSON API and React dashboard SPA.
  """

  use Phoenix.Router

  pipeline :api do
    plug(:accepts, ["json"])
  end

  pipeline :authenticated_api do
    plug(:accepts, ["json"])
    plug(SymphonyElixirWeb.Plugs.RequireAuth)
  end

  pipeline :authenticated_stream do
    plug(SymphonyElixirWeb.Plugs.RequireAuth)
  end

  pipeline :authenticated_browser do
    plug(SymphonyElixirWeb.Plugs.RequireAuth)
  end

  # Public: health check (no auth required)
  scope "/", SymphonyElixirWeb do
    pipe_through(:api)
    get("/healthz", ObservabilityApiController, :healthz)
  end

  # Public: auth endpoints (no auth required)
  scope "/api/v1/auth", SymphonyElixirWeb do
    pipe_through(:api)
    post("/login", AuthController, :login)
    post("/logout", AuthController, :logout)
    get("/status", AuthController, :status)
  end

  # Public: webhooks have their own HMAC auth
  scope "/api/v1/webhooks", SymphonyElixirWeb do
    pipe_through(:api)
    post("/linear", WebhookController, :linear)
  end

  # Public: OAuth callbacks are browser redirects
  scope "/api/v1/oauth", SymphonyElixirWeb do
    get("/linear/callback", OAuthController, :callback)
    get("/github/callback", GitHubOAuthController, :callback)
  end

  # Authenticated: SSE streams
  scope "/api/v1", SymphonyElixirWeb do
    pipe_through(:authenticated_stream)
    get("/stream/dashboard", StreamController, :dashboard)
    get("/stream/session/:issue_id", StreamController, :session)
    match(:*, "/stream/dashboard", ObservabilityApiController, :method_not_allowed)
    match(:*, "/stream/session/:issue_id", ObservabilityApiController, :method_not_allowed)
  end

  # Authenticated: main API
  scope "/api/v1", SymphonyElixirWeb do
    pipe_through(:authenticated_api)

    get("/state", ObservabilityApiController, :state)
    post("/refresh", ObservabilityApiController, :refresh)
    get("/sessions", ObservabilityApiController, :sessions)
    get("/projects", ProjectApiController, :index)
    post("/projects", ProjectApiController, :create)
    get("/projects/:id", ProjectApiController, :show)
    put("/projects/:id", ProjectApiController, :update)
    delete("/projects/:id", ProjectApiController, :delete)
    get("/settings", SettingsApiController, :index)
    put("/settings/:key", SettingsApiController, :upsert)
    delete("/settings/:key", SettingsApiController, :delete)
    get("/linear/projects", LinearApiController, :search_projects)
    get("/oauth/linear/authorize", OAuthController, :authorize)
    get("/oauth/linear/status", OAuthController, :status)
    post("/oauth/linear/revoke", OAuthController, :revoke)
    get("/oauth/github/authorize", GitHubOAuthController, :authorize)
    get("/oauth/github/status", GitHubOAuthController, :status)
    post("/oauth/github/revoke", GitHubOAuthController, :revoke)

    match(:*, "/state", ObservabilityApiController, :method_not_allowed)
    match(:*, "/refresh", ObservabilityApiController, :method_not_allowed)
    match(:*, "/sessions", ObservabilityApiController, :method_not_allowed)
    match(:*, "/projects", ObservabilityApiController, :method_not_allowed)
    match(:*, "/projects/:id", ObservabilityApiController, :method_not_allowed)
    match(:*, "/settings", ObservabilityApiController, :method_not_allowed)
    match(:*, "/settings/:key", ObservabilityApiController, :method_not_allowed)
    get("/:issue_identifier/messages", ObservabilityApiController, :messages)
    match(:*, "/:issue_identifier/messages", ObservabilityApiController, :method_not_allowed)
    get("/:issue_identifier", ObservabilityApiController, :issue)
    match(:*, "/:issue_identifier", ObservabilityApiController, :method_not_allowed)
    match(:*, "/*path", ObservabilityApiController, :not_found)
  end

  # SPA catch-all (auth checked client-side via /api/v1/auth/status)
  scope "/", SymphonyElixirWeb do
    get("/*path", SpaController, :index)
    match(:*, "/*path", ObservabilityApiController, :method_not_allowed)
  end
end
