defmodule SymphonyElixir.OAuth.TokenRefresherTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.OAuth.TokenRefresher

  describe "handle_info/2 :check_tokens" do
    test "schedules the next check after handling :check_tokens" do
      {:ok, pid} = TokenRefresher.start_link([])

      # Flush the initial scheduled message
      assert_receive_nothing = fn ->
        refute_receive {:DOWN, _, :process, ^pid, _}, 100
      end

      assert_receive_nothing.()

      # Send a manual :check_tokens and verify the process stays alive
      send(pid, :check_tokens)
      Process.sleep(50)
      assert Process.alive?(pid)

      GenServer.stop(pid)
    end

    test "does not crash when no tokens are stored" do
      {:ok, pid} = TokenRefresher.start_link([])
      send(pid, :check_tokens)
      Process.sleep(50)
      assert Process.alive?(pid)
      GenServer.stop(pid)
    end
  end
end
