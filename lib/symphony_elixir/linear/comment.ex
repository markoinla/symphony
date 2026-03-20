defmodule SymphonyElixir.Linear.Comment do
  @moduledoc """
  Normalized Linear comment representation and Symphony comment helpers.
  """

  @agent_reply_marker "<!-- symphony:agent-reply -->"
  @workpad_header "## Codex Workpad"
  @workspace_ready_prefix "Workspace ready:"

  defstruct [:id, :body, :author, :author_id, :created_at]

  @type t :: %__MODULE__{
          id: String.t() | nil,
          body: String.t() | nil,
          author: String.t() | nil,
          author_id: String.t() | nil,
          created_at: String.t() | nil
        }

  @spec key(t()) :: String.t()
  def key(%__MODULE__{id: id}) when is_binary(id) and id != "", do: id

  def key(%__MODULE__{} = comment) do
    Enum.join(
      [
        comment.created_at || "",
        comment.author_id || comment.author || "",
        comment.body || ""
      ],
      "|"
    )
  end

  @spec tag_agent_reply(String.t()) :: String.t()
  def tag_agent_reply(body) when is_binary(body) do
    @agent_reply_marker <> "\n" <> body
  end

  @spec symphony_authored?(t()) :: boolean()
  def symphony_authored?(%__MODULE__{body: body}) when is_binary(body) do
    workpad?(body) or workspace_ready?(body) or agent_reply?(body)
  end

  def symphony_authored?(_comment), do: false

  @spec workpad?(t() | String.t() | nil) :: boolean()
  def workpad?(%__MODULE__{body: body}), do: workpad?(body)

  def workpad?(body) when is_binary(body) do
    body
    |> String.trim_leading()
    |> String.starts_with?(@workpad_header)
  end

  def workpad?(_body), do: false

  @spec workspace_ready?(t() | String.t() | nil) :: boolean()
  def workspace_ready?(%__MODULE__{body: body}), do: workspace_ready?(body)

  def workspace_ready?(body) when is_binary(body) do
    body
    |> String.trim_leading()
    |> String.starts_with?(@workspace_ready_prefix)
  end

  def workspace_ready?(_body), do: false

  @spec agent_reply?(t() | String.t() | nil) :: boolean()
  def agent_reply?(%__MODULE__{body: body}), do: agent_reply?(body)

  def agent_reply?(body) when is_binary(body) do
    String.contains?(body, @agent_reply_marker)
  end

  def agent_reply?(_body), do: false
end
