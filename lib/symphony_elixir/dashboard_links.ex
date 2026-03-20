defmodule SymphonyElixir.DashboardLinks do
  @moduledoc """
  Builds Symphony dashboard URLs used for tracker resource links.
  """

  @base_url "http://home-lab:4000"

  @spec session_issue_url(String.t()) :: String.t()
  def session_issue_url(issue_identifier) when is_binary(issue_identifier) do
    "#{@base_url}/session/#{URI.encode(issue_identifier)}"
  end

  @spec history_session_url(integer()) :: String.t()
  def history_session_url(session_id) when is_integer(session_id) do
    "#{@base_url}/history/#{session_id}"
  end

  @spec session_issue_title() :: String.t()
  def session_issue_title, do: "Symphony Session"

  @spec history_session_title(integer()) :: String.t()
  def history_session_title(session_id) when is_integer(session_id) do
    "Symphony History ##{session_id}"
  end
end
