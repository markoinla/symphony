defmodule Mix.Tasks.Symphony.CreateUser do
  use Mix.Task

  @shortdoc "Create a new user account"

  @moduledoc """
  Creates a new user and assigns them to the default organization.

  Usage:

      mix symphony.create_user <email> <password> [--name "Full Name"]

  The password must be at least 8 characters long. If no default organization
  exists, one will be created automatically. The user is assigned the `member`
  role in the default organization.
  """

  @impl Mix.Task
  def run(args) do
    {opts, argv, invalid} =
      OptionParser.parse(args, strict: [name: :string, help: :boolean], aliases: [h: :help])

    cond do
      opts[:help] ->
        Mix.shell().info(@moduledoc)

      invalid != [] ->
        Mix.raise("Invalid option(s): #{inspect(invalid)}")

      length(argv) != 2 ->
        Mix.raise("Usage: mix symphony.create_user <email> <password> [--name \"Full Name\"]")

      true ->
        [email, password] = argv
        create_user(email, password, opts[:name])
    end
  end

  defp create_user(email, password, name) do
    if String.length(password) < 8 do
      Mix.raise("Password must be at least 8 characters long")
    end

    Mix.Task.run("app.start")

    alias SymphonyElixir.Accounts

    attrs = %{email: email, password: password}
    attrs = if name, do: Map.put(attrs, :name, name), else: attrs

    case Accounts.create_user_with_password(attrs) do
      {:ok, user} ->
        org = ensure_default_organization()

        case Accounts.add_user_to_organization(user.id, org.id) do
          {:ok, _} ->
            Mix.shell().info("Created user #{user.email} (#{user.id}) in organization #{org.name}")

          {:error, changeset} ->
            Mix.raise("Failed to add user to organization: #{inspect(changeset.errors)}")
        end

      {:error, changeset} ->
        Mix.raise("Failed to create user: #{inspect(changeset.errors)}")
    end
  end

  defp ensure_default_organization do
    alias SymphonyElixir.Accounts

    case Accounts.get_default_organization() do
      nil ->
        case Accounts.create_default_organization() do
          {:ok, org} -> org
          {:error, changeset} -> Mix.raise("Failed to create default organization: #{inspect(changeset.errors)}")
        end

      org ->
        org
    end
  end
end
