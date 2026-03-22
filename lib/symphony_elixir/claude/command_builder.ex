defmodule SymphonyElixir.Claude.CommandBuilder do
  @moduledoc """
  Builds the Claude Code CLI command string from config.
  """

  @spec build(map(), Path.t()) :: String.t()
  def build(claude_config, mcp_config_path) do
    parts =
      [
        claude_config.command || "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        claude_config.permission_mode || "bypassPermissions",
        "--dangerously-skip-permissions",
        "--mcp-config",
        mcp_config_path
      ]
      |> maybe_append("--model", claude_config.model)
      |> maybe_append_system_prompt(claude_config.append_system_prompt)
      |> maybe_append_list("--allowed-tools", claude_config.allowed_tools)
      |> maybe_append_list("--disallowed-tools", claude_config.disallowed_tools)

    Enum.join(parts, " ")
  end

  defp maybe_append(parts, _flag, nil), do: parts
  defp maybe_append(parts, _flag, ""), do: parts
  defp maybe_append(parts, flag, value), do: parts ++ [flag, shell_escape(value)]

  defp maybe_append_system_prompt(parts, nil), do: parts
  defp maybe_append_system_prompt(parts, ""), do: parts

  defp maybe_append_system_prompt(parts, prompt),
    do: parts ++ ["--append-system-prompt", shell_escape(prompt)]

  defp maybe_append_list(parts, _flag, nil), do: parts
  defp maybe_append_list(parts, _flag, []), do: parts

  defp maybe_append_list(parts, flag, items) do
    parts ++ [flag] ++ Enum.map(items, &shell_escape/1)
  end

  defp shell_escape(value) when is_binary(value) do
    if String.contains?(value, [" ", "'", "\"", "\\", "$", "`", "(", ")"]) do
      "'" <> String.replace(value, "'", "'\\''") <> "'"
    else
      value
    end
  end
end
