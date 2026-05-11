defmodule SymphonyElixir.Worker.Lease do
  @moduledoc """
  A claim on worker resources for a single agent run.

  A `Lease` is the handle that the orchestrator passes to the agent runner
  and that the runner threads through workspace setup, hook execution, and
  engine launch. The `host` field is the human-readable string used for
  display and persistence (`"local"`, `"worker.example:2222"`,
  `"sandbox:abc123"`). The `backend` field is the module that implements
  `SymphonyElixir.Worker.Backend` and knows how to actually execute
  commands against the lease.
  """

  @enforce_keys [:id, :backend, :host]
  defstruct [:id, :backend, :host, meta: %{}]

  @type t :: %__MODULE__{
          id: String.t(),
          backend: module(),
          host: String.t(),
          meta: map()
        }

  @doc """
  Returns true when the lease points at the local host.

  Used by callers that need to keep a local-only fast path (for example
  workspace path canonicalization, which only makes sense for paths the
  current OTP node can stat).
  """
  @spec local?(t()) :: boolean()
  def local?(%__MODULE__{backend: SymphonyElixir.Worker.Backend.Local}), do: true
  def local?(%__MODULE__{}), do: false
end
