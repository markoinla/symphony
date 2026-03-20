defmodule SymphonyElixir.Linear.CommentWatcherTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.CommentWatcher

  test "advance returns only newly actionable comments and ignores workpad updates" do
    watcher =
      CommentWatcher.new([
        %{id: "comment-1", body: "Original note", author: "Alice", author_id: "user-1", created_at: "2026-03-20T10:00:00Z"}
      ])

    {watcher, new_comments} =
      CommentWatcher.advance(watcher, [
        %{id: "comment-1", body: "Original note", author: "Alice", author_id: "user-1", created_at: "2026-03-20T10:00:00Z"},
        %{id: "comment-2", body: "## Codex Workpad\nprogress", author: "Codex", author_id: "user-2", created_at: "2026-03-20T10:01:00Z"},
        %{id: "comment-3", body: "Please reply here.", author: "Bob", author_id: "user-3", created_at: "2026-03-20T10:02:00Z"}
      ])

    assert new_comments == [
             %{id: "comment-3", body: "Please reply here.", author: "Bob", author_id: "user-3", created_at: "2026-03-20T10:02:00Z"}
           ]

    assert CommentWatcher.ignored_comment_ids(watcher) == MapSet.new()
  end

  test "track_created_comment suppresses session-authored replies from later diffs" do
    watcher = CommentWatcher.new([])
    watcher = CommentWatcher.track_created_comment(watcher, "comment-9")

    {_watcher, new_comments} =
      CommentWatcher.advance(watcher, [
        %{id: "comment-9", body: "Agent reply", author: "Codex", author_id: "user-9", created_at: "2026-03-20T10:03:00Z"},
        %{id: "comment-10", body: "Human follow-up", author: "Dana", author_id: "user-10", created_at: "2026-03-20T10:04:00Z"}
      ])

    assert new_comments == [
             %{id: "comment-10", body: "Human follow-up", author: "Dana", author_id: "user-10", created_at: "2026-03-20T10:04:00Z"}
           ]
  end

  test "comment watcher tolerates comments without ids or map shape" do
    watcher = CommentWatcher.new([%{body: "missing id"}, :not_a_comment])
    same_watcher = CommentWatcher.track_created_comment(watcher, nil)

    assert same_watcher == watcher
    assert CommentWatcher.ignored_comment_ids(watcher) == MapSet.new()

    {next_watcher, new_comments} =
      CommentWatcher.advance(watcher, [%{body: nil}, :still_not_a_comment, %{id: "comment-11", body: "visible"}])

    assert new_comments == [%{id: "comment-11", body: "visible"}]
    assert CommentWatcher.actionable_comments([:still_not_a_comment, %{body: nil}], MapSet.new()) == [:still_not_a_comment, %{body: nil}]
    assert next_watcher.seen_comment_ids == MapSet.new(["comment-11"])
  end
end
