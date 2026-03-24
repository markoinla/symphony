defmodule SymphonyElixir.Pricing do
  @moduledoc """
  Token-based cost estimation for LLM models.

  Rates are stored as integer cents per million tokens to avoid floating-point arithmetic.
  """

  require Logger

  @rates %{
    "claude-opus" => {5_00, 25_00},
    "claude-sonnet" => {3_00, 15_00},
    "claude-haiku" => {0_80, 4_00}
  }

  @spec cost_cents(String.t(), non_neg_integer(), non_neg_integer()) :: non_neg_integer()
  def cost_cents(model, input_tokens, output_tokens) do
    case find_rate(model) do
      {input_rate, output_rate} ->
        div(input_tokens * input_rate + output_tokens * output_rate, 1_000_000)

      nil ->
        Logger.warning("Unknown model for pricing: #{model}")
        0
    end
  end

  @spec find_rate(String.t()) :: {non_neg_integer(), non_neg_integer()} | nil
  defp find_rate(model) do
    Enum.find_value(@rates, fn {prefix, rate} ->
      if String.contains?(model, prefix), do: rate
    end)
  end
end
