defmodule Shop.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      Shop.Warehouse,
      {NorthTalk, name: Shop.Talk},
      # Loads before start_link returns, and again whenever the owner
      # restarts; it leaves no process behind.
      %{id: :load, start: {Shop, :start_load, []}}
    ]

    Supervisor.start_link(children, strategy: :rest_for_one, name: Shop.Supervisor)
  end
end
