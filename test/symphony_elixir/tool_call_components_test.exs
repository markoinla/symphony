defmodule SymphonyElixir.ToolCallComponentsTest do
  use SymphonyElixir.TestSupport

  import Phoenix.LiveViewTest

  alias SymphonyElixirWeb.ToolCallComponents

  test "exec command renders single chip with command context and hovercard" do
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
        }
      )

    {:ok, document} = Floki.parse_document(html)

    assert [label] = chip_labels(document)
    assert label =~ "Command"
    assert label =~ "git status --short && mix test"

    assert [detail] = hover_bodies(document)
    assert detail =~ "Tool: exec_command"
    assert detail =~ "Status: completed"
    assert detail =~ "Command: git status --short && mix test"
    assert detail =~ "Workspace: /tmp/workspaces/SYM-36/"
    assert detail =~ "Exit code: 0"
  end

  test "apply patch renders single chip with generic context" do
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

    assert [label] = chip_labels(document)
    assert label =~ "Patch"
    assert label =~ "environment: staging"

    assert [detail] = hover_bodies(document)
    assert detail =~ "Status: auto approved"
    assert detail =~ "Workspace: /tmp/workspaces/SYM-36/"
    assert detail =~ "Exit code: 7"
  end

  test "nil metadata renders a single chip with Tool label" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: nil,
        metadata: nil
      )

    {:ok, document} = Floki.parse_document(html)

    assert [label] = chip_labels(document)
    assert label == "Tool"

    assert [detail] = hover_bodies(document)
    assert detail =~ "Status: unknown"
  end

  test "failed tool surfaces error in hovercard and adds failed class" do
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

    assert [label] = chip_labels(document)
    assert label =~ "retry count: 3"

    assert [detail] = hover_bodies(document)
    assert detail =~ "Error: permission denied"
  end

  test "exec command without a command skips context in label" do
    html =
      render_component(&ToolCallComponents.tool_call/1,
        tool_name: "exec_command",
        metadata: %{
          status: "completed",
          args: %{pid: self()}
        }
      )

    {:ok, document} = Floki.parse_document(html)

    assert [label] = chip_labels(document)
    assert label == "Command"

    assert [detail] = hover_bodies(document)
    assert detail =~ "#PID<"
  end

  test "generic tool truncates long context and ignores blank values" do
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

    assert [label] = chip_labels(document)
    assert label =~ "long_tool"
    assert label =~ "a: very-long-value-very-long-value"
    refute label =~ "blank"

    assert [detail] = hover_bodies(document)
    assert detail =~ "Workspace: ."
  end

  test "generic tool renders unsupported values via inspect" do
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

    assert [label] = chip_labels(document)
    assert label =~ "worker_tool"
    assert label =~ "actor: #PID<"

    assert [detail] = hover_bodies(document)
    assert detail =~ "#PID<"
  end

  defp chip_labels(document) do
    document
    |> Floki.find(".chat-tool-chip-label")
    |> Enum.map(&Floki.text/1)
  end

  defp hover_bodies(document) do
    document
    |> Floki.find(".chat-tool-hovercard-body")
    |> Enum.map(&Floki.text/1)
  end
end
