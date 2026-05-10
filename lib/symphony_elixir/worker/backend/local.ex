defmodule SymphonyElixir.Worker.Backend.Local do
  @moduledoc """
  Local worker backend.

  Acquires leases that point at the OTP node's own filesystem and runs
  commands via `System.cmd/3`. This is the historical "no SSH worker
  hosts configured" behaviour.
  """

  @behaviour SymphonyElixir.Worker.Backend

  alias SymphonyElixir.Worker.Lease

  @host "local"

  @impl true
  def acquire(issue, opts \\ []) do
    identifier = issue_identifier(issue) || Keyword.get(opts, :identifier) || "issue"

    lease = %Lease{
      id: "local:" <> identifier,
      backend: __MODULE__,
      host: @host,
      meta: %{identifier: identifier}
    }

    {:ok, lease}
  end

  @impl true
  def resolve(lease_id, _opts \\ []) when is_binary(lease_id) do
    identifier =
      case String.split(lease_id, ":", parts: 2) do
        ["local", ident] -> ident
        _ -> "issue"
      end

    {:ok,
     %Lease{
       id: lease_id,
       backend: __MODULE__,
       host: @host,
       meta: %{identifier: identifier}
     }}
  end

  @impl true
  def exec(%Lease{backend: __MODULE__}, command, opts \\ []) when is_binary(command) do
    cwd = Keyword.get(opts, :cwd)
    env = Keyword.get(opts, :env, [])
    stderr_to_stdout = Keyword.get(opts, :stderr_to_stdout, true)

    cmd_opts =
      [env: env, stderr_to_stdout: stderr_to_stdout]
      |> maybe_put_cwd(cwd)

    {output, status} = System.cmd("sh", ["-lc", command], cmd_opts)
    binary_output = IO.iodata_to_binary(output)

    {:ok,
     %{
       exit: status,
       stdout: binary_output,
       stderr: if(stderr_to_stdout, do: "", else: "")
     }}
  rescue
    e in [ErlangError, ArgumentError, File.Error] ->
      {:error, {:exec_failed, Exception.message(e)}}
  end

  @impl true
  def write_file(%Lease{backend: __MODULE__}, path, content, _opts \\ [])
      when is_binary(path) and is_binary(content) do
    with :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(path, content) do
      :ok
    else
      {:error, reason} -> {:error, {:write_failed, path, reason}}
    end
  end

  @impl true
  def read_file(%Lease{backend: __MODULE__}, path, _opts \\ []) when is_binary(path) do
    case File.read(path) do
      {:ok, content} -> {:ok, content}
      {:error, reason} -> {:error, {:read_failed, path, reason}}
    end
  end

  @impl true
  def release(%Lease{backend: __MODULE__}, _opts \\ []), do: :ok

  @impl true
  def touch(%Lease{backend: __MODULE__}, _opts \\ []), do: :ok

  defp maybe_put_cwd(opts, nil), do: opts
  defp maybe_put_cwd(opts, cwd) when is_binary(cwd), do: Keyword.put(opts, :cd, cwd)

  defp issue_identifier(%{identifier: identifier}) when is_binary(identifier), do: identifier
  defp issue_identifier(identifier) when is_binary(identifier), do: identifier
  defp issue_identifier(_), do: nil
end
