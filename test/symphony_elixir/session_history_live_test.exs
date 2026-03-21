defmodule SymphonyElixir.SessionHistoryLiveTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest
  import Phoenix.LiveViewTest

  alias SymphonyElixir.{DashboardLinks, Store}

  @endpoint SymphonyElixirWeb.Endpoint

  setup do
    endpoint_config = Application.get_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, [])

    reset_history_test_store!()

    on_exit(fn ->
      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
      reset_history_test_store!()
    end)

    Application.put_env(
      :symphony_elixir,
      SymphonyElixirWeb.Endpoint,
      Keyword.merge(endpoint_config, server: false, secret_key_base: String.duplicate("s", 64))
    )

    start_supervised!({SymphonyElixirWeb.Endpoint, []})

    :ok
  end

  test "history list links known sessions to the unified session page" do
    issue_identifier = unique_issue_identifier()
    _session = create_session!(issue_identifier: issue_identifier, issue_title: "Unified issue")

    {:ok, _view, html} = live(build_conn(), "/history")
    {:ok, document} = Floki.parse_document(html)

    history_link =
      document
      |> Floki.find("a.history-item")
      |> Enum.find(fn item -> Floki.text(item) =~ issue_identifier end)

    assert history_link
    assert Floki.attribute(history_link, "href") == ["/session/#{URI.encode(issue_identifier)}"]
    assert document |> Floki.find(".history-shell .history-panel") |> length() == 1
    assert document |> Floki.find(".chat-topbar") |> Enum.empty?()
  end

  test "session page keeps historical agent and thinking messages separated" do
    issue_identifier = unique_issue_identifier()
    session = create_session!(issue_identifier: issue_identifier, issue_title: "Separated transcript")

    append_message!(session.id, 1, "response", "First response")
    append_message!(session.id, 2, "response", "Second response")
    append_message!(session.id, 3, "tool_call", "shell", %{status: "completed", args: %{cmd: "pwd"}})
    append_message!(session.id, 4, "thinking", "First thought")
    append_message!(session.id, 5, "thinking", "Second thought")

    {:ok, _view, html} = live(build_conn(), "/session/#{URI.encode(issue_identifier)}")
    {:ok, document} = Floki.parse_document(html)

    assert html =~ "First response"
    assert html =~ "Second response"
    assert html =~ "First thought"
    assert html =~ "Second thought"
    assert html =~ "shell"
    refute html =~ "First responseSecond response"
    refute html =~ "First thoughtSecond thought"

    assert document |> Floki.find(".chat-msg .chat-msg-sender") |> length() == 2
    assert document |> Floki.find("details.chat-thinking") |> length() == 2
    assert document |> Floki.find(".chat-tool .chat-tool-name") |> Enum.map(&Floki.text/1) == ["shell"]
  end

  test "project filter narrows the visible history list" do
    {:ok, alpha} = Store.create_project(%{name: "Alpha"})
    {:ok, beta} = Store.create_project(%{name: "Beta"})

    alpha_issue = unique_issue_identifier()
    beta_issue = unique_issue_identifier()

    _alpha_session =
      create_session!(issue_identifier: alpha_issue, issue_title: "Alpha issue", project_id: alpha.id)

    _beta_session =
      create_session!(issue_identifier: beta_issue, issue_title: "Beta issue", project_id: beta.id)

    {:ok, view, html} = live(build_conn(), "/history")

    assert html =~ alpha_issue
    assert html =~ beta_issue

    filtered_html =
      view
      |> element("form.history-filter")
      |> render_change(%{"project_id" => Integer.to_string(alpha.id)})

    assert filtered_html =~ alpha_issue
    refute filtered_html =~ beta_issue
  end

  test "history list renders the dashboard empty state when no sessions exist" do
    SymphonyElixir.Repo.delete_all(SymphonyElixir.Store.Message)
    SymphonyElixir.Repo.delete_all(SymphonyElixir.Store.Session)

    {:ok, _view, html} = live(build_conn(), "/history")
    {:ok, document} = Floki.parse_document(html)

    assert html =~ "No historical sessions recorded yet."
    assert document |> Floki.find(".history-empty .empty-dash-text") |> length() == 1
    assert document |> Floki.find(".chat-topbar") |> Enum.empty?()
  end

  test "session page renders command tool badges with collapsed command context" do
    issue_identifier = unique_issue_identifier()
    session = create_session!(issue_identifier: issue_identifier, issue_title: "Command context")

    append_message!(session.id, 1, "tool_call", "exec_command", %{
      status: "completed",
      args: %{cmd: "git status --short", cwd: "/tmp/workspaces/SYM-28", exit_code: 0}
    })

    {:ok, _view, html} = live(build_conn(), "/session/#{URI.encode(issue_identifier)}")
    {:ok, document} = Floki.parse_document(html)

    [tool_card] = Floki.find(document, ".chat-tool")

    assert tool_card |> Floki.find(".chat-tool-name") |> Floki.text() == "Command"
    assert tool_card |> Floki.find(".chat-tool-context") |> Floki.text() == "git status --short"
    assert tool_card |> Floki.find(".chat-tool-meta") |> Floki.text() == "SYM-28 • exit 0"
    assert tool_card |> Floki.find(".chat-tool-badge") |> Floki.text() |> String.trim() == "completed"
  end

  test "session page preserves details state across live patches" do
    issue_identifier = unique_issue_identifier()
    session = create_session!(issue_identifier: issue_identifier, issue_title: "Details state")

    append_message!(session.id, 1, "tool_call", "exec_command", %{
      status: "completed",
      args: %{cmd: "mix test"}
    })

    append_message!(session.id, 2, "thinking", "Reviewing session updates")

    {:ok, _view, html} = live(build_conn(), "/session/#{URI.encode(issue_identifier)}")
    {:ok, document} = Floki.parse_document(html)

    chat_entries = Floki.find(document, "[data-chat-entry]")
    [tool_details] = Floki.find(document, "details.chat-tool-pill")
    [thinking_details] = Floki.find(document, "details.chat-thinking")

    assert length(chat_entries) == 3
    assert Enum.all?(chat_entries, &(Floki.attribute(&1, "id") != []))
    assert Floki.attribute(tool_details, "phx-mounted") != []
    assert Floki.attribute(tool_details, "id") != []
    assert Floki.attribute(thinking_details, "phx-mounted") != []
    assert Floki.attribute(thinking_details, "id") != []
  end

  test "legacy history detail path renders through the unified session view" do
    issue_identifier = unique_issue_identifier()
    session = create_session!(issue_identifier: issue_identifier, issue_title: "Legacy history alias")

    append_message!(session.id, 1, "response", "Historical response")

    {:ok, _view, html} = live(build_conn(), "/history/#{session.id}")
    {:ok, document} = Floki.parse_document(html)

    assert html =~ issue_identifier
    assert html =~ "Historical response"
    assert document |> Floki.find(".chat-session-header") |> length() == 1
    assert document |> Floki.find(".chat-msg .chat-msg-sender") |> length() == 1

    [back_link] = Floki.find(document, "a.chat-topbar-back")
    assert Floki.attribute(back_link, "href") == ["/history"]
  end

  test "dashboard links expose the unified session issue URL" do
    assert DashboardLinks.session_issue_url("SYM-24") == "http://home-lab:4000/session/SYM-24"
    assert DashboardLinks.session_issue_title() == "Symphony Session"
  end

  defp create_session!(attrs) do
    started_at = DateTime.utc_now() |> DateTime.truncate(:second)
    attrs = Enum.into(attrs, %{})

    defaults = %{
      issue_id: "issue-#{unique_suffix()}",
      issue_identifier: unique_issue_identifier(),
      issue_title: "Session history test",
      session_id: "session-#{unique_suffix()}",
      status: "completed",
      started_at: started_at,
      ended_at: started_at,
      turn_count: 2,
      total_tokens: 42
    }

    {:ok, session} =
      defaults
      |> Map.merge(attrs)
      |> Store.create_session()

    session
  end

  defp append_message!(session_id, seq, type, content, metadata \\ %{}) do
    {:ok, _message} =
      Store.append_message(session_id, %{
        seq: seq,
        timestamp: DateTime.utc_now() |> DateTime.truncate(:second),
        type: type,
        content: content,
        metadata: Jason.encode!(metadata)
      })

    :ok
  end

  defp unique_issue_identifier do
    "SYM-HISTORY-#{unique_suffix()}"
  end

  defp unique_suffix do
    Base.url_encode64(:crypto.strong_rand_bytes(6), padding: false)
  end

  defp reset_history_test_store! do
    SymphonyElixir.Settings.put_current_project(nil)
    SymphonyElixir.Store.delete_all_settings()
    SymphonyElixir.Repo.delete_all(SymphonyElixir.Store.Message)
    SymphonyElixir.Repo.delete_all(SymphonyElixir.Store.Session)
    SymphonyElixir.Store.delete_all_projects()
    :ok
  end
end
