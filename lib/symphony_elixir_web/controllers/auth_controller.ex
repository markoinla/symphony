defmodule SymphonyElixirWeb.AuthController do
  @moduledoc """
  Handles session-based email+password authentication for the Symphony dashboard.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Accounts
  alias SymphonyElixirWeb.Plugs.RequireAuth

  @spec login(Conn.t(), map()) :: Conn.t()
  def login(conn, %{"email" => email, "password" => password})
      when is_binary(email) and is_binary(password) do
    case Accounts.authenticate_by_email_and_password(email, password) do
      {:ok, user} ->
        conn
        |> fetch_session()
        |> put_session(:user_id, user.id)
        |> configure_session(renew: true)
        |> json(%{ok: true, user: user_json(user)})

      {:error, :invalid_credentials} ->
        conn
        |> put_status(401)
        |> json(%{error: %{code: "unauthorized", message: "Invalid email or password"}})
    end
  end

  def login(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "bad_request", message: "Email and password are required"}})
  end

  @spec setup(Conn.t(), map()) :: Conn.t()
  def setup(conn, %{"email" => email, "password" => password} = params)
      when is_binary(email) and is_binary(password) do
    if Accounts.any_user_exists?() do
      conn
      |> put_status(409)
      |> json(%{error: %{code: "already_configured", message: "Setup is already complete"}})
    else
      name = Map.get(params, "name")

      with {:ok, user} <- Accounts.create_user_with_password(%{email: email, password: password, name: name}),
           {:ok, org} <- Accounts.create_default_organization(),
           {:ok, _membership} <- Accounts.add_user_to_organization(user.id, org.id, "owner") do
        conn
        |> fetch_session()
        |> put_session(:user_id, user.id)
        |> configure_session(renew: true)
        |> json(%{ok: true, user: user_json(user)})
      else
        {:error, changeset} ->
          conn
          |> put_status(422)
          |> json(%{error: %{code: "validation_error", message: changeset_errors(changeset)}})
      end
    end
  end

  def setup(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "bad_request", message: "Email and password are required"}})
  end

  @spec logout(Conn.t(), map()) :: Conn.t()
  def logout(conn, _params) do
    conn
    |> fetch_session()
    |> configure_session(drop: true)
    |> json(%{ok: true})
  end

  @spec status(Conn.t(), map()) :: Conn.t()
  def status(conn, _params) do
    auth_configured = RequireAuth.auth_configured?()

    if auth_configured do
      conn = fetch_session(conn)
      user_id = get_session(conn, :user_id)

      case user_id && Accounts.get_user(user_id) do
        {:ok, user} ->
          json(conn, %{authenticated: true, auth_required: true, user: user_json(user)})

        _ ->
          json(conn, %{authenticated: false, auth_required: true})
      end
    else
      json(conn, %{authenticated: true, auth_required: false})
    end
  end

  defp user_json(user) do
    %{id: user.id, email: user.email, name: user.name}
  end

  defp changeset_errors(%Ecto.Changeset{} = changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
    |> Enum.map_join("; ", fn {field, errors} -> "#{field}: #{Enum.join(errors, ", ")}" end)
  end
end
