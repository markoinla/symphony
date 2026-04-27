defmodule SymphonyElixir.Linear.OAuth.RefresherTest do
  @moduledoc """
  Pure-function tests for the Refresher's error-classification and
  scheduling helpers. The full GenServer behaviour is covered by
  `SymphonyElixir.Linear.OAuthTest` (which exercises Store-backed
  integration).
  """

  use ExUnit.Case, async: true

  alias SymphonyElixir.Linear.OAuth.Refresher

  describe "invalid_grant?/2" do
    test "true for 400 with invalid_grant body" do
      assert Refresher.invalid_grant?(400, %{"error" => "invalid_grant"})
    end

    test "true for 401 with invalid_grant body" do
      assert Refresher.invalid_grant?(401, %{"error" => "invalid_grant"})
    end

    test "true for unauthorized_client" do
      assert Refresher.invalid_grant?(400, %{"error" => "unauthorized_client"})
    end

    test "false for invalid_request (transient)" do
      refute Refresher.invalid_grant?(400, %{"error" => "invalid_request"})
    end

    test "false for non-4xx status" do
      refute Refresher.invalid_grant?(500, %{"error" => "invalid_grant"})
      refute Refresher.invalid_grant?(503, %{"error" => "invalid_grant"})
    end

    test "false for missing or unrecognized body" do
      refute Refresher.invalid_grant?(400, %{})
      refute Refresher.invalid_grant?(400, "string body")
      refute Refresher.invalid_grant?(400, nil)
    end
  end

  describe "format_invalid_grant/1" do
    test "combines error and description when both present" do
      body = %{"error" => "invalid_grant", "error_description" => "refresh token expired"}
      assert Refresher.format_invalid_grant(body) == "invalid_grant: refresh token expired"
    end

    test "falls back to error code when no description" do
      assert Refresher.format_invalid_grant(%{"error" => "unauthorized_client"}) ==
               "unauthorized_client"
    end

    test "falls back to invalid_grant for unrecognized shapes" do
      assert Refresher.format_invalid_grant(%{}) == "invalid_grant"
      assert Refresher.format_invalid_grant("opaque") == "invalid_grant"
    end
  end

  describe "delay_for_expiry/1" do
    test ":no_token for nil" do
      assert Refresher.delay_for_expiry(nil) == :no_token
    end

    test ":no_token for unparseable input" do
      assert Refresher.delay_for_expiry("not-a-date") == :no_token
    end

    test "0 for already-expired tokens" do
      past = DateTime.utc_now() |> DateTime.add(-3600, :second) |> DateTime.to_iso8601()
      assert {:ok, 0} = Refresher.delay_for_expiry(past)
    end

    test "0 when within the 5-minute refresh buffer" do
      soon = DateTime.utc_now() |> DateTime.add(60, :second) |> DateTime.to_iso8601()
      assert {:ok, 0} = Refresher.delay_for_expiry(soon)
    end

    test "schedules for (expires_at - 5min) when far in the future" do
      future = DateTime.utc_now() |> DateTime.add(900, :second) |> DateTime.to_iso8601()
      assert {:ok, ms} = Refresher.delay_for_expiry(future)
      # 900 - 300 = 600s = 600_000ms, allow ±2s for clock drift
      assert ms in 598_000..602_000
    end

    test "caps the timer so it doesn't sleep beyond ~6 hours" do
      far_future = DateTime.utc_now() |> DateTime.add(48 * 3600, :second) |> DateTime.to_iso8601()
      assert {:ok, ms} = Refresher.delay_for_expiry(far_future)
      assert ms == 6 * 60 * 60 * 1000
    end
  end
end
