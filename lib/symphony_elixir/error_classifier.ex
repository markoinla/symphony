defmodule SymphonyElixir.ErrorClassifier do
  @moduledoc """
  Classifies session failure reasons into one of four categories.

  Pure, stateless module with no side effects or DB interaction.
  """

  @type category :: :infra | :agent | :config | :timeout | :shutdown

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

  # --- exception tuples from :DOWN messages ---
  # AgentRunner wraps errors in RuntimeError before exiting, so the :DOWN reason
  # is {%RuntimeError{message: "...inspect(original_reason)..."}, stacktrace}.
  # Extract the message and classify by keyword matching on the inspected reason.

  def classify({%{__exception__: true, message: message}, _stacktrace}) when is_binary(message) do
    classify_message(message)
  end

  # --- infra (catch-all for unknown errors) ---

  def classify(_unknown), do: :infra

  @timeout_keywords ~w(turn_timeout response_timeout workspace_hook_timeout)
  @agent_keywords ~w(turn_failed turn_cancelled approval_required turn_input_required)
  @config_keywords ~w(invalid_workspace_cwd invalid_workflow_config unsafe_turn_sandbox_policy
                       workspace_equals_root workspace_symlink_escape workspace_outside_root
                       workspace_path_unreadable path_canonicalize_failed)

  defp classify_message(message) do
    cond do
      String.contains?(message, "stalled for") -> :timeout
      keyword_match?(message, @timeout_keywords) -> :timeout
      keyword_match?(message, @agent_keywords) -> :agent
      keyword_match?(message, @config_keywords) -> :config
      true -> :infra
    end
  end

  defp keyword_match?(message, keywords) do
    Enum.any?(keywords, &String.contains?(message, &1))
  end
end
