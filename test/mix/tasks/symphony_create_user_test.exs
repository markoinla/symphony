defmodule Mix.Tasks.Symphony.CreateUserTest do
  use SymphonyElixir.TestSupport

  import ExUnit.CaptureIO

  alias Mix.Tasks.Symphony.CreateUser

  setup do
    Mix.Task.reenable("symphony.create_user")
    :ok
  end

  describe "argument validation" do
    test "raises when no arguments provided" do
      assert_raise Mix.Error, ~r/Usage:/, fn ->
        CreateUser.run([])
      end
    end

    test "raises when only email provided" do
      assert_raise Mix.Error, ~r/Usage:/, fn ->
        CreateUser.run(["user@example.com"])
      end
    end

    test "raises when too many positional arguments provided" do
      assert_raise Mix.Error, ~r/Usage:/, fn ->
        CreateUser.run(["user@example.com", "password1", "extra"])
      end
    end

    test "raises with invalid options" do
      assert_raise Mix.Error, ~r/Invalid option/, fn ->
        CreateUser.run(["user@example.com", "password1", "--bad", "opt"])
      end
    end

    test "raises when password is too short" do
      assert_raise Mix.Error, ~r/at least 8 characters/, fn ->
        CreateUser.run(["user@example.com", "short"])
      end
    end
  end

  describe "user creation" do
    test "creates user and assigns to default organization" do
      output =
        capture_io(fn ->
          CreateUser.run(["newuser@example.com", "securepassword"])
        end)

      assert output =~ "Created user newuser@example.com"
      assert output =~ "organization Default"

      user = SymphonyElixir.Accounts.get_user_by_email("newuser@example.com")
      assert user != nil
      assert user.email == "newuser@example.com"
    end

    test "creates user with optional name" do
      output =
        capture_io(fn ->
          CreateUser.run(["named@example.com", "securepassword", "--name", "Test User"])
        end)

      assert output =~ "Created user named@example.com"

      user = SymphonyElixir.Accounts.get_user_by_email("named@example.com")
      assert user.name == "Test User"
    end

    test "reuses existing default organization" do
      {:ok, org} = SymphonyElixir.Accounts.create_default_organization()

      output =
        capture_io(fn ->
          CreateUser.run(["reuse@example.com", "securepassword"])
        end)

      assert output =~ org.name
    end

    test "raises on duplicate email" do
      capture_io(fn ->
        CreateUser.run(["dup@example.com", "securepassword"])
      end)

      Mix.Task.reenable("symphony.create_user")

      assert_raise Mix.Error, ~r/Failed to create user/, fn ->
        capture_io(fn ->
          CreateUser.run(["dup@example.com", "anotherpassword"])
        end)
      end
    end

    test "prints help with --help flag" do
      output =
        capture_io(fn ->
          CreateUser.run(["--help"])
        end)

      assert output =~ "Creates a new user"
      assert output =~ "mix symphony.create_user"
    end
  end
end
