defmodule SymphonyElixir.CommentWatchTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.CommentWatch
  alias SymphonyElixir.Linear.Comment

  test "unseen_external_comments ignores Symphony-authored comments and dedupes seen comments" do
    seen_comment = %Comment{id: "comment-seen", body: "Seen already", author: "Alice", created_at: "2026-03-20T17:00:00Z"}
    workpad_comment = %Comment{id: "comment-workpad", body: "## Codex Workpad\n\nstate", author: "Symphony", created_at: "2026-03-20T17:01:00Z"}
    workspace_comment = %Comment{id: "comment-workspace", body: "Workspace ready: `host:/tmp/workspace`", author: "Symphony", created_at: "2026-03-20T17:02:00Z"}
    reply_comment = %Comment{id: "comment-reply", body: Comment.tag_agent_reply("Agent reply"), author: "Symphony", created_at: "2026-03-20T17:03:00Z"}
    fresh_comment = %Comment{id: "comment-fresh", body: "Please also cover retries.", author: "Bob", created_at: "2026-03-20T17:04:00Z"}

    state = CommentWatch.seed(nil, [seen_comment])

    assert CommentWatch.unseen_external_comments(
             state,
             [seen_comment, workpad_comment, workspace_comment, reply_comment, fresh_comment]
           ) == [fresh_comment]

    assert CommentWatch.remember(state, [fresh_comment]) ==
             MapSet.new(["comment-fresh", "comment-seen"])
  end

  test "continuation_section renders new comment context" do
    section =
      CommentWatch.continuation_section([
        %Comment{
          id: "comment-1",
          body: "Please reply on Linear when done.",
          author: "Alice",
          created_at: "2026-03-20T17:05:00Z"
        }
      ])

    assert section =~ "New Linear comments since last turn"
    assert section =~ "**Alice** (2026-03-20T17:05:00Z):"
    assert section =~ "Please reply on Linear when done."
  end

  test "agent runner continuation prompt prepends new Linear comments" do
    prompt =
      AgentRunner.build_turn_prompt_for_test(
        %Issue{id: "issue-1", identifier: "SYM-19", title: "Live comments"},
        [],
        2,
        20,
        [
          %Comment{
            id: "comment-2",
            body: "Need a reply path too.",
            author: "Marko",
            created_at: "2026-03-20T17:06:00Z"
          }
        ]
      )

    assert prompt =~ "New Linear comments since last turn"
    assert prompt =~ "Need a reply path too."
    assert prompt =~ "Continuation guidance:"
  end

  test "agent runner carries comment watch state forward on refresh" do
    issue = %Issue{
      id: "issue-1",
      identifier: "SYM-19",
      title: "Live comments",
      state: "In Progress",
      comments: [
        %Comment{id: "comment-1", body: "Seen already", author: "Alice", created_at: "2026-03-20T17:00:00Z"}
      ]
    }

    state = CommentWatch.seed(nil, issue.comments)

    assert {:continue, refreshed_issue, next_state, unseen_comments} =
             AgentRunner.continue_with_issue_for_test(
               issue,
               fn ["issue-1"] ->
                 {:ok,
                  [
                    %Issue{
                      issue
                      | comments:
                          issue.comments ++
                            [
                              %Comment{
                                id: "comment-2",
                                body: "Please check retry behavior.",
                                author: "Bob",
                                created_at: "2026-03-20T17:07:00Z"
                              }
                            ]
                    }
                  ]}
               end,
               state
             )

    assert refreshed_issue.comments |> Enum.map(& &1.id) == ["comment-1", "comment-2"]
    assert Enum.map(unseen_comments, & &1.id) == ["comment-2"]
    assert next_state == MapSet.new(["comment-1", "comment-2"])
  end
end
