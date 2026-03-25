defmodule SymphonyElixir.Store.UserTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Store
  alias SymphonyElixir.Store.User

  @valid_attrs %{email: "test@example.com", password: "supersecret123"}

  describe "User.changeset/2" do
    test "valid with required fields" do
      changeset = User.changeset(%User{}, %{email: "a@b.com", hashed_password: "hash"})
      assert changeset.valid?
    end

    test "invalid without email" do
      changeset = User.changeset(%User{}, %{hashed_password: "hash"})
      refute changeset.valid?
      assert %{email: ["can't be blank"]} = errors_on(changeset)
    end

    test "invalid without hashed_password" do
      changeset = User.changeset(%User{}, %{email: "a@b.com"})
      refute changeset.valid?
      assert %{hashed_password: ["can't be blank"]} = errors_on(changeset)
    end

    test "invalid email format" do
      changeset = User.changeset(%User{}, %{email: "nope", hashed_password: "hash"})
      refute changeset.valid?
      assert %{email: ["must have the @ sign and no spaces"]} = errors_on(changeset)
    end

    test "email too long" do
      long_email = String.duplicate("a", 150) <> "@example.com"
      changeset = User.changeset(%User{}, %{email: long_email, hashed_password: "hash"})
      refute changeset.valid?
      assert %{email: ["should be at most 160 character(s)"]} = errors_on(changeset)
    end
  end

  describe "User.registration_changeset/2" do
    test "hashes password when password is provided" do
      changeset = User.registration_changeset(%User{}, %{email: "a@b.com", password: "secret123"})
      assert changeset.valid?
      assert Bcrypt.verify_pass("secret123", Ecto.Changeset.get_change(changeset, :hashed_password))
    end

    test "requires hashed_password when no password provided" do
      changeset = User.registration_changeset(%User{}, %{email: "a@b.com"})
      refute changeset.valid?
      assert %{hashed_password: ["can't be blank"]} = errors_on(changeset)
    end
  end

  describe "Store.create_user/1" do
    test "creates user with valid password" do
      assert {:ok, user} = Store.create_user(@valid_attrs)
      assert user.email == "test@example.com"
      assert user.id
      assert Bcrypt.verify_pass("supersecret123", user.hashed_password)
    end

    test "rejects duplicate email" do
      assert {:ok, _} = Store.create_user(@valid_attrs)
      assert {:error, changeset} = Store.create_user(@valid_attrs)
      assert %{email: ["has already been taken"]} = errors_on(changeset)
    end
  end

  describe "Store.get_user/1" do
    test "returns user by id" do
      {:ok, user} = Store.create_user(@valid_attrs)
      assert Store.get_user(user.id).email == "test@example.com"
    end

    test "returns nil for missing id" do
      assert Store.get_user(Ecto.UUID.generate()) == nil
    end
  end

  describe "Store.get_user_by_email/1" do
    test "returns user by email" do
      {:ok, _} = Store.create_user(@valid_attrs)
      assert Store.get_user_by_email("test@example.com").email == "test@example.com"
    end

    test "returns nil for unknown email" do
      assert Store.get_user_by_email("nobody@example.com") == nil
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
