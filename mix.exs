defmodule SymphonyElixir.MixProject do
  use Mix.Project

  def project do
    [
      app: :symphony_elixir,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      test_coverage: [
        summary: [
          threshold: 100
        ],
        ignore_modules: [
          SymphonyElixir.Config,
          SymphonyElixir.Linear.Client,
          SymphonyElixir.SpecsCheck,
          SymphonyElixir.Orchestrator,
          SymphonyElixir.Orchestrator.State,
          SymphonyElixir.AgentRunner,
          SymphonyElixir.CLI,
          SymphonyElixir.Codex.AppServer,
          SymphonyElixir.Codex.DynamicTool,
          SymphonyElixir.Claude.AppServer,
          SymphonyElixir.Claude.CommandBuilder,
          SymphonyElixir.Claude.EventTranslator,
          SymphonyElixir.Engine,
          SymphonyElixir.MCP.Server,
          SymphonyElixir.MCP.LinearTools,
          SymphonyElixir.MCP.ConfigWriter,
          SymphonyElixir.HttpServer,
          SymphonyElixir.StatusDashboard,
          SymphonyElixir.LogFile,
          SymphonyElixir.SessionLog,
          SymphonyElixir.Settings,
          SymphonyElixir.Workflow,
          SymphonyElixir.WorkflowStore,
          SymphonyElixir.Application,
          SymphonyElixir.CommentWatch,
          SymphonyElixir.Tracker,
          SymphonyElixir.Tracker.Memory,
          SymphonyElixir.Workspace,
          SymphonyElixir.OrchestratorStarter,
          SymphonyElixir.Repo,
          SymphonyElixir.Store,
          SymphonyElixir.Store.Migrator,
          SymphonyElixir.Store.Project,
          SymphonyElixir.Store.Setting,
          SymphonyElixir.Store.Session,
          SymphonyElixir.Store.Message,
          SymphonyElixir.Linear.Adapter,
          SymphonyElixir.Linear.Comment,
          SymphonyElixirWeb.ObservabilityPubSub,
          SymphonyElixirWeb.Endpoint,
          SymphonyElixirWeb.ErrorHTML,
          SymphonyElixirWeb.ErrorJSON,
          SymphonyElixirWeb.ObservabilityApiController,
          SymphonyElixirWeb.ProjectApiController,
          SymphonyElixirWeb.Presenter,
          SymphonyElixirWeb.Router,
          SymphonyElixirWeb.SettingsApiController,
          SymphonyElixirWeb.SpaController,
          SymphonyElixirWeb.StreamController,
          SymphonyElixirWeb.Router.Helpers
        ]
      ],
      test_ignore_filters: [
        "test/support/snapshot_support.exs",
        "test/support/test_support.exs"
      ],
      dialyzer: [
        plt_add_apps: [:mix]
      ],
      escript: escript(),
      aliases: aliases(),
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      mod: {SymphonyElixir.Application, []},
      extra_applications: [:logger, :inets, :ssl]
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:bandit, "~> 1.8"},
      {:floki, ">= 0.30.0", only: :test},
      {:lazy_html, ">= 0.1.0", only: :test},
      {:phoenix, "~> 1.8.0"},
      {:req, "~> 0.5"},
      {:jason, "~> 1.4"},
      {:yaml_elixir, "~> 2.12"},
      {:solid, "~> 1.2"},
      {:ecto, "~> 3.13"},
      {:ecto_sqlite3, "~> 0.18"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev], runtime: false}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "cmd --cd dashboard npm install"],
      "assets.build": [
        "cmd --cd dashboard npm install",
        "cmd --cd dashboard npm run build",
        "cmd rm -rf priv/static/dashboard",
        "cmd mkdir -p priv/static/dashboard",
        "cmd cp -R dashboard/dist/. priv/static/dashboard"
      ],
      build: ["assets.build", "escript.build"],
      lint: ["specs.check", "credo --strict"]
    ]
  end

  defp escript do
    [
      app: nil,
      main_module: SymphonyElixir.CLI,
      name: "symphony",
      path: "bin/symphony"
    ]
  end
end
