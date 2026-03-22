defmodule SymphonyElixir.Engine do
  @moduledoc """
  Behaviour for coding-agent engine backends (Codex, Claude Code, etc.).

  Each backend implements `start_session/2`, `run_turn/4`, and `stop_session/1`.
  The active backend is selected by the `engine` field in WORKFLOW.md config.
  """

  alias SymphonyElixir.Config

  @type session :: map()
  @type turn_result :: {:ok, map()} | {:error, term()}

  @callback start_session(workspace :: Path.t(), opts :: keyword()) ::
              {:ok, session()} | {:error, term()}

  @callback run_turn(session(), prompt :: String.t(), issue :: map(), opts :: keyword()) ::
              turn_result()

  @callback stop_session(session()) :: :ok

  @spec engine_module() :: module()
  def engine_module do
    case Config.settings!().engine do
      "claude" -> SymphonyElixir.Claude.AppServer
      _ -> SymphonyElixir.Codex.AppServer
    end
  end
end
