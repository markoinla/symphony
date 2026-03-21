defmodule SymphonyElixir.ToolCallComponentsTest do
  use SymphonyElixir.TestSupport

  import Phoenix.LiveViewTest

  alias SymphonyElixirWeb.ToolCallComponents

  test "exec command badges preserve details state and render expanded args" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: "exec_command",
        metadata: %{
          status: "completed",
          args: %{
            cmd: "git status --short && mix test",
            cwd: "/tmp/workspaces/SYM-36/",
            exit_code: 0
          }
        },
        details_id: "tool-1",
        preserve_open: true
      )

    {:ok, document} = Floki.parse_document(html)

    [details] = Floki.find(document, "details.chat-tool-pill")

    assert Floki.attribute(details, "id") == ["tool-1"]
    assert Floki.attribute(details, "phx-mounted") != []
    assert badge_labels(document) == ["Command", "git status --short && mix test", "SYM-36 • exit 0", "completed"]
    assert hover_titles(document) == ["Tool", "Command", "Run details", "Status"]
    assert document |> Floki.find(".chat-tool-args") |> Floki.text() =~ "\"exit_code\": 0"
  end

  test "apply patch badges render generic context and parsed exit metadata" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: "apply_patch",
        metadata: %{
          "status" => "auto_approved",
          "args" => %{
            "environment" => :staging,
            "cwd" => "/tmp/workspaces/SYM-36/",
            "exit_code" => "7"
          }
        }
      )

    {:ok, document} = Floki.parse_document(html)

    [details] = Floki.find(document, "details.chat-tool-pill")

    assert Floki.attribute(details, "phx-mounted") == []
    assert badge_labels(document) == ["Patch", "environment: staging", "SYM-36 • exit 7", "auto approved"]
    assert hover_bodies(document) |> Enum.any?(&String.contains?(&1, "Result: exit 7"))
  end

  test "tool badges fall back to a compact static pill when no details are present" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: nil,
        metadata: nil
      )

    {:ok, document} = Floki.parse_document(html)

    assert Floki.find(document, ".chat-tool-pill-static") |> length() == 1
    assert Floki.find(document, "details.chat-tool-pill") == []
    assert badge_labels(document) == ["Tool", "unknown"]
    assert hover_bodies(document) |> Enum.any?(&String.contains?(&1, "State: unknown"))
  end

  test "failed tool badges surface error details and generic integer context" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: :dynamic_tool,
        metadata: %{
          status: "failed",
          error: "permission denied",
          args: %{
            retry_count: 3,
            cwd: "/tmp/workspaces/root/",
            exit_code: "oops"
          }
        }
      )

    {:ok, document} = Floki.parse_document(html)

    assert Floki.find(document, ".chat-tool-failed") |> length() == 1
    assert badge_labels(document) == ["Tool", "retry count: 3", "root", "failed"]
    assert hover_bodies(document) |> Enum.any?(&String.contains?(&1, "Error: permission denied"))
    assert html =~ "permission denied"
  end

  test "exec command without a command skips the context badge and falls back to inspect for unsupported args" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: "exec_command",
        metadata: %{
          status: "completed",
          args: %{pid: self()}
        }
      )

    {:ok, document} = Floki.parse_document(html)

    assert badge_labels(document) == ["Command", "completed"]
    assert document |> Floki.find(".chat-tool-args") |> Floki.text() =~ "#PID<"
  end

  test "generic badges truncate long context, ignore blank values, and support dot workspaces" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: "long_tool",
        metadata: %{
          status: "completed",
          args: %{
            a: String.duplicate("very-long-value-", 6),
            blank: "",
            cwd: "."
          }
        }
      )

    {:ok, document} = Floki.parse_document(html)

    assert badge_labels(document) == ["long_tool", "a: very-long-value-very-long-value…", ".", "completed"]
    refute badge_labels(document) |> Enum.any?(&String.contains?(&1, "blank"))
    assert hover_bodies(document) |> Enum.any?(&String.contains?(&1, "Workspace: ."))
  end

  test "generic badges inspect unsupported hovercard values" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: "worker_tool",
        metadata: %{
          status: "completed",
          args: %{
            actor: self()
          }
        }
      )

    {:ok, document} = Floki.parse_document(html)

    assert badge_labels(document) |> Enum.at(0) == "worker_tool"
    assert badge_labels(document) |> Enum.at(1) =~ "actor: #PID<"
    assert badge_labels(document) |> Enum.at(2) == "completed"
    assert hover_bodies(document) |> Enum.any?(&String.contains?(&1, "#PID<"))
  end

  defp badge_labels(document) do
    document
    |> Floki.find(".chat-tool-chip-label")
    |> Enum.map(&Floki.text/1)
  end

  defp hover_titles(document) do
    document
    |> Floki.find(".chat-tool-hovercard-title")
    |> Enum.map(&Floki.text/1)
  end

  defp hover_bodies(document) do
    document
    |> Floki.find(".chat-tool-hovercard-body")
    |> Enum.map(&Floki.text/1)
  end
end
