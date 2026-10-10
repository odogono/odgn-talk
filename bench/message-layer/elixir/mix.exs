defmodule TalkHost.MixProject do
  use Mix.Project

  def project do
    [
      app: :talk_host,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: [{:wasmex, "== 0.15.1"}]
    ]
  end

  def application, do: [extra_applications: [:logger, :crypto]]
end
