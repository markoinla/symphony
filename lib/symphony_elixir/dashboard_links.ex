defmodule SymphonyElixir.DashboardLinks do
  @moduledoc """
  Builds Symphony dashboard URLs used for tracker resource links.

  The public base URL is resolved from (in order):
  1. `symphony_public_base_url` DB setting
  2. `SYMPHONY_PUBLIC_BASE_URL` environment variable
  3. Empty string (relative URLs)
  """

  @env_var "SYMPHONY_PUBLIC_BASE_URL"

  @spec session_issue_url(String.t()) :: String.t()
  def session_issue_url(issue_identifier) when is_binary(issue_identifier) do
    "#{base_url()}/session/#{URI.encode(issue_identifier)}"
  end

  @spec session_issue_title() :: String.t()
  def session_issue_title, do: "Symphony Session"

  defp base_url do
    (db_base_url() || non_blank_env(@env_var) || "")
    |> String.trim_trailing("/")
  end

  defp db_base_url do
    case SymphonyElixir.Store.get_setting("symphony_public_base_url") do
      nil -> nil
      "" -> nil
      val -> val
    end
  rescue
    _ -> nil
  end

  defp non_blank_env(var) do
    case System.get_env(var) do
      nil -> nil
      "" -> nil
      val -> val
    end
  end
end
