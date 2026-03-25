defmodule SymphonyElixir.AccountsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Accounts
  alias SymphonyElixir.Store

  describe "authenticate_by_email_and_password/2" do
    test "returns {:ok, user} with valid credentials" do
      {:ok, user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      assert {:ok, authed} = Accounts.authenticate_by_email_and_password("test@example.com", "securepassword")
      assert authed.id == user.id
    end

    test "returns {:error, :invalid_credentials} with wrong password" do
      {:ok, _user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      assert {:error, :invalid_credentials} = Accounts.authenticate_by_email_and_password("test@example.com", "wrong")
    end

    test "returns {:error, :invalid_credentials} with non-existent email" do
      assert {:error, :invalid_credentials} = Accounts.authenticate_by_email_and_password("nobody@example.com", "pass")
    end
  end

  describe "get_user!/1" do
    test "returns user when found" do
      {:ok, user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      assert Accounts.get_user!(user.id).email == "test@example.com"
    end

    test "raises when user not found" do
      assert_raise Ecto.NoResultsError, fn ->
        Accounts.get_user!(Ecto.UUID.generate())
      end
    end
  end

  describe "get_user/1" do
    test "returns {:ok, user} when found" do
      {:ok, user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      assert {:ok, found} = Accounts.get_user(user.id)
      assert found.id == user.id
    end

    test "returns {:error, :not_found} when not found" do
      assert {:error, :not_found} = Accounts.get_user(Ecto.UUID.generate())
    end
  end

  describe "get_user_by_email/1" do
    test "returns user when found" do
      {:ok, _user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      assert %{email: "test@example.com"} = Accounts.get_user_by_email("test@example.com")
    end

    test "returns nil when not found" do
      assert is_nil(Accounts.get_user_by_email("nobody@example.com"))
    end
  end

  describe "any_user_exists?/0" do
    test "returns false when no users" do
      refute Accounts.any_user_exists?()
    end

    test "returns true when users exist" do
      {:ok, _user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      assert Accounts.any_user_exists?()
    end
  end

  describe "create_user_with_password/1" do
    test "creates user with hashed password" do
      assert {:ok, user} = Accounts.create_user_with_password(%{email: "new@example.com", password: "securepassword"})
      assert user.email == "new@example.com"
      assert user.hashed_password != "securepassword"
      assert Bcrypt.verify_pass("securepassword", user.hashed_password)
    end

    test "fails with duplicate email" do
      {:ok, _} = Accounts.create_user_with_password(%{email: "dup@example.com", password: "securepassword"})
      assert {:error, changeset} = Accounts.create_user_with_password(%{email: "dup@example.com", password: "other"})
      assert {"has already been taken", _} = changeset.errors[:email]
    end
  end

  describe "organization helpers" do
    test "create_default_organization/0 creates a default org" do
      assert {:ok, org} = Accounts.create_default_organization()
      assert org.name == "Default"
      assert org.slug == "default"
    end

    test "get_default_organization/0 returns the default org" do
      {:ok, org} = Accounts.create_default_organization()
      assert Accounts.get_default_organization().id == org.id
    end

    test "add_user_to_organization/3 links user to org" do
      {:ok, user} = Store.create_user(%{email: "test@example.com", password: "securepassword"})
      {:ok, org} = Accounts.create_default_organization()
      assert {:ok, uo} = Accounts.add_user_to_organization(user.id, org.id, "owner")
      assert uo.role == "owner"
    end
  end
end
