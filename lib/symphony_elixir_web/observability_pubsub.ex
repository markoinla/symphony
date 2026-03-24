defmodule SymphonyElixirWeb.ObservabilityPubSub do
  @moduledoc """
  PubSub helpers for observability dashboard and session updates.
  """

  @pubsub SymphonyElixir.PubSub
  @topic "observability:dashboard"
  @update_message :observability_updated
  @settings_topic "config:settings"
  @projects_topic "config:projects"
  @agents_topic "config:agents"

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

  @spec subscribe_settings() :: :ok | {:error, term()}
  def subscribe_settings do
    Phoenix.PubSub.subscribe(@pubsub, @settings_topic)
  end

  @spec broadcast_settings_changed() :: :ok
  def broadcast_settings_changed do
    case Process.whereis(@pubsub) do
      pid when is_pid(pid) ->
        Phoenix.PubSub.broadcast(@pubsub, @settings_topic, :settings_changed)

      _ ->
        :ok
    end
  end

  @spec subscribe_projects() :: :ok | {:error, term()}
  def subscribe_projects do
    Phoenix.PubSub.subscribe(@pubsub, @projects_topic)
  end

  @spec broadcast_projects_changed() :: :ok
  def broadcast_projects_changed do
    case Process.whereis(@pubsub) do
      pid when is_pid(pid) ->
        Phoenix.PubSub.broadcast(@pubsub, @projects_topic, :projects_changed)

      _ ->
        :ok
    end
  end

  @spec subscribe_agents() :: :ok | {:error, term()}
  def subscribe_agents do
    Phoenix.PubSub.subscribe(@pubsub, @agents_topic)
  end

  @spec broadcast_agents_changed() :: :ok
  def broadcast_agents_changed do
    case Process.whereis(@pubsub) do
      pid when is_pid(pid) ->
        Phoenix.PubSub.broadcast(@pubsub, @agents_topic, :agents_changed)

      _ ->
        :ok
    end
  end

  defp session_topic(issue_id), do: "session:#{issue_id}"
end
