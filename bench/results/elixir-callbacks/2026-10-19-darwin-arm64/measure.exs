# From impl/elixir, with the freshly built reactor:
# MIX_ENV=test mix run ../../bench/results/elixir-callbacks/2026-10-19-darwin-arm64/measure.exs
# Writes JSON lines to stdout. Both modes use the same guest and Host code.
defmodule CallbackMeasurement do
  alias NorthTalk.{Capability, Result, Transport}

  defmodule Properties do
    @behaviour Transport
    defstruct [:wasm]
    @impl true
    def start(opts) do
      Process.put(:property_fixture, true)
      {:ok, wasm} = Transport.Wasi.start(opts)
      {:ok, %__MODULE__{wasm: wasm}}
    end

    @impl true
    def exchange(t, bytes) do
      {:ok, reply} = Transport.exchange(t.wasm, bytes)
      # Only inspect setup frames; the measured path delegates directly.
      if Process.get(:property_fixture) do
        frame = Jason.decode!(bytes)
        if frame["m"] == "new-group" do
          raw(t, %{"m" => "define-object-kind", "ref" => 1_000_000, "name" => "box", "props" => [%{"name" => "value", "shape" => "any"}]})
          raw(t, %{"m" => "object", "ref" => 1_000_001, "group" => "g", "kind" => "box", "id" => "one"})
          Process.delete(:property_fixture)
        end
      end
      {:ok, reply}
    end

    defp raw(t, frame) do
      {:ok, reply} = Transport.exchange(t.wasm, Jason.encode!(frame))
      %{"ok" => _} = Jason.decode!(reply)
    end
    @impl true
    def memory_bytes(t), do: Transport.memory_bytes(t.wasm)
    @impl true
    def stop(t), do: Transport.stop(t.wasm)
  end

  @source """
  on calls n
    repeat for each i in 1..n
      ask api to echo i
    end repeat
    return n
  end calls

  on properties o, n
    put 0 into count
    repeat for each i in 1..n
      try
        put the value of o into v
      catch e
        put count + 1 into count
      end try
    end repeat
    return count
  end properties
  """

  def run do
    for round <- 1..8, workload <- ~w(calls properties), binary? <- if(rem(round, 2) == 1, do: [false, true], else: [true, false]) do
      transport = if workload == "properties", do: Properties, else: Transport.Wasi
      {:ok, owner} = NorthTalk.start_link(binary_callbacks: binary?, transport: transport)
      api = Capability.from_functions("api", %{"echo" => {[args: ["number"], result: "number", cost: 1], fn [n], _ -> {:ok, n} end}})
      NorthTalk.define_capability!(owner, api)
      grant = NorthTalk.grant!(owner, "api")
      group = NorthTalk.new_group!(owner, "g", [])
      NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
      args = if workload == "calls", do: [100], else: [%NorthTalk.Object{kind: "box", id: "one", group: "g"}, 100]
      request = fn -> {:ok, %Result{value: 100}} = NorthTalk.request(group, "s", workload, args) end
      for _ <- 1..10, do: request.()
      samples = for _ <- 1..40 do
        start = System.monotonic_time(:nanosecond)
        request.()
        (System.monotonic_time(:nanosecond) - start) / 100
      end
      IO.puts(Jason.encode!(%{round: round, workload: workload, binary: binary?, ns_per_crossing: samples}))
      NorthTalk.close(owner)
    end
  end
end
CallbackMeasurement.run()
