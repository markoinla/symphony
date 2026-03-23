defmodule SymphonyElixir.Linear.Auth do
  @moduledoc """
  Unified Linear authentication resolution.

  Prefers OAuth Bearer tokens over personal API keys so that automated
  actions (comments, state transitions) are attributed to the app rather
  than a personal user account.
  """

  alias SymphonyElixir.{Config, Linear.OAuth}

  @spec resolve_auth_header() :: {:ok, {String.t(), String.t()}} | {:error, :missing_linear_auth}
  def resolve_auth_header do
    case OAuth.current_access_token() do
      token when is_binary(token) and token != "" ->
        {:ok, {"Authorization", "Bearer #{token}"}}

      _ ->
        case Config.settings!().tracker.api_key do
          key when is_binary(key) and key != "" ->
            {:ok, {"Authorization", key}}

          _ ->
            {:error, :missing_linear_auth}
        end
    end
  end

  @spec has_auth?() :: boolean()
  def has_auth? do
    has_oauth_token?() or has_api_key?()
  end

  @spec has_oauth_token?() :: boolean()
  def has_oauth_token? do
    case OAuth.current_access_token() do
      token when is_binary(token) and token != "" -> true
      _ -> false
    end
  end

  @spec has_api_key?() :: boolean()
  def has_api_key? do
    case Config.settings!().tracker.api_key do
      key when is_binary(key) and key != "" -> true
      _ -> false
    end
  end
end
