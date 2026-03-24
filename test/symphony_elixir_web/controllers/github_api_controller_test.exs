defmodule SymphonyElixirWeb.GithubApiControllerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.GithubApiController

  @sample_repos [
    %{"full_name" => "org/agent-workflow", "name" => "agent-workflow"},
    %{"full_name" => "org/workflow-tools", "name" => "workflow-tools"},
    %{"full_name" => "org/my-agent", "name" => "my-agent"},
    %{"full_name" => "org/unrelated-repo", "name" => "unrelated-repo"}
  ]

  describe "filter_repos/2" do
    test "empty query returns up to 20 repos unfiltered" do
      result = GithubApiController.filter_repos(@sample_repos, "")
      assert result == @sample_repos
    end

    test "single word matches repos containing that word in full_name" do
      result = GithubApiController.filter_repos(@sample_repos, "workflow")

      assert length(result) == 2

      assert Enum.all?(result, fn repo ->
               String.contains?(repo["full_name"], "workflow")
             end)
    end

    test "multi-word query matches repos where ALL words appear" do
      result = GithubApiController.filter_repos(@sample_repos, "agent workflow")

      assert length(result) == 1
      assert hd(result)["full_name"] == "org/agent-workflow"
    end

    test "word order does not matter" do
      result_forward = GithubApiController.filter_repos(@sample_repos, "agent workflow")
      result_reverse = GithubApiController.filter_repos(@sample_repos, "workflow agent")

      assert result_forward == result_reverse
    end

    test "matching is case insensitive against repo names" do
      # filter_repos expects a pre-lowercased query (the controller downcases before calling)
      repos = [%{"full_name" => "Org/Agent-Workflow", "name" => "Agent-Workflow"}]
      result = GithubApiController.filter_repos(repos, "agent workflow")

      assert length(result) == 1
      assert hd(result)["full_name"] == "Org/Agent-Workflow"
    end

    test "extra whitespace between words is handled" do
      result = GithubApiController.filter_repos(@sample_repos, "  agent   workflow  ")

      assert length(result) == 1
      assert hd(result)["full_name"] == "org/agent-workflow"
    end

    test "no matches returns empty list" do
      result = GithubApiController.filter_repos(@sample_repos, "nonexistent")
      assert result == []
    end

    test "matches against name field as well" do
      repos = [%{"full_name" => "org/something", "name" => "workflow-agent"}]
      result = GithubApiController.filter_repos(repos, "workflow agent")

      assert length(result) == 1
    end

    test "limits results to 20" do
      many_repos =
        Enum.map(1..30, fn i ->
          %{"full_name" => "org/workflow-#{i}", "name" => "workflow-#{i}"}
        end)

      result = GithubApiController.filter_repos(many_repos, "workflow")
      assert length(result) == 20
    end
  end
end
