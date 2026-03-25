defmodule SymphonyElixir.Accounts do
  @moduledoc """
  Context module for user authentication and account management.

  Wraps Store CRUD operations with authentication-specific logic
  (password verification, existence checks, multi-step registration).
  """

  import Ecto.Query

  alias SymphonyElixir.Repo
  alias SymphonyElixir.Store
  alias SymphonyElixir.Store.{Organization, User, UserOrganization}

  # ── Authentication ──────────────────────────────────────────────────

  @spec authenticate_by_email_and_password(String.t(), String.t()) ::
          {:ok, User.t()} | {:error, :invalid_credentials}
  def authenticate_by_email_and_password(email, password)
      when is_binary(email) and is_binary(password) do
    user = Store.get_user_by_email(email)

    if user && Bcrypt.verify_pass(password, user.hashed_password) do
      {:ok, user}
    else
      # Constant-time comparison even when user doesn't exist
      Bcrypt.no_user_verify()
      {:error, :invalid_credentials}
    end
  end

  # ── User lookups ────────────────────────────────────────────────────

  @spec get_user!(Ecto.UUID.t()) :: User.t()
  def get_user!(id) do
    Repo.get!(User, id)
  end

  @spec get_user(Ecto.UUID.t()) :: {:ok, User.t()} | {:error, :not_found}
  def get_user(id) do
    case Store.get_user(id) do
      nil -> {:error, :not_found}
      user -> {:ok, user}
    end
  end

  @spec get_user_by_email(String.t()) :: User.t() | nil
  def get_user_by_email(email) when is_binary(email) do
    Store.get_user_by_email(email)
  end

  # ── Existence check ─────────────────────────────────────────────────

  @spec any_user_exists?() :: boolean()
  def any_user_exists? do
    Repo.exists?(from(u in User))
  end

  # ── User + Org creation (setup flow) ────────────────────────────────

  @spec create_user_with_password(map()) :: {:ok, User.t()} | {:error, Ecto.Changeset.t()}
  def create_user_with_password(attrs) do
    Store.create_user(attrs)
  end

  @spec create_default_organization() :: {:ok, Organization.t()} | {:error, Ecto.Changeset.t()}
  def create_default_organization do
    Store.create_organization(%{name: "Default", slug: "default"})
  end

  @spec get_default_organization() :: Organization.t() | nil
  def get_default_organization do
    Store.get_organization_by_slug("default")
  end

  @spec add_user_to_organization(Ecto.UUID.t(), Ecto.UUID.t(), String.t()) ::
          {:ok, UserOrganization.t()} | {:error, Ecto.Changeset.t()}
  def add_user_to_organization(user_id, organization_id, role \\ "member") do
    Store.add_user_to_organization(user_id, organization_id, role)
  end
end
