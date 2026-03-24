defmodule SymphonyElixir.Codex.StderrBufferTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Codex.StderrBuffer

  test "generate_path returns a unique temp file path" do
    path1 = StderrBuffer.generate_path()
    path2 = StderrBuffer.generate_path()

    assert is_binary(path1)
    assert String.contains?(path1, "symphony_stderr_")
    assert path1 != path2
  end

  test "read returns {:ok, nil} for nil path" do
    assert {:ok, nil} = StderrBuffer.read(nil)
  end

  test "read returns {:ok, nil} for non-existent file" do
    assert {:ok, nil} = StderrBuffer.read("/tmp/nonexistent_stderr_file_#{System.unique_integer([:positive])}")
  end

  test "read returns file content for small files" do
    path = StderrBuffer.generate_path()

    on_exit(fn -> File.rm(path) end)

    content = "some stderr output\nline two\n"
    File.write!(path, content)

    assert {:ok, ^content} = StderrBuffer.read(path)
  end

  test "read truncates to last 10KB for large files" do
    path = StderrBuffer.generate_path()

    on_exit(fn -> File.rm(path) end)

    max_bytes = StderrBuffer.max_bytes()
    # Write more than 10KB
    large_content = String.duplicate("x", max_bytes + 5_000)
    File.write!(path, large_content)

    {:ok, result} = StderrBuffer.read(path)
    assert byte_size(result) == max_bytes
    # Should be the LAST max_bytes of the content
    expected = binary_part(large_content, byte_size(large_content) - max_bytes, max_bytes)
    assert result == expected
  end

  test "read returns {:ok, nil} for empty file" do
    path = StderrBuffer.generate_path()

    on_exit(fn -> File.rm(path) end)

    File.write!(path, "")

    assert {:ok, nil} = StderrBuffer.read(path)
  end

  test "read_and_cleanup returns content and deletes file" do
    path = StderrBuffer.generate_path()

    content = "stderr data to cleanup\n"
    File.write!(path, content)

    assert {:ok, ^content} = StderrBuffer.read_and_cleanup(path)
    refute File.exists?(path)
  end

  test "read_and_cleanup returns {:ok, nil} for nil path" do
    assert {:ok, nil} = StderrBuffer.read_and_cleanup(nil)
  end
end
