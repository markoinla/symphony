defmodule SymphonyElixirWeb.FallbackController do
  @moduledoc """
  Fallback controller that returns structured error responses.

  Used in two ways:

  1. **Router catch-all** — named actions (`not_found/2`, `method_not_allowed/2`)
     handle unmatched routes and disallowed methods.
  2. **`action_fallback`** — `call/2` clauses handle common error tuples returned
     from controller actions.
  """

  use Phoenix.Controller, formats: [:json]

  import SymphonyElixirWeb.ErrorHelpers, only: [error_response: 4, changeset_error_response: 4]

  # -- Router catch-all actions --

  @spec not_found(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def not_found(conn, _params) do
    error_response(conn, 404, "not_found", "Route not found")
  end

  @spec method_not_allowed(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def method_not_allowed(conn, _params) do
    error_response(conn, 405, "method_not_allowed", "Method not allowed")
  end

  # -- action_fallback handlers --

  @spec call(Plug.Conn.t(), {:error, atom() | Ecto.Changeset.t()}) :: Plug.Conn.t()
  def call(conn, {:error, :not_found}) do
    error_response(conn, 404, "not_found", "Resource not found")
  end

  def call(conn, {:error, :bad_request}) do
    error_response(conn, 400, "bad_request", "Bad request")
  end

  def call(conn, {:error, %Ecto.Changeset{} = changeset}) do
    changeset_error_response(conn, "validation_error", "Validation failed", changeset)
  end
end
