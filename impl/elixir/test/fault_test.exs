defmodule NorthTalk.FaultTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Artifact, HostError, Result, ScriptError, Transport}

  # The real reactor, with a short export timeout once it has started.
  defmodule Short do
    def start(opts) do
      with {:ok, t} <- Transport.Wasi.start(opts), do: {:ok, %{t | timeout: opts[:call_timeout]}}
    end
  end

  # The real reactor, with a trap injected into one message, or a changed
  # `hello` reply.
  defmodule Faulty do
    @behaviour Transport
    defstruct [:wasm, :trap_on, :hello]

    @impl true
    def start(opts) do
      {:ok, wasm} = Transport.Wasi.start([])
      {:ok, %__MODULE__{wasm: wasm, trap_on: opts[:trap_on], hello: opts[:hello] || %{}}}
    end

    @impl true
    def exchange(t, bytes) do
      case Jason.decode!(bytes)["m"] do
        m when m == t.trap_on ->
          {:error, {:trap, "wasm trap: wasm `unreachable` instruction executed"}}

        "hello" ->
          {:ok, reply} = Transport.exchange(t.wasm, bytes)
          {:ok, reply |> Jason.decode!() |> update_in(["ok"], &Map.merge(&1, t.hello)) |> Jason.encode!()}

        _ ->
          Transport.exchange(t.wasm, bytes)
      end
    end

    @impl true
    def memory_bytes(t), do: Transport.memory_bytes(t.wasm)
    @impl true
    def stop(t), do: Transport.stop(t.wasm)
  end

  @source """
  script variable n = 0

  on count
    put n + 1 into n
    return n
  end count

  on forever
    repeat while true
    end repeat
  end forever

  on spin k
    put 0 into total
    repeat for each i in 1..k
      put total + i into total
    end repeat
    return total
  end spin

  on big k
    put "x" into t
    repeat for each i in 1..k
      put t & t into t
    end repeat
    return 1
  end big
  """

  defp group(owner) do
    group = NorthTalk.new_group!(owner, "g", [])
    "s" = NorthTalk.load!(group, "s", @source, [])
    group
  end

  defp timing_out do
    {:ok, owner} =
      NorthTalk.start_link(
        transport: Short,
        call_timeout: 200,
        fuel_slice: 100_000_000,
        limits: [fuel_per_run: 100_000_000]
      )

    {owner, group(owner)}
  end

  test "a timeout poisons the instance and fails every waiting request" do
    Process.flag(:trap_exit, true)
    {owner, group} = timing_out()
    waiting = Task.async(fn -> NorthTalk.request(group, "s", "forever") end)

    assert {:error, %HostError{code: "instance trapped", detail: ":timeout"}} = Task.await(waiting)
    assert_receive {:EXIT, ^owner, {:shutdown, :trapped}}
  end

  test "a trap stops the owner with :trapped and nothing is retried" do
    Process.flag(:trap_exit, true)
    {:ok, owner} = NorthTalk.start_link(transport: Faulty, trap_on: "pump")
    group = group(owner)

    assert {:error, %HostError{code: "instance trapped", detail: detail}} = NorthTalk.request(group, "s", "count")
    assert detail =~ "unreachable"
    assert_receive {:EXIT, ^owner, {:shutdown, :trapped}}
  end

  test "other instances carry on when one traps" do
    Process.flag(:trap_exit, true)
    others = for _ <- 1..3, do: start_supervised!({NorthTalk, []}, id: make_ref()) |> group()
    {owner, trapping} = timing_out()

    waiting = Task.async(fn -> NorthTalk.request(trapping, "s", "forever") end)
    counts = Enum.map(others, fn g -> Task.async(fn -> NorthTalk.request(g, "s", "count") end) end)

    for task <- counts, do: assert({:ok, %Result{value: 1}} = Task.await(task))
    assert {:error, %HostError{code: "instance trapped"}} = Task.await(waiting)
    assert_receive {:EXIT, ^owner, {:shutdown, :trapped}}
    for g <- others, do: assert({:ok, %Result{value: 2}} = NorthTalk.request(g, "s", "count"))
  end

  test "a caller recovers by restoring a save it kept into a new owner" do
    Process.flag(:trap_exit, true)
    {owner, group} = timing_out()
    {:ok, %Result{value: 1}} = NorthTalk.request(group, "s", "count")
    {:ok, saved} = NorthTalk.save(group)

    Task.async(fn -> NorthTalk.request(group, "s", "forever") end) |> Task.await()
    assert_receive {:EXIT, ^owner, {:shutdown, :trapped}}

    fresh = start_supervised!({NorthTalk, []})
    {:ok, %{group: restored}} = NorthTalk.restore(fresh, "g", saved, [])
    assert {:ok, %Result{value: 2}} = NorthTalk.request(restored, "s", "count")
  end

  test "linear memory is capped and reported apart from host memory" do
    owner = start_supervised!({NorthTalk, memory_cap: 16_000_000, limits: [fuel_per_run: 100_000_000]})
    group = group(owner)

    assert {:error, %HostError{code: "out of memory"}} = NorthTalk.request(group, "s", "big", [24])
    assert %{linear: linear, host: host} = NorthTalk.memory(owner)
    assert linear > 0 and linear <= 16_000_000
    assert host > 0
  end

  test "the owner's limits apply to each load, which may override them" do
    owner = start_supervised!({NorthTalk, limits: [fuel_per_run: 200]})
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "tight", @source, [])
    NorthTalk.load!(group, "loose", @source, limits: [fuel_per_run: 1_000_000])

    assert {:error, %ScriptError{outcome: "limit fault"}} = NorthTalk.request(group, "tight", "spin", [1000])
    assert {:ok, %Result{value: 500_500}} = NorthTalk.request(group, "loose", "spin", [1000])
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.load(group, "bad", @source, limits: [fuel: 1])
  end

  test "a reactor with another save format or without a required feature is refused" do
    Process.flag(:trap_exit, true)
    hello = %{"saveFormat" => "zig/1"}

    assert {:error, %HostError{code: "incompatible core", detail: detail}} =
             NorthTalk.start_link(transport: Faulty, hello: hello)

    assert detail =~ "zig/1"
    assert Artifact.save_format() == "zig/16"
  end

  test "the compiled module is cached once per digest, whatever its path" do
    path = Path.join(System.tmp_dir!(), "north_talk_#{System.unique_integer([:positive])}.wasm")
    File.cp!(Artifact.path(), path)
    on_exit(fn -> File.rm(path) end)

    {_, digest} = Artifact.read!(Artifact.path())
    {:ok, a} = Transport.Wasi.start()
    {:ok, b} = Transport.Wasi.start(path: path)
    assert :persistent_term.get({Transport.Wasi, digest, :speed}) != nil
    Transport.stop(a)
    Transport.stop(b)
  end
end
