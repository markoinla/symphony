defmodule SymphonyElixirWeb.ObservabilityPubSub do
  @moduledoc """
  PubSub helpers for observability dashboard and session updates.
  """

  @pubsub SymphonyElixir.PubSub
  @topic "observability:dashboard"
  @update_message :observability_updated

  @spec subscribe() :: :ok | {:error, term()}
  def subscribe do
    Phoenix.PubSub.subscribe(@pubsub, @topic)
  end

  @spec broadcast_update() :: :ok
  def broadcast_update do
    case Process.whereis(@pubsub) do
      pid when is_pid(pid) ->
        Phoenix.PubSub.broadcast(@pubsub, @topic, @update_message)

      _ ->
        :ok
    end
  end

  @spec subscribe_session(String.t()) :: :ok | {:error, term()}
  def subscribe_session(issue_id) do
    Phoenix.PubSub.subscribe(@pubsub, session_topic(issue_id))
  end

  @spec unsubscribe_session(String.t()) :: :ok
  def unsubscribe_session(issue_id) do
    Phoenix.PubSub.unsubscribe(@pubsub, session_topic(issue_id))
  end

  @spec broadcast_session_message(String.t(), map()) :: :ok
  def broadcast_session_message(issue_id, message) do
    case Process.whereis(@pubsub) do
      pid when is_pid(pid) ->
        Phoenix.PubSub.broadcast(@pubsub, session_topic(issue_id), {:session_message, message})

      _ ->
        :ok
    end
  end

  @spec broadcast_session_message_update(String.t(), map()) :: :ok
  def broadcast_session_message_update(issue_id, message) do
    case Process.whereis(@pubsub) do
      pid when is_pid(pid) ->
        Phoenix.PubSub.broadcast(@pubsub, session_topic(issue_id), {:session_message_update, message})

      _ ->
        :ok
    end
  end

  defp session_topic(issue_id), do: "session:#{issue_id}"
end
