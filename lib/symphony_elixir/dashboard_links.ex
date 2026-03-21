defmodule SymphonyElixir.DashboardLinks do
  @moduledoc """
  Builds Symphony dashboard URLs used for tracker resource links.
  """

  alias SymphonyElixir.Config

  @spec session_issue_url(String.t()) :: String.t()
  def session_issue_url(issue_identifier) when is_binary(issue_identifier) do
    "#{base_url()}/session/#{URI.encode(issue_identifier)}"
  end

  @spec session_issue_title() :: String.t()
  def session_issue_title, do: "Symphony Session"

  defp base_url do
    Config.settings!().server.public_base_url
    |> Kernel.||("http://home-lab:4000")
    |> String.trim_trailing("/")
  end
end
