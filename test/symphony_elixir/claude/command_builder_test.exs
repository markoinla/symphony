defmodule SymphonyElixir.Claude.CommandBuilderTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Claude.CommandBuilder

  defp default_config do
    %{
      command: "claude",
      model: nil,
      permission_mode: "bypassPermissions",
      allowed_tools: [],
      disallowed_tools: [],
      append_system_prompt: nil
    }
  end

  test "builds basic command with required flags and prompt piped via heredoc" do
    cmd = CommandBuilder.build(default_config(), "/tmp/mcp.json", "Fix the bug")

    assert cmd =~ "claude"
    assert cmd =~ "-p"
    assert cmd =~ "--output-format stream-json"
    assert cmd =~ "--verbose"
    assert cmd =~ "--permission-mode bypassPermissions"
    assert cmd =~ "--dangerously-skip-permissions"
    assert cmd =~ "--mcp-config /tmp/mcp.json"
    assert cmd =~ "cat <<'SYMPHONY_PROMPT_EOF' |"
    assert cmd =~ "Fix the bug"
    assert cmd =~ "SYMPHONY_PROMPT_EOF"
  end

  test "includes model when specified" do
    config = %{default_config() | model: "claude-sonnet-4-20250514"}
    cmd = CommandBuilder.build(config, "/tmp/mcp.json", "hello")

    assert cmd =~ "--model claude-sonnet-4-20250514"
  end

  test "omits model when nil" do
    cmd = CommandBuilder.build(default_config(), "/tmp/mcp.json", "hello")
    refute cmd =~ "--model"
  end

  test "includes allowed tools" do
    config = %{default_config() | allowed_tools: ["Read", "Edit", "Bash"]}
    cmd = CommandBuilder.build(config, "/tmp/mcp.json", "hello")

    assert cmd =~ "--allowed-tools Read Edit Bash"
  end

  test "includes disallowed tools" do
    config = %{default_config() | disallowed_tools: ["WebSearch"]}
    cmd = CommandBuilder.build(config, "/tmp/mcp.json", "hello")

    assert cmd =~ "--disallowed-tools WebSearch"
  end

  test "includes append system prompt" do
    config = %{default_config() | append_system_prompt: "Always run tests."}
    cmd = CommandBuilder.build(config, "/tmp/mcp.json", "hello")

    assert cmd =~ "--append-system-prompt"
    assert cmd =~ "Always run tests."
  end

  test "shell escapes values with spaces" do
    config = %{default_config() | append_system_prompt: "Run all tests before committing"}
    cmd = CommandBuilder.build(config, "/tmp/mcp.json", "hello")

    assert cmd =~ "'Run all tests before committing'"
  end

  test "uses custom command path" do
    config = %{default_config() | command: "/usr/local/bin/claude"}
    cmd = CommandBuilder.build(config, "/tmp/mcp.json", "hello")

    assert cmd =~ "| /usr/local/bin/claude"
  end

  test "always includes --dangerously-skip-permissions for unattended operation" do
    cmd = CommandBuilder.build(default_config(), "/tmp/mcp.json", "hello")

    assert cmd =~ "--dangerously-skip-permissions"
  end
end
