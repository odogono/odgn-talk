defmodule NorthTalk.OwnerProtocolTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{HostError, ScriptError, Transport}

  # A real reactor with observable frames and injected faults.
  defmodule Reactor do
    @behaviour Transport
    defstruct [:wasm, :observer, :scenario]

    @impl true
    def start(opts) do
      {:ok, wasm} = Transport.Wasi.start(Keyword.drop(opts, [:observer, :scenario]))
      observer = opts[:observer]
      send(observer, {:backend, wasm.pid})

      {:ok, %__MODULE__{wasm: wasm, observer: observer, scenario: opts[:scenario]}}
    end

    @impl true
    def exchange(t, bytes) do
      frame = Jason.decode!(bytes)
      send(t.observer, {:frame, frame["m"], frame["ref"]})

      case {t.scenario, frame["m"]} do
        {:trap, "pump"} ->
          {:error, :injected_trap}

        {:refuse_need, "op-result"} ->
          {:refused, :injected_refusal}

        _ ->
          reply = raw(t.wasm, frame)
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

  @source "on go\n  ask api to ping\nend go\n"

  defp setup_group(scenario, opts \\ []) do
    {:ok, owner} = NorthTalk.start_link([transport: Reactor, observer: self(), scenario: scenario] ++ opts)
    ping = fn [], _ -> :not_a_result end

    :ok =
      NorthTalk.define_capability!(owner, NorthTalk.Capability.from_functions("api", %{"ping" => {[cost: 1], ping}}))

    grant = NorthTalk.grant!(owner, "api")
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
    {owner, group}
  end

  test "an interim Operation need is answered under its Pump ref before the next exchange" do
    {_owner, group} = setup_group(:needs)
    assert {:error, %ScriptError{error: %{"code" => "host error"}}} = NorthTalk.request(group, "s", "go")
    assert_receive {:frame, "pump", ref}
    assert_receive {:reply, "pump", :need}
    assert_receive {:frame, "op-result", ^ref}
    assert_receive {:reply, "op-result", :final}
  end

  for {scenario, reason} <- [trap: :injected_trap, bad_ref: :invalid_reply, refuse_need: :interim_answer_refused] do
    test "#{scenario} loses the instance and fails the waiting request" do
      Process.flag(:trap_exit, true)
      {owner, group} = setup_group(unquote(scenario))
      assert_receive {:backend, backend}
      assert {:error, %HostError{code: "instance lost"}} = NorthTalk.request(group, "s", "go")
      assert_receive {:EXIT, ^owner, {:shutdown, {:instance_lost, reason}}}
      assert reason == unquote(reason) or elem(reason, 0) == unquote(reason)
      ref = Process.monitor(backend)
      assert_receive {:DOWN, ^ref, :process, ^backend, _}
    end
  end

  test "killing the owner closes its backend" do
    {owner, _group} = setup_group(:needs)
    assert_receive {:backend, backend}
    ref = Process.monitor(backend)
    Process.unlink(owner)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^ref, :process, ^backend, _}
  end
end
