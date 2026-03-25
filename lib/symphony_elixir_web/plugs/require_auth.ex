defmodule SymphonyElixirWeb.Plugs.RequireAuth do
  @moduledoc """
  Plug that enforces session-based user authentication.

  Loads the current user from `user_id` in the session and assigns it to
  `conn.assigns.current_user`. When no users exist in the database,
  authentication is not required and all requests pass through.

  For API routes (path starts with /api/), returns 401 JSON.
  For browser routes, redirects to `/login`.
  """

  import Plug.Conn

  alias SymphonyElixir.Accounts

  @behaviour Plug

  @impl true
  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @impl true
  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    if auth_configured?() do
      conn
      |> fetch_session()
      |> load_user()
    else
      conn
    end
  end

  defp load_user(conn) do
    user_id = get_session(conn, :user_id)

    case user_id && Accounts.get_user(user_id) do
      {:ok, user} ->
        org = Accounts.get_user_organization(user.id)

        conn
        |> assign(:current_user, user)
        |> assign(:current_org, org)

      _ ->
        reject(conn)
    end
  end

  defp reject(conn) do
    if api_request?(conn) do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(401, Jason.encode!(%{error: %{code: "unauthorized", message: "Authentication required"}}))
      |> halt()
    else
      conn
      |> Phoenix.Controller.redirect(to: "/login")
      |> halt()
    end
  end

  defp api_request?(conn) do
    String.starts_with?(conn.request_path, "/api/")
  end

  @spec auth_configured?() :: boolean()
  def auth_configured? do
    Accounts.any_user_exists?()
  end
end
