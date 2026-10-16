defmodule Shop.MixProject do
  use Mix.Project

  def project do
    [
      app: :shop,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: [{:north_talk, path: "../.."}]
    ]
  end

  def application, do: [mod: {Shop.Application, []}, extra_applications: [:logger]]
end
