defmodule SymphonyElixir.Worker.Backend do
  @moduledoc """
  Behaviour for worker backends that execute Symphony agent runs.

  A backend owns the lifecycle of a `SymphonyElixir.Worker.Lease`: it
  decides how to acquire one for a given issue (local FS, SSH host pool,
  ephemeral cloud sandbox, …), how to run shell commands inside the lease,
  and how to release it when the run finishes.

  Today we ship two implementations:

    * `SymphonyElixir.Worker.Backend.Local` — runs commands on the
      current OTP node via `System.cmd/3`.
    * `SymphonyElixir.Worker.Backend.SSHStatic` — runs commands on a
      configured pool of SSH hosts via `SymphonyElixir.SSH`.

  A future `CloudflareSandbox` backend will dispatch through an HTTP
  Worker; it implements the same callbacks.

  The active backend is selected by the `worker.backend` workflow config
  field. The `:auto` default preserves Symphony's historical behaviour:
  if `worker.ssh_hosts` is empty the local backend is used, otherwise
  the SSH backend is used.
  """

  alias SymphonyElixir.Config
  alias SymphonyElixir.Worker.Lease

  @type lease :: Lease.t()
  @type exec_result :: %{exit: integer(), stdout: String.t(), stderr: String.t()}

  @doc """
  Acquire a lease for `issue`.

  Backends may inspect `opts` for backend-specific hints, e.g. SSHStatic
  reads `:host` to lock onto a particular pool member chosen by the
  orchestrator's load balancer.
  """
  @callback acquire(issue :: map(), opts :: keyword()) ::
              {:ok, lease()} | {:error, term()}

  @doc """
  Resolve a previously serialized lease id back into a usable lease.

  Used after process restart or when a retry needs to re-attach to an
  existing remote workspace. May return `{:error, :not_found}` if the
  underlying resource has been reclaimed.
  """
  @callback resolve(lease_id :: String.t(), opts :: keyword()) ::
              {:ok, lease()} | {:error, term()}

  @doc """
  Run a shell command inside `lease` and wait for it to exit.

  Most callers want `stderr_to_stdout: true` (the default for hook
  execution today). The result map's `:exit` is the exit code; `:stdout`
  is the captured stdout (and stderr if merged); `:stderr` is the
  separate stderr stream when not merged, or empty when merged.
  """
  @callback exec(lease(), command :: String.t(), opts :: keyword()) ::
              {:ok, exec_result()} | {:error, term()}

  @doc """
  Write `content` to `path` on the lease's filesystem, creating parent
  directories as needed.
  """
  @callback write_file(lease(), path :: String.t(), content :: binary(), opts :: keyword()) ::
              :ok | {:error, term()}

  @doc """
  Read `path` from the lease's filesystem.
  """
  @callback read_file(lease(), path :: String.t(), opts :: keyword()) ::
              {:ok, binary()} | {:error, term()}

  @doc """
  Release the lease, freeing any resources the backend owns (remote
  workspace, sandbox container, …). Local backends typically no-op.
  """
  @callback release(lease(), opts :: keyword()) :: :ok | {:error, term()}

  @doc """
  Mark the lease as still in use. Backends with idle-timeout reclamation
  (e.g. cloud sandboxes) use this as a keep-alive ping. Local and
  SSHStatic backends no-op.
  """
  @callback touch(lease(), opts :: keyword()) :: :ok | {:error, term()}

  @doc """
  Return the backend module configured for the active workflow.

  Equivalent to `resolve_backend(Config.settings!().worker.backend)`.
  """
  @spec current() :: module()
  def current do
    resolve_backend(Config.settings!().worker.backend)
  end

  @doc """
  Map a `worker.backend` config atom to the backing module.

  `:auto` (the default) looks at `worker.ssh_hosts` and picks
  `Local` when empty, `SSHStatic` otherwise. This preserves the
  pre-behaviour default that "ssh_hosts present means use SSH".
  """
  @spec resolve_backend(atom() | nil) :: module()
  def resolve_backend(nil), do: resolve_backend(:auto)

  def resolve_backend(:auto) do
    case Config.settings!().worker.ssh_hosts do
      [] -> SymphonyElixir.Worker.Backend.Local
      _ -> SymphonyElixir.Worker.Backend.SSHStatic
    end
  end

  def resolve_backend(:local), do: SymphonyElixir.Worker.Backend.Local
  def resolve_backend(:ssh_static), do: SymphonyElixir.Worker.Backend.SSHStatic
  def resolve_backend(:cloudflare_sandbox), do: SymphonyElixir.Worker.Backend.CloudflareSandbox
end
