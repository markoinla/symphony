defmodule SymphonyElixir.Linear.PlanBuilder do
  @moduledoc """
  Builds and manages the agent plan sent to Linear via `AgentAPI.update_session/2`.

  Plans are simple lists of step maps with `:title` and `:status` fields.
  """

  @type step :: %{title: String.t(), status: :pending | :in_progress | :completed | :canceled}
  @type plan :: [step()]

  @default_steps [
    "Analyze issue",
    "Set up workspace",
    "Implement changes",
    "Validate solution",
    "Submit for review"
  ]

  @doc """
  Returns the default 5-step plan for the given issue.

  All steps start as `:pending`.
  """
  @spec initial_plan(map()) :: plan()
  def initial_plan(_issue) do
    Enum.map(@default_steps, fn title ->
      %{title: title, status: :pending}
    end)
  end

  @doc """
  Advances the step at `step_index` to the given `status`.

  Returns the updated plan, or the original plan if the index is out of bounds.
  """
  @spec advance_step(plan(), non_neg_integer(), :in_progress | :completed | :canceled) :: plan()
  def advance_step(plan, step_index, status)
      when is_list(plan) and is_integer(step_index) and step_index >= 0 and
             status in [:in_progress, :completed, :canceled] do
    if step_index < length(plan) do
      List.update_at(plan, step_index, fn step ->
        %{step | status: status}
      end)
    else
      plan
    end
  end

  @doc """
  Finalizes all steps in the plan based on the outcome.

  For `:success`, pending/in_progress steps become `:completed`.
  For `:failure` or `:canceled`, pending/in_progress steps become `:canceled`.
  Already completed or canceled steps are left unchanged.
  """
  @spec finalize_plan(plan(), :success | :failure | :canceled) :: plan()
  def finalize_plan(plan, outcome) when outcome in [:success, :failure, :canceled] do
    target_status = if outcome == :success, do: :completed, else: :canceled

    Enum.map(plan, fn step ->
      if step.status in [:pending, :in_progress] do
        %{step | status: target_status}
      else
        step
      end
    end)
  end

  @doc """
  Encodes a plan as a JSON string suitable for `AgentAPI.update_session/2`.
  """
  @spec encode(plan()) :: String.t()
  def encode(plan) when is_list(plan) do
    plan
    |> Enum.map(fn step ->
      %{"title" => step.title, "status" => to_string(step.status)}
    end)
    |> Jason.encode!()
  end
end
