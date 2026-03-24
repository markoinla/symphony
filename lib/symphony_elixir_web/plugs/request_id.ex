defmodule SymphonyElixirWeb.Plugs.RequestId do
  @moduledoc """
  Plug that makes the request ID available in `conn.assigns.request_id`.

  Works in tandem with `Plug.RequestId` (configured in the endpoint), which
  generates the UUID, sets the `x-request-id` response header, and stores it
  in Logger metadata. This plug reads that request ID and assigns it to the
  connection for use in structured error responses.
  """

  import Plug.Conn
  require Logger

  @behaviour Plug

  @impl true
  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @impl true
  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    case Logger.metadata()[:request_id] do
      nil ->
        id = Ecto.UUID.generate()
        Logger.metadata(request_id: id)

        conn
        |> put_resp_header("x-request-id", id)
        |> assign(:request_id, id)

      id ->
        assign(conn, :request_id, id)
    end
  end
end
