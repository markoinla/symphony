defmodule SymphonyElixir do
  @moduledoc """
  Entry point for the Symphony orchestrator.
  """

  @doc """
  Start the orchestrator in the current BEAM node.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    workflow_name = Keyword.get(opts, :workflow_name, SymphonyElixir.Workflow.default_workflow_name())
    SymphonyElixir.Orchestrator.start_link(Keyword.put(opts, :workflow_name, workflow_name))
  end

  @doc """
  Resolves the public base URL for this Symphony instance.

  Resolution order: `symphony_public_base_url` DB setting →
  `SYMPHONY_PUBLIC_BASE_URL` env var → auto-detected local IP.
  """
  @spec resolve_public_base_url() :: String.t() | nil
  def resolve_public_base_url do
    with nil <- non_blank_setting("symphony_public_base_url"),
         nil <- non_blank_env("SYMPHONY_PUBLIC_BASE_URL"),
         nil <- detect_ip_url() do
      nil
    else
      url -> String.trim_trailing(url, "/")
    end
  end

  defp non_blank_setting(key) do
    case SymphonyElixir.Store.get_setting(key) do
      val when is_binary(val) and val != "" -> val
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp non_blank_env(key) do
    case System.get_env(key) do
      val when is_binary(val) and val != "" -> val
      _ -> nil
    end
  end

  defp detect_ip_url do
    port = SymphonyElixir.Config.server_port()

    case detect_public_ip() do
      {:ok, ip} ->
        "http://#{ip}:#{port}"

      :error ->
        with {:ok, ifaddrs} <- :inet.getifaddrs(),
             [{a, b, c, d} | _] <- extract_non_private_addrs(ifaddrs) do
          "http://#{a}.#{b}.#{c}.#{d}:#{port}"
        else
          _ -> nil
        end
    end
  end

  defp detect_public_ip do
    case Req.get("https://ifconfig.me", headers: [{"accept", "text/plain"}], receive_timeout: 5_000) do
      {:ok, %{status: 200, body: body}} when is_binary(body) ->
        ip = String.trim(body)
        if ip != "", do: {:ok, ip}, else: :error

      _ ->
        :error
    end
  rescue
    _ -> :error
  end

  defp extract_non_private_addrs(ifaddrs) do
    Enum.flat_map(ifaddrs, fn {_iface, opts} ->
      for {:addr, addr} <- opts,
          tuple_size(addr) == 4,
          not private_ip?(addr),
          do: addr
    end)
  end

  defp private_ip?({127, _, _, _}), do: true
  defp private_ip?({10, _, _, _}), do: true
  defp private_ip?({172, b, _, _}) when b >= 16 and b <= 31, do: true
  defp private_ip?({192, 168, _, _}), do: true
  defp private_ip?({169, 254, _, _}), do: true
  defp private_ip?(_), do: false
end

defmodule SymphonyElixir.Application do
  @moduledoc """
  OTP application entrypoint that starts core supervisors and workers.
  """

  use Application

  require Logger

  @impl true
  def start(_type, _args) do
    :ok = SymphonyElixir.LogFile.configure()
    run_migrations()

    children =
      [
        {Phoenix.PubSub, name: SymphonyElixir.PubSub},
        {Registry, keys: :unique, name: SymphonyElixir.SessionLogRegistry},
        {Registry, keys: :unique, name: SymphonyElixir.OrchestratorRegistry},
        {Registry, keys: :unique, name: SymphonyElixir.AgentSessionRegistry},
        SymphonyElixir.Repo,
        {Task.Supervisor, name: SymphonyElixir.TaskSupervisor},
        SymphonyElixir.WorkflowStore,
        {DynamicSupervisor, name: SymphonyElixir.OrchestratorSupervisor, strategy: :one_for_one}
      ] ++ runtime_children()

    Supervisor.start_link(
      children,
      strategy: :one_for_one,
      name: SymphonyElixir.Supervisor
    )
  end

  @impl true
  def stop(_state) do
    SymphonyElixir.StatusDashboard.render_offline_status()
    :ok
  end

  defp runtime_children do
    if sandbox_pool?() do
      []
    else
      [
        SymphonyElixir.HttpServer,
        SymphonyElixir.OrchestratorStarter,
        SymphonyElixir.StatusDashboard,
        {Task, &register_with_proxy/0}
      ]
    end
  end

  defp register_with_proxy do
    alias SymphonyElixir.{ProxyClient, Store}

    with true <- ProxyClient.proxy_enabled?(),
         instance_url when is_binary(instance_url) and instance_url != "" <-
           SymphonyElixir.resolve_public_base_url(),
         org_id when is_binary(org_id) and org_id != "" <-
           Store.get_setting("proxy.linear_org_id") do
      case ProxyClient.register_instance(instance_url, org_id) do
        :ok -> Logger.info("Registered with proxy on startup: #{instance_url}")
        {:error, reason} -> Logger.warning("Proxy registration on startup failed: #{inspect(reason)}")
      end
    else
      _ -> Logger.debug("Skipping proxy registration (disabled, no base URL, or no org ID)")
    end
  end

  defp run_migrations do
    unless sandbox_pool?() do
      {:ok, _, _} =
        Ecto.Migrator.with_repo(SymphonyElixir.Repo, &Ecto.Migrator.run(&1, :up, all: true))
    end
  end

  defp sandbox_pool? do
    repo_config = Application.get_env(:symphony_elixir, SymphonyElixir.Repo, [])
    repo_config[:pool] == Ecto.Adapters.SQL.Sandbox
  end
end
