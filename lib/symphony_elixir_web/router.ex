defmodule SymphonyElixirWeb.Router do
  @moduledoc """
  Router for Symphony's JSON API and React dashboard SPA.
  """

  use Phoenix.Router

  pipeline :api do
    plug(:accepts, ["json"])
  end

  scope "/api/v1/webhooks", SymphonyElixirWeb do
    pipe_through(:api)
    post("/linear", WebhookController, :linear)
  end

  scope "/api/v1", SymphonyElixirWeb do
    get("/stream/dashboard", StreamController, :dashboard)
    get("/stream/session/:issue_id", StreamController, :session)
    match(:*, "/stream/dashboard", ObservabilityApiController, :method_not_allowed)
    match(:*, "/stream/session/:issue_id", ObservabilityApiController, :method_not_allowed)
  end

  # OAuth callback is a browser redirect, not a JSON API endpoint
  scope "/api/v1/oauth", SymphonyElixirWeb do
    get("/linear/callback", OAuthController, :callback)
  end

  scope "/api/v1", SymphonyElixirWeb do
    pipe_through(:api)

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
    get("/oauth/linear/authorize", OAuthController, :authorize)
    get("/oauth/linear/status", OAuthController, :status)
    post("/oauth/linear/revoke", OAuthController, :revoke)

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

  scope "/", SymphonyElixirWeb do
    get("/*path", SpaController, :index)
    match(:*, "/*path", ObservabilityApiController, :method_not_allowed)
  end
end
