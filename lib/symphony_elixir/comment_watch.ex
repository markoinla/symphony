defmodule SymphonyElixir.CommentWatch do
  @moduledoc """
  Tracks which Linear comments have already been surfaced to the active session.
  """

  alias SymphonyElixir.Linear.Comment

  @type state :: term()

  @spec new() :: state()
  def new do
    MapSet.new()
  end

  @spec seed(state() | nil, [Comment.t()]) :: state()
  def seed(state, comments) when is_list(comments) do
    state
    |> normalize_state()
    |> remember(comments)
  end

  @doc false
  @spec normalize_state_for_test(state() | nil) :: state()
  def normalize_state_for_test(state), do: normalize_state(state)

  @spec unseen_external_comments(state() | nil, [Comment.t()]) :: [Comment.t()]
  def unseen_external_comments(state, comments) when is_list(comments) do
    seen_comment_keys = normalize_state(state)

    Enum.filter(comments, fn %Comment{} = comment ->
      !MapSet.member?(seen_comment_keys, Comment.key(comment)) and !Comment.symphony_authored?(comment)
    end)
  end

  @spec remember(state() | nil, [Comment.t()]) :: state()
  def remember(state, comments) when is_list(comments) do
    Enum.reduce(comments, normalize_state(state), fn
      %Comment{} = comment, acc -> MapSet.put(acc, Comment.key(comment))
      _comment, acc -> acc
    end)
  end

  @spec continuation_section([Comment.t()]) :: String.t() | nil
  def continuation_section(comments) when is_list(comments) do
    rendered_comments =
      comments
      |> Enum.map(&render_comment/1)
      |> Enum.reject(&is_nil/1)

    case rendered_comments do
      [] ->
        nil

      items ->
        ["New Linear comments since last turn:\n", Enum.join(items, "\n---\n"), "\n"]
        |> IO.iodata_to_binary()
    end
  end

  defp normalize_state(%MapSet{} = seen_comment_keys), do: seen_comment_keys

  defp normalize_state(_state), do: new()

  defp render_comment(%Comment{} = comment) do
    author = comment.author || "Unknown author"
    created_at = comment.created_at || "Unknown time"
    body = String.trim(comment.body || "")

    """
    **#{author}** (#{created_at}):
    #{body}
    """
    |> String.trim_trailing()
  end

  defp render_comment(_comment), do: nil
end
