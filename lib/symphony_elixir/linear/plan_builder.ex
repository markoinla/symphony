defmodule SymphonyElixir.Linear.PlanBuilder do
  @moduledoc """
  Builds and updates Agent Plans for Linear Agent Sessions.
  """

  @type plan_step :: %{content: String.t(), status: String.t()}

  @spec initial_plan() :: [plan_step()]
  def initial_plan do
    [
      %{content: "Analyze issue", status: "inProgress"},
      %{content: "Set up workspace", status: "pending"},
      %{content: "Implement changes", status: "pending"},
      %{content: "Validate and test", status: "pending"},
      %{content: "Submit results", status: "pending"}
    ]
  end

  @spec advance_step([plan_step()], non_neg_integer(), String.t()) :: [plan_step()]
  def advance_step(plan, step_index, status)
      when is_list(plan) and is_integer(step_index) and is_binary(status) do
    List.update_at(plan, step_index, fn step ->
      %{step | status: status}
    end)
  end

  @spec finalize_plan([plan_step()], :completed | :failed | :canceled) :: [plan_step()]
  def finalize_plan(plan, outcome) when is_list(plan) do
    terminal_status =
      case outcome do
        :completed -> "completed"
        :failed -> "canceled"
        :canceled -> "canceled"
      end

    Enum.map(plan, fn step ->
      case step.status do
        "completed" -> step
        "inProgress" -> %{step | status: terminal_status}
        _ -> %{step | status: terminal_status}
      end
    end)
  end
end
