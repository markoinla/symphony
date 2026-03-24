defmodule SymphonyElixirWeb.ErrorHelpers do
  @moduledoc """
  Standardizes API error responses into a consistent JSON format.

  All error responses follow this structure:

      %{
        error: %{
          code: "ERROR_CODE",
          message: "Human-readable message",
          request_id: "uuid"
        }
      }
  """

  import Phoenix.Controller, only: [json: 2]
  import Plug.Conn, only: [put_status: 2]

  @spec error_response(Plug.Conn.t(), integer() | atom(), String.t(), String.t()) :: Plug.Conn.t()
  def error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message, request_id: conn.assigns[:request_id]}})
  end

  @spec changeset_error_response(Plug.Conn.t(), String.t(), String.t(), Ecto.Changeset.t()) ::
          Plug.Conn.t()
  def changeset_error_response(conn, code, message, changeset) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{
      error: %{
        code: code,
        message: message,
        request_id: conn.assigns[:request_id],
        details: Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
      }
    })
  end
end
