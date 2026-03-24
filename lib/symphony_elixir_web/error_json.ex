defmodule SymphonyElixirWeb.ErrorJSON do
  @moduledoc false

  @spec render(String.t(), map()) :: map()
  def render(template, assigns) do
    request_id = get_in(assigns, [:conn, Access.key(:assigns, %{}), :request_id])

    %{error: %{code: "request_failed", message: Phoenix.Controller.status_message_from_template(template), request_id: request_id}}
  end
end
