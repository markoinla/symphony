defmodule SymphonyElixir.MCP.LinearToolsTest do
  use SymphonyElixir.TestSupport
  alias SymphonyElixir.MCP.LinearTools

  defp mock_opts(response_body) do
    [
      api_key: "test-token",
      http_client: fn _endpoint, _params -> {:ok, Jason.encode!(response_body)} end
    ]
  end

  describe "tool_definitions/0" do
    test "returns three tools" do
      tools = LinearTools.tool_definitions()
      assert length(tools) == 3
      assert Enum.map(tools, & &1["name"]) == ["linear_graphql", "linear_create_comment", "linear_update_comment"]
    end

    test "each tool has required fields" do
      Enum.each(LinearTools.tool_definitions(), fn tool ->
        assert is_binary(tool["name"])
        assert is_binary(tool["description"])
        assert is_map(tool["inputSchema"])
        assert tool["inputSchema"]["type"] == "object"
      end)
    end
  end

  describe "linear_graphql" do
    test "executes query successfully" do
      response = %{"data" => %{"viewer" => %{"id" => "user-1"}}}

      assert {:ok, text} = LinearTools.execute("linear_graphql", %{"query" => "{ viewer { id } }"}, mock_opts(response))

      decoded = Jason.decode!(text)
      assert decoded["data"]["viewer"]["id"] == "user-1"
    end

    test "passes variables to query" do
      opts = [
        api_key: "test-token",
        http_client: fn _endpoint, %{body: body, token: _, token_type: _} ->
          decoded = Jason.decode!(body)
          assert decoded["variables"]["id"] == "issue-1"
          {:ok, Jason.encode!(%{"data" => %{"issue" => %{"title" => "Test"}}})}
        end
      ]

      assert {:ok, _text} =
               LinearTools.execute(
                 "linear_graphql",
                 %{"query" => "query($id: String!) { issue(id: $id) { title } }", "variables" => %{"id" => "issue-1"}},
                 opts
               )
    end

    test "resolves api_key token with correct type" do
      opts = [
        api_key: "lin_api_test123",
        http_client: fn _endpoint, %{token: token, token_type: token_type} ->
          assert token == "lin_api_test123"
          assert token_type == :api_key
          {:ok, Jason.encode!(%{"data" => %{"viewer" => %{"id" => "u1"}}})}
        end
      ]

      assert {:ok, _text} = LinearTools.execute("linear_graphql", %{"query" => "{ viewer { id } }"}, opts)
    end

    test "sends oauth token with bearer type" do
      opts = [
        oauth_token: "oauth-tok-456",
        http_client: fn _endpoint, %{token: token, token_type: token_type} ->
          assert token == "oauth-tok-456"
          assert token_type == :bearer
          {:ok, Jason.encode!(%{"data" => %{"viewer" => %{"id" => "u1"}}})}
        end
      ]

      assert {:ok, _text} = LinearTools.execute("linear_graphql", %{"query" => "{ viewer { id } }"}, opts)
    end

    test "rejects empty query" do
      assert {:error, message} = LinearTools.execute("linear_graphql", %{"query" => ""}, mock_opts(%{}))
      assert message =~ "non-empty"
    end

    test "returns error when no auth is configured" do
      assert {:error, message} = LinearTools.execute("linear_graphql", %{"query" => "{ viewer { id } }"}, api_key: nil)
      assert message =~ "LINEAR_OAUTH_TOKEN" or message =~ "LINEAR_API_KEY"
    end
  end

  describe "linear_create_comment" do
    test "creates comment with agent reply tag" do
      opts = [
        api_key: "test-token",
        http_client: fn _endpoint, %{body: body, token: _, token_type: _} ->
          decoded = Jason.decode!(body)
          assert decoded["variables"]["input"]["body"] =~ "<!-- symphony:agent-reply -->"
          assert decoded["variables"]["input"]["body"] =~ "Hello world"
          assert decoded["variables"]["input"]["issueId"] == "issue-1"

          {:ok,
           Jason.encode!(%{
             "data" => %{
               "commentCreate" => %{
                 "success" => true,
                 "comment" => %{"id" => "comment-1"}
               }
             }
           })}
        end
      ]

      assert {:ok, text} =
               LinearTools.execute("linear_create_comment", %{"issue_id" => "issue-1", "body" => "Hello world"}, opts)

      decoded = Jason.decode!(text)
      assert decoded["commentId"] == "comment-1"
      assert decoded["issueId"] == "issue-1"
      assert decoded["success"] == true
    end

    test "rejects empty issue_id" do
      assert {:error, message} =
               LinearTools.execute("linear_create_comment", %{"issue_id" => "", "body" => "Hello"}, mock_opts(%{}))

      assert message =~ "issue_id"
    end

    test "rejects empty body" do
      assert {:error, message} =
               LinearTools.execute("linear_create_comment", %{"issue_id" => "id-1", "body" => ""}, mock_opts(%{}))

      assert message =~ "body"
    end
  end

  describe "linear_update_comment" do
    test "updates comment successfully" do
      opts = [
        api_key: "test-token",
        http_client: fn _endpoint, %{body: body, token: _, token_type: _} ->
          decoded = Jason.decode!(body)
          assert decoded["variables"]["id"] == "comment-1"
          assert decoded["variables"]["input"]["body"] == "Updated body"

          {:ok,
           Jason.encode!(%{
             "data" => %{
               "commentUpdate" => %{
                 "success" => true,
                 "comment" => %{"id" => "comment-1"}
               }
             }
           })}
        end
      ]

      assert {:ok, text} =
               LinearTools.execute("linear_update_comment", %{"comment_id" => "comment-1", "body" => "Updated body"}, opts)

      decoded = Jason.decode!(text)
      assert decoded["commentId"] == "comment-1"
      assert decoded["success"] == true
    end

    test "rejects empty comment_id" do
      assert {:error, message} =
               LinearTools.execute("linear_update_comment", %{"comment_id" => "", "body" => "Hello"}, mock_opts(%{}))

      assert message =~ "comment_id"
    end
  end

  describe "unknown tool" do
    test "returns error for unknown tool" do
      assert {:error, message} = LinearTools.execute("unknown_tool", %{}, mock_opts(%{}))
      assert message =~ "Unknown tool"
    end
  end
end
