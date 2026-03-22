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

  @doc """
  Parses a workpad comment body and extracts the `### Plan` checklist
  into Linear Agent plan steps.

  Returns a list of plan steps or an empty list if no plan section is found.
  """
  @spec parse_workpad_plan(String.t()) :: [plan_step()]
  def parse_workpad_plan(body) when is_binary(body) do
    case extract_plan_section(body) do
      nil -> []
      section -> parse_checklist(section)
    end
  end

  def parse_workpad_plan(_), do: []

  defp extract_plan_section(body) do
    case Regex.run(~r/### Plan\s*\n(.*?)(?=\n###|\z)/s, body) do
      [_, section] -> String.trim(section)
      _ -> nil
    end
  end

  defp parse_checklist(section) do
    lines =
      section
      |> String.split("\n")
      |> Enum.map(&parse_checklist_line/1)
      |> Enum.reject(&is_nil/1)

    assign_statuses(lines)
  end

  defp parse_checklist_line(line) do
    case Regex.run(~r/^\s*- \[([ xX])\]\s+(.+)$/, line) do
      [_, check, content] ->
        checked = check != " "
        %{content: String.trim(content), checked: checked}

      _ ->
        nil
    end
  end

  defp assign_statuses(items) do
    {steps, _found_first_unchecked} =
      Enum.map_reduce(items, false, fn item, found_first_unchecked ->
        status =
          cond do
            item.checked -> "completed"
            not found_first_unchecked -> "inProgress"
            true -> "pending"
          end

        {%{content: item.content, status: status}, found_first_unchecked or not item.checked}
      end)

    steps
  end
end
