defmodule SymphonyElixirWeb.AuthController do
  @moduledoc """
  Handles session-based password authentication for the Symphony dashboard.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Store
  alias SymphonyElixirWeb.Plugs.RequireAuth

  @spec login(Conn.t(), map()) :: Conn.t()
  def login(conn, %{"password" => password}) do
    case verify_password(password) do
      :ok ->
        conn
        |> fetch_session()
        |> put_session(:authenticated, true)
        |> configure_session(renew: true)
        |> json(%{ok: true})

      :not_configured ->
        conn
        |> put_status(500)
        |> json(%{error: %{code: "not_configured", message: "Authentication is not configured"}})

      :invalid ->
        conn
        |> put_status(401)
        |> json(%{error: %{code: "unauthorized", message: "Invalid password"}})
    end
  end

  def login(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "bad_request", message: "Password is required"}})
  end

  @spec setup(Conn.t(), map()) :: Conn.t()
  def setup(conn, %{"password" => password}) when is_binary(password) do
    if password_configured?() do
      conn
      |> put_status(409)
      |> json(%{error: %{code: "already_configured", message: "Password is already configured"}})
    else
      hash = Bcrypt.hash_pwd_salt(password)
      {:ok, _} = Store.put_setting("auth_password_hash", hash)

      conn
      |> fetch_session()
      |> put_session(:authenticated, true)
      |> configure_session(renew: true)
      |> json(%{ok: true})
    end
  end

  def setup(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "bad_request", message: "Password is required"}})
  end

  @spec change_password(Conn.t(), map()) :: Conn.t()
  def change_password(conn, %{"current_password" => current, "new_password" => new})
      when is_binary(current) and is_binary(new) do
    case verify_password(current) do
      :ok ->
        hash = Bcrypt.hash_pwd_salt(new)
        {:ok, _} = Store.put_setting("auth_password_hash", hash)
        json(conn, %{ok: true})

      _ ->
        conn
        |> put_status(401)
        |> json(%{error: %{code: "unauthorized", message: "Current password is incorrect"}})
    end
  end

  def change_password(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "bad_request", message: "current_password and new_password are required"}})
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
    authenticated =
      if RequireAuth.auth_configured?() do
        conn
        |> fetch_session()
        |> get_session(:authenticated)
        |> truthy?()
      else
        true
      end

    json(conn, %{
      authenticated: authenticated,
      auth_required: RequireAuth.auth_configured?(),
      password_configured: password_configured?()
    })
  end

  defp verify_password(password) do
    case Store.get_setting("auth_password_hash") do
      hash when is_binary(hash) ->
        if Bcrypt.verify_pass(password, hash), do: :ok, else: :invalid

      nil ->
        verify_env_password(password)
    end
  end

  defp verify_env_password(password) do
    case System.get_env("SYMPHONY_AUTH_PASSWORD") do
      nil -> :not_configured
      "" -> :not_configured
      expected -> if Plug.Crypto.secure_compare(password, expected), do: :ok, else: :invalid
    end
  end

  defp password_configured? do
    Store.get_setting("auth_password_hash") != nil or
      (System.get_env("SYMPHONY_AUTH_PASSWORD") || "") != ""
  end

  defp truthy?(true), do: true
  defp truthy?(_), do: false
end
