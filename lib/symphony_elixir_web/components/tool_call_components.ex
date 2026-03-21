defmodule SymphonyElixirWeb.ToolCallComponents do
  @moduledoc false

  use Phoenix.Component

  alias Phoenix.LiveView.JS

  attr(:tool_name, :any, required: true)
  attr(:metadata, :map, default: %{})
  attr(:details_id, :string, default: nil)
  attr(:preserve_open, :boolean, default: false)

  @spec tool_call(map()) :: Phoenix.LiveView.Rendered.t()
  def tool_call(assigns) do
    metadata = normalize_metadata(assigns[:metadata])
    args = tool_args(metadata)
    error = tool_error(metadata)
    failed? = tool_status(metadata) == "failed"

    assigns =
      assigns
      |> assign(:args_text, if(map_size(args) > 0, do: format_args(args), else: nil))
      |> assign(:badges, summary_badges(assigns.tool_name, metadata, error))
      |> assign(:error, error)
      |> assign(:failed?, failed?)
      |> assign(:has_details?, map_size(args) > 0 or present?(error))
      |> assign(:preserve_open, assigns[:preserve_open] || false)

    ~H"""
    <div class={["chat-tool", @failed? && "chat-tool-failed"]}>
      <%= if @has_details? do %>
        <details
          id={@details_id}
          class="chat-tool-pill"
          phx-mounted={details_mount(@preserve_open)}
        >
          <summary class="chat-tool-summary">
            <%= for badge <- @badges do %>
              <span class={["chat-tool-chip", badge.class]}>
                <%= if badge.icon do %>
                  <svg class="chat-tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="8" cy="8" r="2.5" />
                    <path d="M8 1v2m0 10v2M1 8h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41" />
                  </svg>
                <% end %>
                <span class="chat-tool-chip-label"><%= badge.label %></span>
                <span class="chat-tool-hovercard" role="tooltip">
                  <span class="chat-tool-hovercard-title"><%= badge.title %></span>
                  <span class="chat-tool-hovercard-body"><%= badge.detail %></span>
                </span>
              </span>
            <% end %>
          </summary>
          <div class="chat-tool-body">
            <%= if @args_text do %>
              <pre class="chat-tool-args"><%= @args_text %></pre>
            <% end %>
            <%= if @error do %>
              <div class="chat-tool-error"><%= @error %></div>
            <% end %>
          </div>
        </details>
      <% else %>
        <div class="chat-tool-pill chat-tool-pill-static">
          <div class="chat-tool-summary">
            <%= for badge <- @badges do %>
              <span class={["chat-tool-chip", badge.class]}>
                <%= if badge.icon do %>
                  <svg class="chat-tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="8" cy="8" r="2.5" />
                    <path d="M8 1v2m0 10v2M1 8h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41" />
                  </svg>
                <% end %>
                <span class="chat-tool-chip-label"><%= badge.label %></span>
                <span class="chat-tool-hovercard" role="tooltip">
                  <span class="chat-tool-hovercard-title"><%= badge.title %></span>
                  <span class="chat-tool-hovercard-body"><%= badge.detail %></span>
                </span>
              </span>
            <% end %>
          </div>
        </div>
      <% end %>
    </div>
    """
  end

  defp details_mount(true), do: JS.ignore_attributes(["open"])
  defp details_mount(false), do: nil

  defp summary_badges(tool_name, metadata, error) do
    [
      %{
        class: "chat-tool-chip-primary",
        detail: tool_name_detail(tool_name),
        icon: true,
        label: tool_label(tool_name),
        title: "Tool"
      },
      tool_context_badge(tool_name, metadata),
      tool_meta_badge(metadata),
      %{
        class: "chat-tool-chip-status chat-tool-chip-status-#{tool_status(metadata)}",
        detail: status_detail(tool_status(metadata), error),
        icon: false,
        label: humanize_status(tool_status(metadata)),
        title: "Status"
      }
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp tool_label("exec_command"), do: "Command"
  defp tool_label("apply_patch"), do: "Patch"
  defp tool_label(tool_name) when is_binary(tool_name) and tool_name != "", do: tool_name
  defp tool_label(_tool_name), do: "Tool"

  defp tool_name_detail(tool_name) when is_binary(tool_name) and tool_name != "", do: tool_name
  defp tool_name_detail(tool_name), do: tool_label(tool_name)

  defp tool_context_badge("exec_command", metadata) do
    case map_value(tool_args(metadata), [:cmd, "cmd"]) do
      command when is_binary(command) and command != "" ->
        %{
          class: "chat-tool-chip-context",
          detail: command,
          icon: false,
          label: inline_text(command, 36),
          title: "Command"
        }

      _ ->
        nil
    end
  end

  defp tool_context_badge(_tool_name, metadata) do
    metadata
    |> tool_args()
    |> Enum.reject(fn {key, value} ->
      to_string(key) in ["cwd", "exit_code"] or blank_value?(value)
    end)
    |> Enum.sort_by(fn {key, _value} -> to_string(key) end)
    |> List.first()
    |> case do
      {key, value} ->
        detail = detail_text(value)

        if present?(detail) do
          %{
            class: "chat-tool-chip-context",
            detail: detail,
            icon: false,
            label: "#{humanize_key(key)}: #{inline_text(detail, 32)}",
            title: humanize_key(key)
          }
        end

      nil ->
        nil
    end
  end

  defp tool_meta_badge(metadata) do
    args = tool_args(metadata)

    label =
      [
        args |> map_value([:cwd, "cwd"]) |> short_path(),
        args |> map_value([:exit_code, "exit_code"]) |> format_exit_code()
      ]
      |> Enum.reject(&is_nil/1)
      |> Enum.join(" • ")

    detail =
      [
        args |> map_value([:cwd, "cwd"]) |> format_cwd_detail(),
        args |> map_value([:exit_code, "exit_code"]) |> format_exit_detail()
      ]
      |> Enum.reject(&is_nil/1)
      |> Enum.join("\n")

    if label != "" and detail != "" do
      %{
        class: "chat-tool-chip-meta",
        detail: detail,
        icon: false,
        label: label,
        title: "Run details"
      }
    end
  end

  defp tool_status(metadata), do: map_value(metadata, [:status, "status"]) || "unknown"

  defp tool_args(metadata) when is_map(metadata) do
    case map_value(metadata, [:args, "args"]) do
      args when is_map(args) -> args
      _ -> %{}
    end
  end

  defp tool_error(metadata) when is_map(metadata), do: map_value(metadata, [:error, "error"])

  defp format_args(args) when is_map(args) do
    Jason.encode!(args, pretty: true)
  rescue
    _ -> inspect(args, pretty: true)
  end

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

  defp short_path(path) when is_binary(path) and path != "" do
    path
    |> String.trim_trailing("/")
    |> Path.basename()
    |> case do
      "." -> path
      basename -> basename
    end
  end

  defp short_path(_path), do: nil

  defp format_cwd_detail(path) when is_binary(path) and path != "", do: "Workspace: #{path}"
  defp format_cwd_detail(_path), do: nil

  defp format_exit_code(code) when is_integer(code), do: "exit #{code}"

  defp format_exit_code(code) when is_binary(code) do
    case Integer.parse(code) do
      {parsed, ""} -> format_exit_code(parsed)
      _ -> nil
    end
  end

  defp format_exit_code(_code), do: nil

  defp format_exit_detail(code) do
    case format_exit_code(code) do
      nil -> nil
      formatted -> "Result: #{formatted}"
    end
  end

  defp status_detail(status, error) do
    [
      "State: #{humanize_status(status)}",
      if(present?(error), do: "Error: #{error}")
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
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
