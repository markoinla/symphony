defmodule SymphonyElixir.Linear.CommentWatcher do
  @moduledoc """
  Tracks issue comments seen during one active agent session.
  """

  alias SymphonyElixir.Linear.Issue

  @workpad_marker "## Codex Workpad"

  defstruct seen_comment_ids: MapSet.new(), ignored_comment_ids: MapSet.new()

  @type comment_id_set :: %MapSet{map: map()}

  @type t :: %__MODULE__{
          seen_comment_ids: comment_id_set(),
          ignored_comment_ids: comment_id_set()
        }

  @spec new([Issue.comment()]) :: t()
  def new(comments) when is_list(comments) do
    %__MODULE__{seen_comment_ids: comment_ids(comments)}
  end

  @spec advance(t(), [Issue.comment()]) :: {t(), [Issue.comment()]}
  def advance(%__MODULE__{} = watcher, comments) when is_list(comments) do
    current_comment_ids = comment_ids(comments)

    unseen_comments =
      Enum.filter(comments, fn
        %{id: id} when is_binary(id) -> not MapSet.member?(watcher.seen_comment_ids, id)
        _ -> false
      end)

    next_watcher = %__MODULE__{
      watcher
      | seen_comment_ids: MapSet.union(watcher.seen_comment_ids, current_comment_ids)
    }

    {next_watcher, actionable_comments(unseen_comments, next_watcher.ignored_comment_ids)}
  end

  @spec actionable_comments([Issue.comment()], comment_id_set()) :: [Issue.comment()]
  def actionable_comments(comments, %MapSet{} = ignored_comment_ids) when is_list(comments) do
    Enum.reject(comments, &ignored_comment?(&1, ignored_comment_ids))
  end

  @spec ignored_comment_ids(t()) :: comment_id_set()
  def ignored_comment_ids(%__MODULE__{ignored_comment_ids: ignored_comment_ids}), do: ignored_comment_ids

  @spec track_created_comment(t(), String.t() | nil) :: t()
  def track_created_comment(%__MODULE__{} = watcher, comment_id) when is_binary(comment_id) do
    %__MODULE__{
      watcher
      | seen_comment_ids: MapSet.put(watcher.seen_comment_ids, comment_id),
        ignored_comment_ids: MapSet.put(watcher.ignored_comment_ids, comment_id)
    }
  end

  def track_created_comment(%__MODULE__{} = watcher, _comment_id), do: watcher

  defp comment_ids(comments) when is_list(comments) do
    comments
    |> Enum.reduce(MapSet.new(), fn
      %{id: id}, ids when is_binary(id) -> MapSet.put(ids, id)
      _comment, ids -> ids
    end)
  end

  defp ignored_comment?(comment, %MapSet{} = ignored_comment_ids) when is_map(comment) do
    workpad_comment? = comment |> Map.get(:body) |> workpad_comment_body?()
    ignored_comment_id? = comment |> Map.get(:id) |> ignored_comment_id?(ignored_comment_ids)
    workpad_comment? or ignored_comment_id?
  end

  defp ignored_comment?(_comment, _ignored_comment_ids), do: false

  defp workpad_comment_body?(body) when is_binary(body), do: String.contains?(body, @workpad_marker)
  defp workpad_comment_body?(_body), do: false

  defp ignored_comment_id?(comment_id, %MapSet{} = ignored_comment_ids) when is_binary(comment_id) do
    MapSet.member?(ignored_comment_ids, comment_id)
  end

  defp ignored_comment_id?(_comment_id, _ignored_comment_ids), do: false
end
