defmodule NorthTalk.OwnerProtocolTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{HostError, Transport}

  # A real reactor with observable frames and injected transport faults. Seed
  # a Capability only to exercise interim needs before callback registration
  # is exposed by a later application API slice.
  defmodule Reactor do
    @behaviour Transport
    defstruct [:wasm, :observer, :scenario, :grant, :hello_patch]

    @impl true
    def start(opts) do
      {:ok, wasm} = Transport.Wasi.start(Keyword.drop(opts, [:observer, :scenario, :hello_patch]))
      send(opts[:observer], {:backend, wasm.pid})

      grant =
        if opts[:scenario] in [:needs, :refuse_need] do
          raw(wasm, %{
            "m" => "define-capability",
            "ref" => 100,
            "name" => "api",
            "ops" => [%{"name" => "ping", "mode" => "immediate", "args" => [], "cost" => %{"fuel" => 1}}]
          })

          raw(wasm, %{"m" => "grant", "ref" => 101, "capability" => "api", "ops" => "all"})["ok"]["grant"]
        end

      {:ok,
       %__MODULE__{
         wasm: wasm,
         observer: opts[:observer],
         scenario: opts[:scenario],
         grant: grant,
         hello_patch: Keyword.get(opts, :hello_patch, %{})
       }}
    end

    @impl true
    def exchange(t, bytes) do
      frame = Jason.decode!(bytes)
      send(t.observer, {:frame, frame["m"], frame["ref"]})

      pump_number =
        if frame["m"] == "pump" do
          previous = Process.get({__MODULE__, :pumps}, 0)
          Process.put({__MODULE__, :pumps}, previous + 1)
          previous + 1
        end

      cond do
        t.scenario == :trap and frame["m"] == "pump" ->
          {:error, :injected_trap}

        t.scenario == :trap_after_slice and pump_number == 2 ->
          {:error, :injected_trap}

        t.scenario == :refuse_need and frame["m"] == "op-result" ->
          {:refused, :injected_refusal}

        true ->
          frame = if frame["m"] == "load" and t.grant, do: Map.put(frame, "grants", %{"api" => t.grant}), else: frame
          reply = raw(t.wasm, frame)
          reply = if frame["m"] == "hello", do: update_in(reply["ok"], &Map.merge(&1, t.hello_patch)), else: reply
          reply = if t.scenario == :bad_ref and frame["m"] == "pump", do: Map.put(reply, "ref", -1), else: reply
          send(t.observer, {:reply, frame["m"], if(reply["need"], do: :need, else: :final)})
          {:ok, Jason.encode!(reply)}
      end
    end

    defp raw(wasm, frame) do
      {:ok, reply} = Transport.exchange(wasm, Jason.encode!(frame))
      Jason.decode!(reply)
    end

    @impl true
    def memory_bytes(t), do: Transport.memory_bytes(t.wasm)
    @impl true
    def stop(t), do: Transport.stop(t.wasm)
  end

  defp owner(opts) do
    start_supervised!({NorthTalk, [transport: Reactor, observer: self()] ++ opts}, id: make_ref())
  end

  test "hello rejects incompatible contracts and missing required features" do
    for patch <- [
          %{"core" => "go/0.0.0"},
          %{"language" => "2"},
          %{"costModel" => "99"},
          %{"unicode" => "1"},
          %{"saveFormat" => "zig/999"},
          %{"features" => [1]}
        ] do
      assert {:error, %HostError{code: "incompatible core"}} =
               GenServer.start(NorthTalk.Owner, transport: Reactor, observer: self(), hello_patch: patch)

      assert_receive {:backend, backend}
      refute Process.alive?(backend)
    end

    assert {:error, %HostError{code: "incompatible core"}} =
             GenServer.start(NorthTalk.Owner, transport: Reactor, observer: self(), required_features: ["absent-v1"])

    owner = owner(required_features: ["paused-inputs-v1"])
    assert {:ok, _} = NorthTalk.info(owner)
  end

  test "a real interim Operation completes under its Pump ref before another exchange" do
    owner = owner(scenario: :needs, drive: :manual)
    one = NorthTalk.new_group!(owner)
    two = NorthTalk.new_group!(owner)

    for group <- [one, two] do
      NorthTalk.load_script!(group, "s", "on go\nask api to ping\nend go")
    end

    first = NorthTalk.request_async!(one, "s", "go")
    second = NorthTalk.request_async!(two, "s", "go")
    now = ~U[2026-10-15 12:00:00Z]
    NorthTalk.pump!(one, now)
    NorthTalk.pump!(two, now)
    assert {:error, %HostError{code: "host error", call: call, delivery: id, reports: reports}} = NorthTalk.await(first)
    assert id == first.id
    assert is_binary(call)
    assert Enum.any?(reports, &(&1["kind"] == "call failed" and &1["call"] == call))
    assert {:error, %HostError{call: ^call}} = NorthTalk.await(second)
    assert_receive {:frame, "pump", ref}
    assert_receive {:reply, "pump", :need}
    assert_receive {:frame, "op-result", ^ref}
    assert_receive {:reply, "op-result", :final}
    assert_receive {:frame, "pump", next}
    assert next > ref
    assert_receive {:reply, "pump", :need}
    assert_receive {:frame, "op-result", ^next}
  end

  test "a transport fault or mismatched ref closes the reactor and fails pending work without retry" do
    for scenario <- [:trap, :bad_ref] do
      owner = owner(scenario: scenario, drive: :manual)
      assert_receive {:backend, backend}
      group = NorthTalk.new_group!(owner)
      NorthTalk.load_script!(group, "s", "on ping\nreturn 1\nend ping")
      receipt = NorthTalk.request_async!(group, "s", "ping")
      assert {:error, %HostError{code: "instance lost"}} = NorthTalk.pump(group, ~U[2026-10-15 12:00:00Z])
      assert {:error, %HostError{code: "instance lost", delivery: id}} = NorthTalk.await(receipt)
      assert id == receipt.id
      refute Process.alive?(backend)
      assert_receive {:frame, "pump", _}
      assert_receive {:frame, "request", _}
      assert {:error, %HostError{code: "instance lost"}} = NorthTalk.request(group, "s", "ping")
      refute_receive {:frame, "request", _}, 10
    end
  end

  test "an untrappable owner exit closes its unlinked reactor" do
    {:ok, owner} = GenServer.start(NorthTalk.Owner, transport: Reactor, observer: self())
    assert_receive {:backend, backend}
    monitor = Process.monitor(backend)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^backend, _}
  end

  test "a fault preserves prior execution reports for an await arriving after instance loss" do
    owner = owner(scenario: :trap_after_slice, drive: :manual, fuel_slice: 20)
    group = NorthTalk.new_group!(owner)
    NorthTalk.load_script!(group, "s", "on spin\nrepeat forever\nend repeat\nend spin")
    receipt = NorthTalk.request_async!(group, "s", "spin")
    now = ~U[2026-10-15 12:00:00Z]
    assert %{"state" => "sliced", "reports" => reports} = NorthTalk.pump!(group, now)
    assert reports != []
    assert {:error, %HostError{code: "instance lost"}} = NorthTalk.pump(group, now)
    assert {:error, %HostError{delivery: id, reports: ^reports}} = NorthTalk.await(receipt)
    assert id == receipt.id
  end

  test "refusing an interim answer invalidates the instance rather than leaving its exchange open" do
    owner = owner(scenario: :refuse_need)
    group = NorthTalk.new_group!(owner)
    NorthTalk.load_script!(group, "s", "on go\nask api to ping\nend go")
    assert {:error, %HostError{code: "instance lost", delivery: id}} = NorthTalk.request(group, "s", "go")
    assert is_binary(id)
    assert {:error, %HostError{code: "instance lost"}} = NorthTalk.new_group(owner)
  end
end
