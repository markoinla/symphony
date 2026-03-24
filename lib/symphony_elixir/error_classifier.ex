defmodule SymphonyElixir.ErrorClassifier do
  @moduledoc """
  Classifies session failure reasons into one of four categories.

  Pure, stateless module with no side effects or DB interaction.
  """

  @type category :: :infra | :agent | :config | :timeout

  # --- timeout ---

  @spec classify(term()) :: category()
  def classify(:turn_timeout), do: :timeout
  def classify(:response_timeout), do: :timeout
  def classify({:workspace_hook_timeout, _hook_name, _timeout_ms}), do: :timeout
  def classify("stalled" <> _rest), do: :timeout

  # --- agent ---

  def classify({:turn_failed, _params}), do: :agent
  def classify({:turn_cancelled, _params}), do: :agent
  def classify({:approval_required, _payload}), do: :agent
  def classify({:turn_input_required, _payload}), do: :agent

  # --- config ---

  def classify({:invalid_workspace_cwd, _reason}), do: :config
  def classify({:invalid_workspace_cwd, _reason, _a}), do: :config
  def classify({:invalid_workspace_cwd, _reason, _a, _b}), do: :config
  def classify({:invalid_workflow_config, _message}), do: :config
  def classify({:unsafe_turn_sandbox_policy, _details}), do: :config
  def classify({:workspace_equals_root, _path, _root}), do: :config
  def classify({:workspace_symlink_escape, _expanded, _root}), do: :config
  def classify({:workspace_outside_root, _path, _root}), do: :config
  def classify({:workspace_path_unreadable, _path, _reason}), do: :config
  def classify({:path_canonicalize_failed, _path, _reason}), do: :config

  # --- infra (explicit known patterns) ---

  def classify({:port_exit, _status}), do: :infra
  def classify(:bash_not_found), do: :infra
  def classify({:workspace_prepare_failed, _host, _status, _output}), do: :infra
  def classify({:workspace_prepare_failed, _reason, _output}), do: :infra
  def classify({:workspace_remove_failed, _host, _status, _output}), do: :infra
  def classify(:no_worker_hosts_available), do: :infra
  def classify({:workspace_hook_failed, _hook, _status, _output}), do: :infra
  def classify({:response_error, _error}), do: :infra
  def classify({:invalid_thread_payload, _payload}), do: :infra
  def classify({:issue_state_refresh_failed, _reason}), do: :infra

  # --- infra (catch-all for unknown errors) ---

  def classify(_unknown), do: :infra
end
