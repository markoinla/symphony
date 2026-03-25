defmodule SymphonyElixir.Store.UserOrganizationTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Store
  alias SymphonyElixir.Store.UserOrganization

  setup do
    {:ok, user} = Store.create_user(%{email: "member@example.com", password: "secret123"})
    {:ok, org} = Store.create_organization(%{name: "Test Org", slug: "test-org"})
    %{user: user, org: org}
  end

  describe "UserOrganization.changeset/2" do
    test "valid with required fields", %{user: user, org: org} do
      changeset =
        UserOrganization.changeset(%UserOrganization{}, %{
          user_id: user.id,
          organization_id: org.id
        })

      assert changeset.valid?
    end

    test "invalid without user_id", %{org: org} do
      changeset = UserOrganization.changeset(%UserOrganization{}, %{organization_id: org.id})
      refute changeset.valid?
      assert %{user_id: ["can't be blank"]} = errors_on(changeset)
    end

    test "invalid without organization_id", %{user: user} do
      changeset = UserOrganization.changeset(%UserOrganization{}, %{user_id: user.id})
      refute changeset.valid?
      assert %{organization_id: ["can't be blank"]} = errors_on(changeset)
    end

    test "rejects invalid role", %{user: user, org: org} do
      changeset =
        UserOrganization.changeset(%UserOrganization{}, %{
          user_id: user.id,
          organization_id: org.id,
          role: "superadmin"
        })

      refute changeset.valid?
      assert %{role: ["is invalid"]} = errors_on(changeset)
    end

    test "accepts valid roles", %{user: user, org: org} do
      for role <- ~w(owner admin member) do
        changeset =
          UserOrganization.changeset(%UserOrganization{}, %{
            user_id: user.id,
            organization_id: org.id,
            role: role
          })

        assert changeset.valid?, "expected role #{role} to be valid"
      end
    end
  end

  describe "Store.add_user_to_organization/3" do
    test "adds user to org with default role", %{user: user, org: org} do
      assert {:ok, membership} = Store.add_user_to_organization(user.id, org.id)
      assert membership.role == "member"
      assert membership.user_id == user.id
      assert membership.organization_id == org.id
    end

    test "adds user to org with custom role", %{user: user, org: org} do
      assert {:ok, membership} = Store.add_user_to_organization(user.id, org.id, "admin")
      assert membership.role == "admin"
    end

    test "rejects duplicate membership", %{user: user, org: org} do
      assert {:ok, _} = Store.add_user_to_organization(user.id, org.id)
      assert {:error, _changeset} = Store.add_user_to_organization(user.id, org.id)
    end
  end

  describe "Store.get_user_organizations/1" do
    test "returns organizations for a user", %{user: user, org: org} do
      {:ok, _} = Store.add_user_to_organization(user.id, org.id)
      orgs = Store.get_user_organizations(user.id)
      assert length(orgs) == 1
      assert hd(orgs).slug == "test-org"
    end

    test "returns empty list for user with no memberships", %{user: user} do
      assert Store.get_user_organizations(user.id) == []
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
