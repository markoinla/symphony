defmodule SymphonyElixirWeb.StreamController do
  @moduledoc """
  Server-sent event endpoints backed by Phoenix PubSub.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixirWeb.{ObservabilityPubSub, Presenter}

  @heartbeat_ms 15_000

  @spec dashboard(Conn.t(), map()) :: Conn.t()
  def dashboard(conn, _params) do
    with :ok <- ObservabilityPubSub.subscribe(),
         :ok <- ObservabilityPubSub.subscribe_agents() do
      conn |> prepare_sse() |> stream_dashboard_events()
    else
      {:error, _reason} -> send_resp(conn, 503, "pubsub unavailable")
    end
  end

  @spec session(Conn.t(), map()) :: Conn.t()
  def session(conn, %{"issue_id" => issue_id}) do
    case ObservabilityPubSub.subscribe_session(issue_id) do
      :ok -> conn |> prepare_sse() |> stream_session_events()
      {:error, _reason} -> send_resp(conn, 503, "pubsub unavailable")
    end
  end

  defp prepare_sse(conn) do
    conn
    |> put_resp_content_type("text/event-stream")
    |> put_resp_header("cache-control", "no-cache")
    |> put_resp_header("connection", "keep-alive")
    |> put_resp_header("x-accel-buffering", "no")
    |> send_chunked(200)
  end

  defp stream_dashboard_events(conn) do
    receive do
      :observability_updated ->
        case Conn.chunk(conn, encode_event("state_changed", %{changed_at: DateTime.utc_now()})) do
          {:ok, updated_conn} -> stream_dashboard_events(updated_conn)
          {:error, _reason} -> conn
        end

      :agents_changed ->
        stream_event(conn, "agents_changed", %{}, &stream_dashboard_events/1)
    after
      @heartbeat_ms ->
        heartbeat(conn, &stream_dashboard_events/1)
    end
  end

  defp stream_session_events(conn) do
    receive do
      {:session_message, message} ->
        stream_event(conn, "message", Presenter.message_payload(message), &stream_session_events/1)

      {:session_message_update, message} ->
        stream_event(conn, "message_update", Presenter.message_payload(message), &stream_session_events/1)
    after
      @heartbeat_ms ->
        heartbeat(conn, &stream_session_events/1)
    end
  end

  defp stream_event(conn, event, payload, continuation) do
    case Conn.chunk(conn, encode_event(event, payload)) do
      {:ok, updated_conn} -> continuation.(updated_conn)
      {:error, _reason} -> conn
    end
  end

  defp heartbeat(conn, continuation) do
    case Conn.chunk(conn, ": keep-alive\n\n") do
      {:ok, updated_conn} -> continuation.(updated_conn)
      {:error, _reason} -> conn
    end
  end

  defp encode_event(event, payload) do
    "event: #{event}\ndata: #{Jason.encode!(payload)}\n\n"
  end
end
