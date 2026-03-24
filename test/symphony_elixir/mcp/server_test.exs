defmodule SymphonyElixir.MCP.ServerTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.MCP.Server

  defp call(message, opts \\ []) do
    line = Jason.encode!(message)

    case Server.handle_message(line, opts) do
      nil -> nil
      response -> Jason.decode!(response)
    end
  end

  test "initialize returns protocol version and capabilities" do
    response = call(%{"jsonrpc" => "2.0", "id" => 1, "method" => "initialize", "params" => %{}})

    assert response["id"] == 1
    assert response["result"]["protocolVersion"] == "2024-11-05"
    assert response["result"]["capabilities"]["tools"] == %{}
    assert response["result"]["serverInfo"]["name"] == "symphony-linear"
  end

  test "notifications/initialized returns nil (no response)" do
    assert call(%{"jsonrpc" => "2.0", "method" => "notifications/initialized"}) == nil
  end

  test "tools/list returns three Linear tools" do
    response = call(%{"jsonrpc" => "2.0", "id" => 2, "method" => "tools/list", "params" => %{}})

    tools = response["result"]["tools"]
    assert length(tools) == 3

    tool_names = Enum.map(tools, & &1["name"])
    assert "linear_graphql" in tool_names
    assert "linear_create_comment" in tool_names
    assert "linear_update_comment" in tool_names

    Enum.each(tools, fn tool ->
      assert is_binary(tool["description"])
      assert is_map(tool["inputSchema"])
    end)
  end

  test "tools/call dispatches to linear_graphql" do
    mock_http = fn _endpoint, %{body: body, token: _token, token_type: _type} ->
      decoded = Jason.decode!(body)
      assert decoded["query"] =~ "viewer"
      {:ok, Jason.encode!(%{"data" => %{"viewer" => %{"id" => "user-1"}}})}
    end

    response =
      call(
        %{
          "jsonrpc" => "2.0",
          "id" => 3,
          "method" => "tools/call",
          "params" => %{
            "name" => "linear_graphql",
            "arguments" => %{"query" => "{ viewer { id } }"}
          }
        },
        http_client: mock_http,
        api_key: "test-token"
      )

    assert response["id"] == 3
    assert [%{"type" => "text", "text" => text}] = response["result"]["content"]
    assert Jason.decode!(text)["data"]["viewer"]["id"] == "user-1"
  end

  test "tools/call returns error for missing api key" do
    response =
      call(
        %{
          "jsonrpc" => "2.0",
          "id" => 4,
          "method" => "tools/call",
          "params" => %{
            "name" => "linear_graphql",
            "arguments" => %{"query" => "{ viewer { id } }"}
          }
        },
        api_key: nil
      )

    assert response["result"]["isError"] == true
    assert [%{"text" => text}] = response["result"]["content"]
    assert text =~ "LINEAR_OAUTH_TOKEN" or text =~ "LINEAR_API_KEY"
  end

  test "tools/call returns error for unknown tool" do
    response =
      call(
        %{
          "jsonrpc" => "2.0",
          "id" => 5,
          "method" => "tools/call",
          "params" => %{
            "name" => "nonexistent",
            "arguments" => %{}
          }
        },
        api_key: "test-token"
      )

    assert response["result"]["isError"] == true
  end

  test "unknown method returns method not found error" do
    response = call(%{"jsonrpc" => "2.0", "id" => 6, "method" => "foo/bar", "params" => %{}})

    assert response["error"]["code"] == -32_601
    assert response["error"]["message"] =~ "foo/bar"
  end

  test "malformed JSON returns parse error" do
    response = Server.handle_message("not json at all")
    decoded = Jason.decode!(response)

    assert decoded["error"]["code"] == -32_700
  end
end
