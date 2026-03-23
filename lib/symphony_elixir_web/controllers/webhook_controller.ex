defmodule SymphonyElixirWeb.WebhookController do
  @moduledoc """
  Handles Linear Agent webhook events (AgentSessionEvent).
  """

  use Phoenix.Controller, formats: [:json]
  require Logger

  alias SymphonyElixir.WebhookDispatcher

  @spec linear(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def linear(conn, %{"action" => "created"} = params) do
    received_at = System.monotonic_time()

    # Respond immediately — Linear requires response within 5 seconds
    conn = json(conn, %{ok: true})

    # Dispatch asynchronously
    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      WebhookDispatcher.dispatch_created(params, received_at: received_at)
    end)

    conn
  end

  def linear(conn, %{"action" => "prompted"} = params) do
    conn = json(conn, %{ok: true})

    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      WebhookDispatcher.dispatch_prompted(params)
    end)

    conn
  end

  def linear(conn, params) do
    action = Map.get(params, "action", "unknown")
    Logger.debug("Ignoring webhook action=#{action}")
    json(conn, %{ok: true})
  end
end
