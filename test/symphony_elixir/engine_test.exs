defmodule SymphonyElixir.EngineTest do
  use SymphonyElixir.TestSupport
  alias SymphonyElixir.Config.Schema
  alias SymphonyElixir.Engine

  test "engine_module/0 returns Codex.AppServer by default" do
    assert Engine.engine_module() == SymphonyElixir.Codex.AppServer
  end

  test "engine_module/0 returns Claude.AppServer when engine is claude" do
    write_workflow_file!(Workflow.workflow_file_path(), engine: "claude")

    assert Engine.engine_module() == SymphonyElixir.Claude.AppServer
  end

  test "schema defaults engine to codex" do
    assert {:ok, settings} = Schema.parse(%{})
    assert settings.engine == "codex"
  end

  test "schema parses engine: claude" do
    assert {:ok, settings} = Schema.parse(%{engine: "claude"})
    assert settings.engine == "claude"
  end

  test "schema rejects unknown engine" do
    assert {:error, {:invalid_workflow_config, message}} = Schema.parse(%{engine: "gpt"})
    assert message =~ "engine"
  end

  test "schema parses claude section with defaults" do
    assert {:ok, settings} = Schema.parse(%{engine: "claude"})
    assert settings.claude.command == "claude"
    assert settings.claude.permission_mode == "bypassPermissions"
    assert settings.claude.turn_timeout_ms == 3_600_000
    assert settings.claude.allowed_tools == []
    assert settings.claude.disallowed_tools == []
    assert settings.claude.model == nil
    assert settings.claude.append_system_prompt == nil
  end

  test "schema parses claude section with custom values" do
    assert {:ok, settings} =
             Schema.parse(%{
               engine: "claude",
               claude: %{
                 command: "/usr/local/bin/claude",
                 model: "claude-sonnet-4-20250514",
                 permission_mode: "default",
                 allowed_tools: ["Read", "Edit", "Bash"],
                 disallowed_tools: ["WebSearch"],
                 turn_timeout_ms: 1_800_000,
                 append_system_prompt: "Always run tests before committing."
               }
             })

    assert settings.claude.command == "/usr/local/bin/claude"
    assert settings.claude.model == "claude-sonnet-4-20250514"
    assert settings.claude.permission_mode == "default"
    assert settings.claude.allowed_tools == ["Read", "Edit", "Bash"]
    assert settings.claude.disallowed_tools == ["WebSearch"]
    assert settings.claude.turn_timeout_ms == 1_800_000
    assert settings.claude.append_system_prompt == "Always run tests before committing."
  end

  test "schema rejects invalid claude permission_mode" do
    assert {:error, {:invalid_workflow_config, message}} =
             Schema.parse(%{claude: %{permission_mode: "yolo"}})

    assert message =~ "permission_mode"
  end

  test "schema rejects invalid claude turn_timeout_ms" do
    assert {:error, {:invalid_workflow_config, message}} =
             Schema.parse(%{claude: %{turn_timeout_ms: 0}})

    assert message =~ "turn_timeout_ms"
  end

  test "codex section is unaffected by claude config" do
    assert {:ok, settings} =
             Schema.parse(%{
               engine: "claude",
               claude: %{command: "/usr/local/bin/claude"},
               codex: %{command: "codex app-server"}
             })

    assert settings.engine == "claude"
    assert settings.claude.command == "/usr/local/bin/claude"
    assert settings.codex.command == "codex app-server"
  end

  test "Codex.AppServer implements Engine behaviour" do
    behaviours =
      SymphonyElixir.Codex.AppServer.__info__(:attributes)
      |> Keyword.get_values(:behaviour)
      |> List.flatten()

    assert SymphonyElixir.Engine in behaviours
  end
end
