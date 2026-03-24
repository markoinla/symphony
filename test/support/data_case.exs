defmodule SymphonyElixir.DataCase do
  @moduledoc """
  Test case for tests that only need a database sandbox (no global workflow state).

  Unlike `SymphonyElixir.TestSupport`, this module does NOT write a WORKFLOW.md,
  set the global workflow file path, or reload the WorkflowStore. This makes it
  safe for `async: true` tests.

  Usage:

      use SymphonyElixir.DataCase, async: true
  """

  defmacro __using__(opts) do
    quote do
      use ExUnit.Case, unquote(opts)
      import ExUnit.CaptureLog

      alias Ecto.Adapters.SQL.Sandbox, as: SQLSandbox

      setup do
        :ok = SQLSandbox.checkout(SymphonyElixir.Repo)
        :ok
      end
    end
  end
end
