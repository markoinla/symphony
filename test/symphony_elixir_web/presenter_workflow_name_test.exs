defmodule SymphonyElixirWeb.PresenterWorkflowNameTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Store
  alias SymphonyElixirWeb.Presenter

  defp session_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "completed",
        started_at: DateTime.utc_now() |> DateTime.add(-60),
        ended_at: DateTime.utc_now()
      },
      overrides
    )
  end

  describe "history_payload with workflow_name" do
    test "includes workflow_name in session summary" do
      {:ok, _s} = Store.create_session(session_attrs(%{workflow_name: "EPIC_SPLITTER"}))

      %{sessions: sessions} = Presenter.history_payload([])
      session = List.first(sessions)
      assert session.workflow_name == "EPIC_SPLITTER"
    end

    test "includes nil workflow_name when not set" do
      {:ok, _s} = Store.create_session(session_attrs())

      %{sessions: sessions} = Presenter.history_payload([])
      session = List.first(sessions)
      assert session.workflow_name == nil
    end

    test "filters by workflow_name" do
      {:ok, _s1} = Store.create_session(session_attrs(%{workflow_name: "EPIC_SPLITTER"}))
      {:ok, _s2} = Store.create_session(session_attrs(%{workflow_name: "BUG_FIX"}))

      %{sessions: sessions} = Presenter.history_payload(workflow_name: "EPIC_SPLITTER")
      assert length(sessions) == 1
      assert List.first(sessions).workflow_name == "EPIC_SPLITTER"
    end
  end
end
