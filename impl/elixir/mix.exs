defmodule NorthTalk.MixProject do
  use Mix.Project

  def project do
    [
      app: :north_talk,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      # Fetches the pinned reactor into priv/ (NorthTalk.Artifact).
      compilers: Mix.compilers() ++ [:north_talk_reactor],
      deps: [{:wasmex, "~> 0.15.1"}, {:jason, "~> 1.4"}, {:decimal, "~> 3.2"}]
    ]
  end

  def application, do: [extra_applications: [:logger, :crypto]]
end
