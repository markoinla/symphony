defmodule SymphonyElixirWeb.AnalyticsController do
  @moduledoc """
  JSON API for cost/token analytics aggregations.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Store

  @spec cost(Conn.t(), map()) :: Conn.t()
  def cost(conn, %{"range" => range}) when range in ["7d", "30d", "90d"] do
    data = Store.analytics_cost(range)
    json(conn, data)
  end

  def cost(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: "range must be one of: 7d, 30d, 90d"})
  end
end
