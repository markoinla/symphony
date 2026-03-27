defmodule SymphonyElixir.ProcessReaper do
  @moduledoc """
  Reaps orphaned `claude -p` OS processes left behind by a previous BEAM instance.

  When the BEAM shuts down (or crashes), Erlang ports close but the spawned
  `bash -c "... | claude -p ..."` pipeline can survive if the child processes
  detach from the port's process group. On restart, the DB sessions are correctly
  marked as "cancelled" by `finalize_stale_db_sessions/1`, but the actual OS
  processes remain orphaned — consuming resources indefinitely.

  This module scans for `claude -p` processes whose `--mcp-config` points to a
  symphony workspace and kills any that aren't tracked by a current session.
  """

  require Logger

  @doc """
  Scans for orphaned agent processes and kills them.

  Returns the number of orphaned process trees that were reaped.
  """
  @spec reap_orphaned_agents() :: non_neg_integer()
  def reap_orphaned_agents do
    orphans = find_orphaned_process_trees()

    if orphans == [] do
      Logger.debug("ProcessReaper: no orphaned agent processes found")
      0
    else
      Logger.warning("ProcessReaper: found #{length(orphans)} orphaned agent tree(s)")

      Enum.each(orphans, fn {identifier, pids} ->
        kill_process_tree(identifier, pids)
      end)

      length(orphans)
    end
  end

  # Finds orphaned agent process trees. A process tree is orphaned when its
  # bash wrapper has been reparented to PID 1 (init), meaning the BEAM that
  # spawned it has exited.
  #
  # Returns a list of `{identifier, [pid, ...]}` tuples where pids includes
  # the bash wrapper and all its descendants.
  defp find_orphaned_process_trees do
    case System.cmd("pgrep", ["-f", "claude -p.*symphony_workspaces"], stderr_to_stdout: true) do
      {output, 0} ->
        output
        |> String.split("\n", trim: true)
        |> Enum.map(&String.trim/1)
        |> Enum.filter(&(&1 != ""))
        |> Enum.map(&String.to_integer/1)
        |> Enum.flat_map(&resolve_orphan/1)
        |> Enum.uniq_by(fn {_identifier, pids} -> Enum.sort(pids) end)

      # pgrep returns exit code 1 when no processes match
      {_output, 1} ->
        []

      {output, code} ->
        Logger.warning("ProcessReaper: pgrep failed (exit #{code}): #{String.trim(output)}")
        []
    end
  end

  # Given a PID that matched `claude -p.*symphony_workspaces`, check if it's
  # orphaned (bash wrapper reparented to PID 1) and return its process tree.
  defp resolve_orphan(pid) do
    with {:ok, cmdline} <- read_cmdline(pid),
         {:ok, identifier} <- extract_identifier(cmdline) do
      wrapper_pid = read_ppid(pid)
      root_pid = if wrapper_pid && bash_wrapper?(wrapper_pid), do: wrapper_pid, else: pid

      # An orphaned process tree has its root reparented to PID 1 (init).
      # If the root is still a child of a BEAM process, it's actively managed.
      root_ppid = read_ppid(root_pid)

      if root_ppid == 1 do
        descendants = get_descendants(root_pid)
        [{identifier, [root_pid | descendants]}]
      else
        []
      end
    else
      _ -> []
    end
  end

  defp read_cmdline(pid) do
    case File.read("/proc/#{pid}/cmdline") do
      {:ok, data} -> {:ok, String.replace(data, <<0>>, " ")}
      {:error, _} -> :error
    end
  end

  defp extract_identifier(cmdline) do
    case Regex.run(~r|symphony_workspaces/([A-Z]+-\d+)|, cmdline) do
      [_, identifier] -> {:ok, identifier}
      _ -> :error
    end
  end

  defp read_ppid(pid) do
    case File.read("/proc/#{pid}/stat") do
      {:ok, stat} ->
        # Format: pid (comm) state ppid ...
        # comm can contain spaces/parens, so find the last ) then parse
        case Regex.run(~r/\)\s+\S+\s+(\d+)/, stat) do
          [_, ppid_str] -> String.to_integer(ppid_str)
          _ -> nil
        end

      {:error, _} ->
        nil
    end
  end

  defp bash_wrapper?(pid) do
    case read_cmdline(pid) do
      {:ok, cmdline} -> String.contains?(cmdline, "symphony_workspaces") and String.starts_with?(cmdline, "bash")
      :error -> false
    end
  end

  # Get all descendant PIDs of a process using /proc.
  defp get_descendants(root_pid) do
    case System.cmd("pgrep", ["-P", to_string(root_pid)], stderr_to_stdout: true) do
      {output, 0} ->
        children =
          output
          |> String.split("\n", trim: true)
          |> Enum.map(&String.trim/1)
          |> Enum.filter(&(&1 != ""))
          |> Enum.map(&String.to_integer/1)

        children ++ Enum.flat_map(children, &get_descendants/1)

      _ ->
        []
    end
  end

  defp kill_process_tree(identifier, pids) do
    # Kill deepest children first (reverse order), then the root
    sorted_pids = Enum.reverse(pids)
    pid_strs = Enum.map(sorted_pids, &to_string/1)

    Logger.warning(
      "ProcessReaper: killing orphaned agent tree for #{identifier} " <>
        "(#{length(pids)} process(es): #{Enum.join(pid_strs, ", ")})"
    )

    Enum.each(sorted_pids, fn pid ->
      # SIGTERM first for graceful shutdown
      System.cmd("kill", [to_string(pid)], stderr_to_stdout: true)
    end)
  end
end
