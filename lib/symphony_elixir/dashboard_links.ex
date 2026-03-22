defmodule SymphonyElixir.DashboardLinks do
  @moduledoc """
  Builds Symphony dashboard URLs used for tracker resource links.

  The public base URL is read from the `server.public_base_url` SQLite setting,
  configurable via the dashboard Settings page.
  """

  alias SymphonyElixir.Settings

  @setting_key "server.public_base_url"

  @spec session_issue_url(String.t()) :: String.t()
  def session_issue_url(issue_identifier) when is_binary(issue_identifier) do
    "#{base_url()}/session/#{URI.encode(issue_identifier)}"
  end

  @spec session_issue_title() :: String.t()
  def session_issue_title, do: "Symphony Session"

  defp base_url do
    (Settings.get(@setting_key) || "")
    |> String.trim_trailing("/")
  end
end
