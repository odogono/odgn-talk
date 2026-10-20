defmodule NorthTalk.CallbackFieldsTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Binary, Result, ScriptError, Transport}

  defmodule Reactor do
    @behaviour Transport
    defstruct [:wasm, :observer, :hide]

    @impl true
    def start(opts) do
      {:ok, wasm} = Transport.Wasi.start([])
      {:ok, %__MODULE__{wasm: wasm, observer: opts[:observer], hide: opts[:hide] || []}}
    end

    @impl true
    def exchange(t, bytes) do
      frame = decode(bytes)
      {:ok, reply} = Transport.exchange(t.wasm, bytes)
      decoded = decode(reply)
      send(t.observer, {:wire, frame, Binary.binary?(bytes), decoded, Binary.binary?(reply)})

      cond do
        frame["m"] == "hello" ->
          reply = Jason.decode!(reply)
          {:ok, Jason.encode!(update_in(reply, ["ok", "features"], &(&1 -- t.hide)))}

        frame["m"] == "new-group" ->
          # Property registration is not a public Elixir API yet. Set up a real
          # guest Object to exercise the owner's existing safe refusal path.
          raw(t, %{
            "m" => "define-object-kind",
            "ref" => 1_000_000,
            "name" => "box",
            "props" => [%{"name" => "value", "shape" => "any"}]
          })

          raw(t, %{"m" => "object", "ref" => 1_000_001, "group" => frame["group"], "kind" => "box", "id" => "one"})
          {:ok, reply}

        true ->
          {:ok, reply}
      end
    end

    defp raw(t, frame) do
      {:ok, reply} = Transport.exchange(t.wasm, Jason.encode!(frame))
      %{"ok" => _} = Jason.decode!(reply)
    end

    defp decode(bytes), do: NorthTalk.TestWire.decode(bytes)

    @impl true
    def memory_bytes(t), do: Transport.memory_bytes(t.wasm)
    @impl true
    def stop(t), do: Transport.stop(t.wasm)
  end

  defmodule Api do
    use NorthTalk.Capability, name: "api"
    operation("echo", args: ["any"], result: "any", cost: 1, segment_bound: true)
    def echo([value], _), do: {:ok, value}
    def effect(_, _), do: :ok
    def release(_), do: :ok
  end

  for binary? <- [false, true] do
    @binary binary?
    test "op, effect and release continue a JSON exchange with binary=#{binary?}" do
      owner = start_supervised!({NorthTalk, transport: Reactor, observer: self(), binary_callbacks: @binary})
      NorthTalk.define_capability!(owner, Api)
      grant = NorthTalk.grant!(owner, "api")
      group = NorthTalk.new_group!(owner, "g", [])
      NorthTalk.load!(group, "s", "on go v\n ask api to echo v\n return it\nend go", grants: %{"api" => grant})
      assert {:ok, %Result{value: nil}} = NorthTalk.request(group, "s", "go", [nil])
      assert :ok = NorthTalk.stop(group, "s")
      assert {:ok, _} = NorthTalk.pump(group)
      events = drain_replies()

      for m <- ~w(op effect release) do
        assert need_on_wire?(m, @binary, events)

        assert Enum.any?(events, fn {frame, sent?, _, _} ->
                 frame["m"] == m <> "-result" and sent? == @binary and
                   Enum.any?(events, fn {_, _, reply, _} ->
                     reply["need"] && reply["need"]["m"] == m && reply["ref"] == frame["ref"]
                   end)
               end)
      end
    end

    test "property getter and Nothing setter are safely refused with binary=#{binary?}" do
      owner = start_supervised!({NorthTalk, transport: Reactor, observer: self(), binary_callbacks: @binary})
      group = NorthTalk.new_group!(owner, "g", [])
      source = "on read o\n return the value of o\nend read\non write o\n set the value of o to nothing\nend write"
      NorthTalk.load!(group, "s", source, [])
      object = %NorthTalk.Object{kind: "box", id: "one", group: "g"}

      for message <- ~w(read write) do
        assert {:error, %ScriptError{error: %{"code" => "host error"}}} =
                 NorthTalk.request(group, "s", message, [object])

        events = drain_replies()
        assert need_on_wire?("prop", @binary, events)
        assert Enum.any?(events, fn {frame, sent?, _, _} -> frame["m"] == "prop-result" and sent? == @binary end)
      end
    end
  end

  for hidden <- ["request-pump-fields-v1", "callbacks-fields-v1"] do
    @hidden hidden
    test "negotiates the other envelope independently when #{@hidden} is absent" do
      owner =
        start_supervised!({NorthTalk, transport: Reactor, observer: self(), hide: [@hidden], binary_callbacks: true})

      NorthTalk.define_capability!(owner, Api)
      grant = NorthTalk.grant!(owner, "api")
      group = NorthTalk.new_group!(owner, "g", [])
      NorthTalk.load!(group, "s", "on go\n ask api to echo 7\n return it\nend go", grants: %{"api" => grant})
      assert {:ok, %Result{value: 7}} = NorthTalk.request(group, "s", "go", [])
      events = drain_replies()
      assert need_on_wire?("op", @hidden != "callbacks-fields-v1", events)
      requested = for {frame, _, _, _} <- events, frame["m"] == "hello", frame["features"], do: frame["features"]
      assert [features] = requested
      refute @hidden in features
      assert length(features -- ["paused-inputs-v1"]) == 1
    end
  end

  # Keep all wire events so assertions can inspect each callback kind.
  defp drain_replies do
    receive do
      {:wire, frame, sent?, reply, received?} -> [{frame, sent?, reply, received?} | drain_replies()]
    after
      0 -> []
    end
  end

  defp need_on_wire?(m, binary?, events) do
    Enum.any?(events, fn
      {_, _, reply, ^binary?} -> reply["need"] && reply["need"]["m"] == m
      _ -> false
    end)
  end
end
