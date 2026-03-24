defmodule SymphonyElixirWeb.LinearApiControllerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.LinearApiController

  describe "project_filter/1" do
    test "empty query returns started-only filter" do
      assert LinearApiController.project_filter("") == %{state: %{eq: "started"}}
    end

    test "single word returns name filter with started/planned states" do
      result = LinearApiController.project_filter("workflow")

      assert result == %{
               name: %{containsIgnoreCase: "workflow"},
               state: %{in: ["started", "planned"]}
             }
    end

    test "multi-word query creates AND filter matching each word independently" do
      result = LinearApiController.project_filter("workflow agent")

      assert result == %{
               and: [
                 %{name: %{containsIgnoreCase: "workflow"}},
                 %{name: %{containsIgnoreCase: "agent"}}
               ],
               state: %{in: ["started", "planned"]}
             }
    end

    test "extra whitespace is trimmed between words" do
      result = LinearApiController.project_filter("  workflow   agent  ")

      assert result == %{
               and: [
                 %{name: %{containsIgnoreCase: "workflow"}},
                 %{name: %{containsIgnoreCase: "agent"}}
               ],
               state: %{in: ["started", "planned"]}
             }
    end

    test "three or more words all produce AND conditions" do
      result = LinearApiController.project_filter("my cool project")

      assert result == %{
               and: [
                 %{name: %{containsIgnoreCase: "my"}},
                 %{name: %{containsIgnoreCase: "cool"}},
                 %{name: %{containsIgnoreCase: "project"}}
               ],
               state: %{in: ["started", "planned"]}
             }
    end
  end
end
