defmodule SymphonyElixir.AgentRunnerPrUrlTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.AgentRunner

  describe "extract_pr_url_for_test/1" do
    test "extracts PR URL from gh pr create output" do
      output = """
      Creating pull request for sym-133/add-pr-url into main in markoinla/symphony

      https://github.com/markoinla/symphony/pull/42
      """

      assert AgentRunner.extract_pr_url_for_test(output) ==
               "https://github.com/markoinla/symphony/pull/42"
    end

    test "extracts PR URL from inline text" do
      content = "PR created at https://github.com/org/repo/pull/123 successfully"

      assert AgentRunner.extract_pr_url_for_test(content) ==
               "https://github.com/org/repo/pull/123"
    end

    test "returns nil when no PR URL present" do
      assert AgentRunner.extract_pr_url_for_test("no url here") == nil
    end

    test "returns nil for empty content" do
      assert AgentRunner.extract_pr_url_for_test("") == nil
    end

    test "returns nil for non-PR GitHub URLs" do
      assert AgentRunner.extract_pr_url_for_test("https://github.com/org/repo/issues/5") == nil
    end

    test "extracts first PR URL when multiple present" do
      content = """
      https://github.com/org/repo/pull/10
      https://github.com/org/repo/pull/20
      """

      assert AgentRunner.extract_pr_url_for_test(content) ==
               "https://github.com/org/repo/pull/10"
    end

    test "handles PR URL with trailing text" do
      content = "See https://github.com/org/repo/pull/99 for details."

      assert AgentRunner.extract_pr_url_for_test(content) ==
               "https://github.com/org/repo/pull/99"
    end
  end
end
