defmodule SymphonyElixirWeb.ToolCallComponents do
  @moduledoc false

  use Phoenix.Component

  attr(:tool_name, :any, required: true)
  attr(:metadata, :map, default: %{})

  @spec tool_call(map()) :: Phoenix.LiveView.Rendered.t()
  def tool_call(assigns) do
    metadata = normalize_metadata(assigns[:metadata])
    status = tool_status(metadata)

    assigns =
      assigns
      |> assign(:status, status)
      |> assign(:label, build_label(assigns.tool_name, metadata))
      |> assign(:detail, build_detail(assigns.tool_name, metadata))
      |> assign(:failed?, status == "failed")

    ~H"""
    <div class={["chat-tool", @failed? && "chat-tool-failed"]}>
      <span class={["chat-tool-chip", "chat-tool-chip-#{@status}"]}>
        <svg class="chat-tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1v2m0 10v2M1 8h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41" />
        </svg>
        <span class="chat-tool-chip-label"><%= @label %></span>
        <%= if @detail != "" do %>
          <span class="chat-tool-hovercard" role="tooltip">
            <pre class="chat-tool-hovercard-body"><%= @detail %></pre>
          </span>
        <% end %>
      </span>
    </div>
    """
  end

  # ── Label ────────────────────────────────────────────────────────────

  defp build_label(tool_name, metadata) do
    base = tool_label(tool_name)
    context = tool_context(tool_name, tool_args(metadata))

    if context, do: "#{base} #{context}", else: base
  end

  defp tool_label("exec_command"), do: "Command"
  defp tool_label("apply_patch"), do: "Patch"
  defp tool_label(tool_name) when is_binary(tool_name) and tool_name != "", do: tool_name
  defp tool_label(_tool_name), do: "Tool"

  defp tool_context("exec_command", args) do
    case map_value(args, [:cmd, "cmd"]) do
      command when is_binary(command) and command != "" -> inline_text(command, 40)
      _ -> nil
    end
  end

  defp tool_context(_tool_name, args) do
    args
    |> Enum.reject(fn {key, value} ->
      to_string(key) in ["cwd", "exit_code"] or blank_value?(value)
    end)
    |> Enum.sort_by(fn {key, _value} -> to_string(key) end)
    |> List.first()
    |> case do
      {key, value} ->
        text = detail_text(value)
        if present?(text), do: "#{humanize_key(key)}: #{inline_text(text, 36)}", else: nil

      nil ->
        nil
    end
  end

  # ── Hovercard detail ─────────────────────────────────────────────────

  defp build_detail(tool_name, metadata) do
    args = tool_args(metadata)
    error = tool_error(metadata)
    status = tool_status(metadata)

    known = known_arg_keys(tool_name)

    extra_lines =
      args
      |> Enum.reject(fn {key, value} -> to_string(key) in known or blank_value?(value) end)
      |> Enum.sort_by(fn {key, _} -> to_string(key) end)
      |> Enum.map(fn {key, value} -> detail_line(humanize_key(key), detail_text(value)) end)

    lines =
      [
        detail_line("Tool", tool_name),
        detail_line("Status", humanize_status(status)),
        detail_line("Command", map_value(args, [:cmd, "cmd"])),
        detail_line("Workspace", map_value(args, [:cwd, "cwd"])),
        detail_line("Exit code", format_exit_value(map_value(args, [:exit_code, "exit_code"])))
      ] ++
        extra_lines ++
        [detail_line("Error", error)]

    lines
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp detail_line(_label, nil), do: nil
  defp detail_line(_label, value) when is_binary(value) and byte_size(value) == 0, do: nil
  defp detail_line(label, value), do: "#{label}: #{value}"

  defp format_exit_value(code) when is_integer(code), do: Integer.to_string(code)
  defp format_exit_value(code) when is_binary(code) and code != "", do: code
  defp format_exit_value(_code), do: nil

  defp known_arg_keys("exec_command"), do: ~w(cmd cwd exit_code)
  defp known_arg_keys(_tool_name), do: ~w(cwd exit_code)

  # ── Helpers ──────────────────────────────────────────────────────────

  defp tool_status(metadata), do: map_value(metadata, [:status, "status"]) || "unknown"

  defp tool_args(metadata) when is_map(metadata) do
    case map_value(metadata, [:args, "args"]) do
      args when is_map(args) -> args
      _ -> %{}
    end
  end

  defp tool_error(metadata) when is_map(metadata), do: map_value(metadata, [:error, "error"])

  defp inline_text(text, max_length) when is_binary(text) do
    text
    |> String.replace("\n", " ")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> truncate(max_length)
  end

  defp detail_text(value) when is_binary(value), do: String.trim(value)
  defp detail_text(value) when is_integer(value), do: Integer.to_string(value)
  defp detail_text(value) when is_atom(value), do: Atom.to_string(value)

  defp detail_text(value) do
    Jason.encode!(value, pretty: true)
  rescue
    _ -> inspect(value, pretty: true)
  end

  defp humanize_key(key) do
    key
    |> to_string()
    |> String.replace("_", " ")
  end

  defp humanize_status(status) do
    status
    |> to_string()
    |> String.replace("_", " ")
  end

  defp map_value(map, keys) when is_map(map) and is_list(keys) do
    Enum.find_value(keys, &Map.get(map, &1))
  end

  defp normalize_metadata(metadata) when is_map(metadata), do: metadata
  defp normalize_metadata(_metadata), do: %{}

  defp truncate(text, max_length) when is_binary(text) and byte_size(text) > max_length do
    binary_part(text, 0, max_length - 1) <> "…"
  end

  defp truncate(text, _max_length), do: text

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false

  defp blank_value?(value) when value in [nil, "", [], %{}], do: true
  defp blank_value?(_value), do: false
end
