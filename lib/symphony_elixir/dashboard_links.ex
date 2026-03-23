defmodule SymphonyElixir.DashboardLinks do
  @moduledoc """
  Builds Symphony dashboard URLs used for tracker resource links.

  The public base URL is resolved in order of precedence:

  1. `server.public_base_url` SQLite setting (dashboard Settings page)
  2. `SYMPHONY_PUBLIC_BASE_URL` environment variable
  """

  alias SymphonyElixir.Settings

  @setting_key "server.public_base_url"

  @spec session_issue_url(String.t()) :: String.t()
  def session_issue_url(issue_identifier) when is_binary(issue_identifier) do
    "#{base_url()}/session/#{URI.encode(issue_identifier)}"
  end

  @spec session_issue_title() :: String.t()
  def session_issue_title, do: "Symphony Session"

  @env_var "SYMPHONY_PUBLIC_BASE_URL"

  defp base_url do
    (Settings.get(@setting_key) || non_blank_env(@env_var) || "")
    |> String.trim_trailing("/")
  end

  defp non_blank_env(var) do
    case System.get_env(var) do
      nil -> nil
      "" -> nil
      val -> val
    end
  end
end
