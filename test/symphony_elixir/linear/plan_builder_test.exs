defmodule SymphonyElixir.Linear.PlanBuilderTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Linear.PlanBuilder

  describe "initial_plan/0" do
    test "returns five steps with correct initial statuses" do
      plan = PlanBuilder.initial_plan()
      assert length(plan) == 5
      assert Enum.at(plan, 0).status == "inProgress"
      assert Enum.all?(Enum.drop(plan, 1), &(&1.status == "pending"))
    end

    test "all steps have content" do
      plan = PlanBuilder.initial_plan()
      assert Enum.all?(plan, &is_binary(&1.content))
      assert Enum.all?(plan, &(&1.content != ""))
    end
  end

  describe "advance_step/3" do
    test "updates the status of a specific step" do
      plan = PlanBuilder.initial_plan()
      updated = PlanBuilder.advance_step(plan, 1, "inProgress")

      assert Enum.at(updated, 1).status == "inProgress"
      assert Enum.at(updated, 0).status == "inProgress"
      assert Enum.at(updated, 2).status == "pending"
    end

    test "can mark a step as completed" do
      plan = PlanBuilder.initial_plan()
      updated = PlanBuilder.advance_step(plan, 0, "completed")

      assert Enum.at(updated, 0).status == "completed"
    end
  end

  describe "finalize_plan/2" do
    test "marks all non-completed steps as completed on success" do
      plan =
        PlanBuilder.initial_plan()
        |> PlanBuilder.advance_step(0, "completed")
        |> PlanBuilder.advance_step(1, "completed")

      finalized = PlanBuilder.finalize_plan(plan, :completed)

      assert Enum.all?(finalized, &(&1.status == "completed"))
    end

    test "marks all non-completed steps as canceled on failure" do
      plan =
        PlanBuilder.initial_plan()
        |> PlanBuilder.advance_step(0, "completed")

      finalized = PlanBuilder.finalize_plan(plan, :failed)

      assert Enum.at(finalized, 0).status == "completed"
      assert Enum.at(finalized, 1).status == "canceled"
      assert Enum.at(finalized, 2).status == "canceled"
    end

    test "preserves completed steps on cancellation" do
      plan =
        PlanBuilder.initial_plan()
        |> PlanBuilder.advance_step(0, "completed")
        |> PlanBuilder.advance_step(1, "completed")

      finalized = PlanBuilder.finalize_plan(plan, :canceled)

      assert Enum.at(finalized, 0).status == "completed"
      assert Enum.at(finalized, 1).status == "completed"
      assert Enum.at(finalized, 2).status == "canceled"
    end
  end
end
