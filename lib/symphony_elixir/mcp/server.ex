defmodule SymphonyElixir.MCP.Server do
  @moduledoc """
  MCP (Model Context Protocol) stdio server exposing Linear tools.

  Speaks JSON-RPC 2.0 over stdin/stdout. Claude Code spawns this as a subprocess
  via the MCP stdio transport.
  """

  alias SymphonyElixir.MCP.LinearTools

  @spec run() :: no_return()
  def run do
    loop()
  end

  @spec handle_message(String.t(), keyword()) :: String.t() | nil
  def handle_message(line, opts \\ []) do
    case Jason.decode(line) do
      {:ok, message} ->
        case dispatch(message, opts) do
          nil -> nil
          response -> Jason.encode!(response)
        end

      {:error, _} ->
        Jason.encode!(json_rpc_error(nil, -32_700, "Parse error"))
    end
  end

  defp loop do
    case IO.read(:stdio, :line) do
      :eof ->
        :ok

      {:error, _reason} ->
        :ok

      line ->
        line |> String.trim_trailing("\n") |> process_line()
        loop()
    end
  end

  defp process_line(""), do: :ok

  defp process_line(line) do
    case handle_message(line) do
      nil -> :ok
      response -> IO.write(:stdio, response <> "\n")
    end
  end

  defp dispatch(%{"method" => "initialize", "id" => id}, _opts) do
    %{
      "jsonrpc" => "2.0",
      "id" => id,
      "result" => %{
        "protocolVersion" => "2024-11-05",
        "capabilities" => %{
          "tools" => %{}
        },
        "serverInfo" => %{
          "name" => "symphony-linear",
          "version" => "0.1.0"
        }
      }
    }
  end

  defp dispatch(%{"method" => "notifications/initialized"}, _opts), do: nil

  defp dispatch(%{"method" => "tools/list", "id" => id}, _opts) do
    %{
      "jsonrpc" => "2.0",
      "id" => id,
      "result" => %{
        "tools" => LinearTools.tool_definitions()
      }
    }
  end

  defp dispatch(%{"method" => "tools/call", "id" => id, "params" => params}, opts) do
    tool_name = Map.get(params, "name", "")
    arguments = Map.get(params, "arguments", %{})

    case LinearTools.execute(tool_name, arguments, opts) do
      {:ok, text} ->
        %{
          "jsonrpc" => "2.0",
          "id" => id,
          "result" => %{
            "content" => [%{"type" => "text", "text" => text}]
          }
        }

      {:error, error_text} ->
        %{
          "jsonrpc" => "2.0",
          "id" => id,
          "result" => %{
            "content" => [%{"type" => "text", "text" => error_text}],
            "isError" => true
          }
        }
    end
  end

  defp dispatch(%{"id" => id, "method" => method}, _opts) do
    json_rpc_error(id, -32_601, "Method not found: #{method}")
  end

  # Notifications (no id) that we don't handle — ignore silently
  defp dispatch(%{"method" => _}, _opts), do: nil

  defp dispatch(%{"id" => id}, _opts) do
    json_rpc_error(id, -32_600, "Invalid request")
  end

  defp dispatch(_, _opts) do
    json_rpc_error(nil, -32_600, "Invalid request")
  end

  defp json_rpc_error(id, code, message) do
    %{
      "jsonrpc" => "2.0",
      "id" => id,
      "error" => %{
        "code" => code,
        "message" => message
      }
    }
  end
end
