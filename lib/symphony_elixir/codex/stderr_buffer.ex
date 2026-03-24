defmodule SymphonyElixir.Codex.StderrBuffer do
  @moduledoc """
  Manages stderr capture for Codex subprocess sessions.

  Stderr is redirected to a temporary file during subprocess execution.
  On finalization, the last `@max_bytes` (10 KB) are read from the file,
  acting as a ring buffer that retains only the tail of stderr output.
  """

  @max_bytes 10_240

  @spec max_bytes() :: pos_integer()
  def max_bytes, do: @max_bytes

  @spec generate_path() :: Path.t()
  def generate_path do
    unique = System.unique_integer([:positive, :monotonic])
    Path.join(System.tmp_dir!(), "symphony_stderr_#{unique}")
  end

  @spec read(Path.t() | nil) :: {:ok, String.t()} | {:ok, nil}
  def read(nil), do: {:ok, nil}

  def read(path) when is_binary(path) do
    case File.stat(path) do
      {:ok, %{size: size}} when size > 0 ->
        offset = max(size - @max_bytes, 0)
        bytes_to_read = min(size, @max_bytes)

        case File.open(path, [:read, :binary]) do
          {:ok, device} ->
            try do
              if offset > 0, do: :file.position(device, offset)
              content = IO.binread(device, bytes_to_read)

              if is_binary(content) do
                {:ok, content}
              else
                {:ok, nil}
              end
            after
              File.close(device)
            end

          {:error, _reason} ->
            {:ok, nil}
        end

      _ ->
        {:ok, nil}
    end
  end

  @spec read_and_cleanup(Path.t() | nil) :: {:ok, String.t()} | {:ok, nil}
  def read_and_cleanup(nil), do: {:ok, nil}

  def read_and_cleanup(path) when is_binary(path) do
    result = read(path)
    File.rm(path)
    result
  end
end
