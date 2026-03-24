defmodule SymphonyElixir.ErrorClassifier do
  @moduledoc """
  Classifies session failure reasons into broad error categories.

  Categories:
  - `:infra` — infrastructure failures (port exits, SSH, workspace prep/removal, hooks, unknown)
  - `:agent` — agent-level failures (turn failures, cancellations, approval/input required)
  - `:config` — configuration errors (invalid workspace cwd, workflow config parse failures)
  - `:timeout` — timeout conditions (turn, response, hook timeouts, stall detection)
  """

  @type category :: :infra | :agent | :config | :timeout

  @spec classify(term()) :: category()

  # Timeout patterns
  def classify(:turn_timeout), do: :timeout
  def classify(:response_timeout), do: :timeout
  def classify({:response_timeout}), do: :timeout
  def classify({:workspace_hook_timeout, _hook_name, _timeout_ms}), do: :timeout

  def classify(reason) when is_binary(reason) do
    if String.contains?(reason, "stalled for") do
      :timeout
    else
      :infra
    end
  end

  # Agent patterns
  def classify({:turn_failed, _params}), do: :agent
  def classify({:turn_cancelled, _params}), do: :agent
  def classify({:approval_required, _payload}), do: :agent
  def classify({:turn_input_required, _payload}), do: :agent

  # Config patterns
  def classify({:invalid_workspace_cwd, :symlink_escape, _expanded, _root}), do: :config
  def classify({:invalid_workspace_cwd, :symlink_escape, _expanded}), do: :config
  def classify({:invalid_workspace_cwd, :outside_workspace_root, _canonical, _root}), do: :config
  def classify({:invalid_workspace_cwd, :outside_workspace_root, _canonical}), do: :config
  def classify({:invalid_workspace_cwd, :workspace_root, _canonical}), do: :config
  def classify({:invalid_workspace_cwd, :path_unreadable, _path, _reason}), do: :config
  def classify({:invalid_workspace_cwd, :empty_remote_workspace, _host}), do: :config
  def classify({:invalid_workspace_cwd, :invalid_remote_workspace, _host, _workspace}), do: :config
  def classify({:invalid_workflow_config, _message}), do: :config
  def classify({:missing_workflow_file, _path, _reason}), do: :config

  # Infra patterns
  def classify({:port_exit, _status}), do: :infra
  def classify(:no_worker_hosts_available), do: :infra
  def classify({:workspace_prepare_failed, _host, _status, _output}), do: :infra
  def classify({:workspace_remove_failed, _host, _status, _output}), do: :infra
  def classify({:workspace_hook_failed, _hook_name, _status, _output}), do: :infra
  def classify(:bash_not_found), do: :infra
  def classify({:response_error, _error}), do: :infra

  # Catch-all: anything unmatched is infra
  def classify(_reason), do: :infra
end
