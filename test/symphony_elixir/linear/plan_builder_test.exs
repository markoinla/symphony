defmodule SymphonyElixir.Linear.PlanBuilderTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Linear.PlanBuilder

  describe "initial_plan/1" do
    test "returns 5-step default plan with all pending" do
      plan = PlanBuilder.initial_plan(%{id: "issue-1", title: "Test"})

      assert length(plan) == 5
      assert Enum.all?(plan, fn step -> step.status == :pending end)

      titles = Enum.map(plan, & &1.title)
      assert titles == ["Analyze issue", "Set up workspace", "Implement changes", "Validate solution", "Submit for review"]
    end

    test "ignores issue contents" do
      plan1 = PlanBuilder.initial_plan(%{})
      plan2 = PlanBuilder.initial_plan(%{id: "x", title: "y", description: "z"})
      assert plan1 == plan2
    end
  end

  describe "advance_step/3" do
    test "advances a step to in_progress" do
      plan = PlanBuilder.initial_plan(%{})
      updated = PlanBuilder.advance_step(plan, 0, :in_progress)

      assert Enum.at(updated, 0).status == :in_progress
      assert Enum.at(updated, 1).status == :pending
    end

    test "advances a step to completed" do
      plan = PlanBuilder.initial_plan(%{})
      updated = PlanBuilder.advance_step(plan, 2, :completed)

      assert Enum.at(updated, 2).status == :completed
      assert Enum.at(updated, 0).status == :pending
    end

    test "advances a step to canceled" do
      plan = PlanBuilder.initial_plan(%{})
      updated = PlanBuilder.advance_step(plan, 4, :canceled)

      assert Enum.at(updated, 4).status == :canceled
    end

    test "returns unchanged plan for out of bounds index" do
      plan = PlanBuilder.initial_plan(%{})
      assert PlanBuilder.advance_step(plan, 10, :completed) == plan
      assert PlanBuilder.advance_step(plan, 5, :completed) == plan
    end

    test "does not modify other steps" do
      plan =
        PlanBuilder.initial_plan(%{})
        |> PlanBuilder.advance_step(0, :completed)
        |> PlanBuilder.advance_step(1, :in_progress)

      assert Enum.at(plan, 0).status == :completed
      assert Enum.at(plan, 1).status == :in_progress
      assert Enum.at(plan, 2).status == :pending
    end
  end

  describe "finalize_plan/2" do
    test "marks all pending/in_progress as completed on success" do
      plan =
        PlanBuilder.initial_plan(%{})
        |> PlanBuilder.advance_step(0, :completed)
        |> PlanBuilder.advance_step(1, :in_progress)

      finalized = PlanBuilder.finalize_plan(plan, :success)

      assert Enum.all?(finalized, fn step -> step.status == :completed end)
    end

    test "marks all pending/in_progress as canceled on failure" do
      plan =
        PlanBuilder.initial_plan(%{})
        |> PlanBuilder.advance_step(0, :completed)
        |> PlanBuilder.advance_step(1, :in_progress)

      finalized = PlanBuilder.finalize_plan(plan, :failure)

      assert Enum.at(finalized, 0).status == :completed
      assert Enum.at(finalized, 1).status == :canceled
      assert Enum.at(finalized, 2).status == :canceled
    end

    test "marks all pending/in_progress as canceled on canceled outcome" do
      plan = PlanBuilder.initial_plan(%{})
      finalized = PlanBuilder.finalize_plan(plan, :canceled)

      assert Enum.all?(finalized, fn step -> step.status == :canceled end)
    end

    test "preserves already completed steps on failure" do
      plan =
        PlanBuilder.initial_plan(%{})
        |> PlanBuilder.advance_step(0, :completed)
        |> PlanBuilder.advance_step(1, :completed)

      finalized = PlanBuilder.finalize_plan(plan, :failure)

      assert Enum.at(finalized, 0).status == :completed
      assert Enum.at(finalized, 1).status == :completed
      assert Enum.at(finalized, 2).status == :canceled
    end

    test "preserves already canceled steps on success" do
      plan =
        PlanBuilder.initial_plan(%{})
        |> PlanBuilder.advance_step(0, :completed)
        |> PlanBuilder.advance_step(1, :canceled)

      finalized = PlanBuilder.finalize_plan(plan, :success)

      assert Enum.at(finalized, 0).status == :completed
      assert Enum.at(finalized, 1).status == :canceled
      assert Enum.at(finalized, 2).status == :completed
    end
  end

  describe "encode/1" do
    test "encodes plan as JSON array" do
      plan = PlanBuilder.initial_plan(%{})
      json = PlanBuilder.encode(plan)
      decoded = Jason.decode!(json)

      assert length(decoded) == 5
      assert hd(decoded) == %{"title" => "Analyze issue", "status" => "pending"}
    end

    test "encodes mixed statuses" do
      plan =
        PlanBuilder.initial_plan(%{})
        |> PlanBuilder.advance_step(0, :completed)
        |> PlanBuilder.advance_step(1, :in_progress)

      json = PlanBuilder.encode(plan)
      decoded = Jason.decode!(json)

      assert Enum.at(decoded, 0)["status"] == "completed"
      assert Enum.at(decoded, 1)["status"] == "in_progress"
      assert Enum.at(decoded, 2)["status"] == "pending"
    end
  end
end
