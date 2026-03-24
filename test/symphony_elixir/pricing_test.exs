defmodule SymphonyElixir.PricingTest do
  use SymphonyElixir.TestSupport

  import ExUnit.CaptureLog

  alias SymphonyElixir.Pricing

  describe "cost_cents/3" do
    test "calculates cost for claude-sonnet model" do
      # 1M input tokens at 300 cents + 1M output tokens at 1500 cents = 1800 cents
      assert Pricing.cost_cents("claude-sonnet-4-6", 1_000_000, 1_000_000) == 1_800
    end

    test "calculates cost for claude-haiku model" do
      # 1M input tokens at 80 cents + 1M output tokens at 400 cents = 480 cents
      assert Pricing.cost_cents("claude-haiku-4-5", 1_000_000, 1_000_000) == 480
    end

    test "returns 0 and logs warning for unknown model" do
      log =
        capture_log(fn ->
          assert Pricing.cost_cents("gpt-4o", 1_000_000, 1_000_000) == 0
        end)

      assert log =~ "Unknown model for pricing: gpt-4o"
    end

    test "handles partial token counts" do
      # 500K input at 300/MTok = 150 cents, 200K output at 1500/MTok = 300 cents = 450 cents
      assert Pricing.cost_cents("claude-sonnet-4-6", 500_000, 200_000) == 450
    end

    test "returns 0 for zero tokens" do
      assert Pricing.cost_cents("claude-sonnet-4-6", 0, 0) == 0
    end
  end
end
