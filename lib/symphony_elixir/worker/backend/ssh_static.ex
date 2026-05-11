defmodule SymphonyElixir.Worker.Backend.SSHStatic do
  @moduledoc """
  SSH-static worker backend.

  Acquires leases against a configured pool of SSH hosts
  (`worker.ssh_hosts`) and runs commands via `SymphonyElixir.SSH`.
  Host selection is handled by the orchestrator's load balancer; the
  selected host is passed to `acquire/2` as `:host`.
  """

  @behaviour SymphonyElixir.Worker.Backend

  alias SymphonyElixir.SSH
  alias SymphonyElixir.Worker.Lease

  # Lease ids are encoded as `ssh:<host>|<identifier>`. We use `|` instead of
  # `:` between host and identifier so SSH host:port targets (e.g.
  # `worker.example:2200`) and bracketed IPv6 literals (e.g. `[::1]:2200`)
  # round-trip without their port being parsed off as part of the identifier.
  @host_separator "|"

  @impl true
  def acquire(issue, opts \\ []) do
    case Keyword.get(opts, :host) do
      host when is_binary(host) and host != "" ->
        identifier = issue_identifier(issue) || Keyword.get(opts, :identifier) || "issue"

        {:ok,
         %Lease{
           id: "ssh:" <> host <> @host_separator <> identifier,
           backend: __MODULE__,
           host: host,
           meta: %{identifier: identifier, ssh_target: host}
         }}

      _ ->
        {:error, :missing_ssh_host}
    end
  end

  @impl true
  def resolve(lease_id, _opts \\ []) when is_binary(lease_id) do
    with ["ssh", rest] <- String.split(lease_id, ":", parts: 2),
         [host, identifier] when host != "" <- String.split(rest, @host_separator, parts: 2) do
      {:ok,
       %Lease{
         id: lease_id,
         backend: __MODULE__,
         host: host,
         meta: %{identifier: identifier, ssh_target: host}
       }}
    else
      _ -> {:error, :invalid_lease_id}
    end
  end

  @impl true
  def exec(%Lease{backend: __MODULE__, host: host}, command, opts \\ [])
      when is_binary(command) do
    cwd = Keyword.get(opts, :cwd)
    env = Keyword.get(opts, :env, [])
    stderr_to_stdout = Keyword.get(opts, :stderr_to_stdout, true)
    ssh_opts = if stderr_to_stdout, do: [stderr_to_stdout: true], else: []

    full_command = build_remote_command(command, cwd, env)

    case SSH.run(host, full_command, ssh_opts) do
      {:ok, {output, status}} ->
        binary_output = IO.iodata_to_binary(output)
        {:ok, %{exit: status, stdout: binary_output, stderr: ""}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl true
  def write_file(%Lease{backend: __MODULE__, host: host}, path, content, _opts \\ [])
      when is_binary(path) and is_binary(content) do
    encoded = Base.encode64(content)
    parent = Path.dirname(path)

    script = """
    set -eu
    mkdir -p #{shell_escape(parent)}
    printf %s #{shell_escape(encoded)} | base64 -d > #{shell_escape(path)}
    """

    case SSH.run(host, script, stderr_to_stdout: true) do
      {:ok, {_output, 0}} -> :ok
      {:ok, {output, status}} -> {:error, {:write_failed, path, status, IO.iodata_to_binary(output)}}
      {:error, reason} -> {:error, {:write_failed, path, reason}}
    end
  end

  @impl true
  def read_file(%Lease{backend: __MODULE__, host: host}, path, _opts \\ []) when is_binary(path) do
    script = "base64 < #{shell_escape(path)}"

    case SSH.run(host, script, stderr_to_stdout: false) do
      {:ok, {output, 0}} ->
        case Base.decode64(output |> IO.iodata_to_binary() |> String.replace(~r/\s+/, "")) do
          {:ok, decoded} -> {:ok, decoded}
          :error -> {:error, {:read_failed, path, :base64_decode}}
        end

      {:ok, {output, status}} ->
        {:error, {:read_failed, path, status, IO.iodata_to_binary(output)}}

      {:error, reason} ->
        {:error, {:read_failed, path, reason}}
    end
  end

  @impl true
  def release(%Lease{backend: __MODULE__}, _opts \\ []), do: :ok

  @impl true
  def touch(%Lease{backend: __MODULE__}, _opts \\ []), do: :ok

  defp build_remote_command(command, cwd, env) do
    env_prefix =
      env
      |> Enum.map(fn {key, value} -> "export #{key}=#{shell_escape(value)}" end)
      |> case do
        [] -> ""
        exports -> Enum.join(exports, " && ") <> " && "
      end

    cwd_prefix =
      case cwd do
        path when is_binary(path) and path != "" -> "cd #{shell_escape(path)} && "
        _ -> ""
      end

    cwd_prefix <> env_prefix <> command
  end

  defp shell_escape(value) when is_binary(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end

  defp issue_identifier(%{identifier: identifier}) when is_binary(identifier), do: identifier
  defp issue_identifier(identifier) when is_binary(identifier), do: identifier
  defp issue_identifier(_), do: nil
end
