defmodule SymphonyElixir.Store.OrganizationTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Store
  alias SymphonyElixir.Store.Organization

  @valid_attrs %{name: "Acme Corp", slug: "acme-corp"}

  describe "Organization.changeset/2" do
    test "valid with required fields" do
      changeset = Organization.changeset(%Organization{}, @valid_attrs)
      assert changeset.valid?
    end

    test "invalid without name" do
      changeset = Organization.changeset(%Organization{}, %{slug: "acme"})
      refute changeset.valid?
      assert %{name: ["can't be blank"]} = errors_on(changeset)
    end

    test "invalid without slug" do
      changeset = Organization.changeset(%Organization{}, %{name: "Acme"})
      refute changeset.valid?
      assert %{slug: ["can't be blank"]} = errors_on(changeset)
    end

    test "slug must be lowercase alphanumeric with hyphens" do
      changeset = Organization.changeset(%Organization{}, %{name: "Acme", slug: "INVALID SLUG!"})
      refute changeset.valid?
      assert %{slug: ["must be lowercase alphanumeric with hyphens"]} = errors_on(changeset)
    end

    test "slug minimum length" do
      changeset = Organization.changeset(%Organization{}, %{name: "A", slug: "a"})
      refute changeset.valid?
      assert %{slug: ["should be at least 2 character(s)"]} = errors_on(changeset)
    end
  end

  describe "Store.create_organization/1" do
    test "creates organization with valid attrs" do
      assert {:ok, org} = Store.create_organization(@valid_attrs)
      assert org.name == "Acme Corp"
      assert org.slug == "acme-corp"
      assert org.id
    end

    test "rejects duplicate slug" do
      assert {:ok, _} = Store.create_organization(@valid_attrs)
      assert {:error, changeset} = Store.create_organization(%{name: "Other", slug: "acme-corp"})
      assert %{slug: ["has already been taken"]} = errors_on(changeset)
    end
  end

  describe "Store.get_organization/1" do
    test "returns organization by id" do
      {:ok, org} = Store.create_organization(@valid_attrs)
      assert Store.get_organization(org.id).slug == "acme-corp"
    end

    test "returns nil for missing id" do
      assert Store.get_organization(Ecto.UUID.generate()) == nil
    end
  end

  describe "Store.get_organization_by_slug/1" do
    test "returns organization by slug" do
      {:ok, _} = Store.create_organization(@valid_attrs)
      assert Store.get_organization_by_slug("acme-corp").name == "Acme Corp"
    end

    test "returns nil for unknown slug" do
      assert Store.get_organization_by_slug("nonexistent") == nil
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
