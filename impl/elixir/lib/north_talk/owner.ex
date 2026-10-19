defmodule NorthTalk.Owner do
  @moduledoc false
  # The Instance Owner: the one process that holds a reactor instance and
  # conducts every Message Layer exchange with it, one complete exchange at a
  # time, including the needs answered inside it. Use it through `NorthTalk`.

  use GenServer

  alias NorthTalk.{
    Binary,
    Call,
    Capability,
    Clock,
    Effect,
    Grant,
    Group,
    HostError,
    Library,
    LoadError,
    Release,
    Restored,
    Result,
    ScriptError,
    Transport,
    Value
  }

  @protocol 1
  @default_fuel_slice 10_000

  defstruct [
    :transport,
    :versions,
    :drive,
    :clock,
    :fuel_slice,
    :reports_to,
    :limits,
    :tasks,
    # The tokens of Function Values held by the Host, by handle id.
    :functions,
    # Whether the Session negotiated the binary fields envelope (ADR 0110).
    request_pump: false,
    callbacks: false,
    ref: 0,
    # The last correlation token sent; tokens are never reused.
    token: 0,
    # Pending handles of combined calls, by id: their Group, delivery,
    # retained result and awaiters, each by its timeout ref.
    handles: %{},
    groups: %{},
    waiters: %{},
    # Capabilities by name, and each loaded Script's Grants by
    # {group, script, grant name}.
    capabilities: %{},
    bindings: %{},
    # Suspending calls not yet settled, by {group, call id}: their Task's
    # monitor ref, or their deferred ref, each indexed back to the call.
    calls: %{},
    monitors: %{},
    deferred: %{},
    # While a restore asks for Grants: how the caller rebinds them.
    restoring: nil
  ]

  def start_link(opts) do
    {gen_opts, opts} = Keyword.split(opts, [:name])
    GenServer.start_link(__MODULE__, opts, gen_opts)
  end

  @impl true
  def init(opts) do
    module = Keyword.get(opts, :transport, Transport.Wasi)
    transport_opts = Keyword.drop(opts, [:transport, :drive, :fuel_slice, :reports_to, :limits, :binary_callbacks])

    {:ok, tasks} = Task.Supervisor.start_link()

    with {:ok, limits} <- limits(Keyword.get(opts, :limits, [])),
         {:ok, transport} <- module.start(transport_opts),
         :ok <- stop_with_owner(transport),
         state = %__MODULE__{
           transport: transport,
           tasks: tasks,
           functions: :ets.new(:north_talk_functions, [:protected]),
           drive: Keyword.get(opts, :drive, :auto),
           clock: Clock.start(),
           fuel_slice: Keyword.get(opts, :fuel_slice, @default_fuel_slice),
           reports_to: opts[:reports_to],
           limits: limits
         },
         {{:ok, versions}, state} <- exchange(state, "hello", %{"protocol" => @protocol}),
         :ok <- check_versions(versions),
         {:ok, state} <- negotiate(state, versions, opts) do
      {:ok, %{state | versions: plain(versions)}}
    else
      {{:error, error}, state} ->
        Transport.stop(state.transport)
        Supervisor.stop(tasks)
        {:stop, error}

      {:error, error} ->
        Supervisor.stop(tasks)
        {:stop, error}
    end
  end

  # A Core that offers the fields envelope is asked for it by a second hello,
  # since an older Core refuses a feature it doesn't know.
  defp negotiate(state, versions, opts) do
    offered = versions["features"] || []
    want_callbacks? = Keyword.get(opts, :binary_callbacks, Application.get_env(:north_talk, :binary_callbacks, false))
    pump? = Binary.feature() in offered
    callbacks? = want_callbacks? and Binary.callbacks_feature() in offered
    features = if(pump?, do: [Binary.feature()], else: []) ++ if(callbacks?, do: [Binary.callbacks_feature()], else: [])

    if features == [] do
      {:ok, state}
    else
      case exchange(state, "hello", %{"protocol" => @protocol, "features" => features}) do
        {{:ok, _}, state} ->
          {:ok, %{state | request_pump: pump?, callbacks: callbacks?}}

        other ->
          other
      end
    end
  end

  # The backend is unlinked, and terminate/2 does not run when the owner is
  # killed, so a watcher closes the instance whenever the owner exits.

  # A seed in chapter 9's integer encoding: text from 2^53 up.
  defp seed_field(seed) when is_integer(seed) and seed >= 0 and seed < 9_007_199_254_740_992, do: seed
  defp seed_field(seed) when is_integer(seed) and seed >= 0, do: Integer.to_string(seed)
  defp seed_field(seed), do: seed

  defp stop_with_owner(transport) do
    owner = self()

    spawn(fn ->
      monitor = Process.monitor(owner)

      receive do
        {:DOWN, ^monitor, :process, ^owner, _} -> Transport.stop(transport)
      end
    end)

    :ok
  end

  # This Host reads one save format and needs its features; a reactor
  # without them is refused before any Group is made.
  defp check_versions(versions) do
    features = versions["features"] || []
    missing = NorthTalk.Artifact.required_features() -- features

    cond do
      not is_binary(versions["core"]) ->
        {:error, %HostError{code: "incompatible core", detail: inspect(plain(versions))}}

      versions["saveFormat"] != NorthTalk.Artifact.save_format() ->
        {:error,
         %HostError{
           code: "incompatible core",
           detail: "save format #{inspect(versions["saveFormat"])}, not #{NorthTalk.Artifact.save_format()}"
         }}

      missing != [] ->
        {:error, %HostError{code: "incompatible core", detail: "missing features #{Enum.join(missing, ", ")}"}}

      true ->
        :ok
    end
  end

  @limits %{
    fuel_per_run: "fuelPerRun",
    alloc_per_run: "allocPerRun",
    persistent_state: "persistentState",
    call_depth: "callDepth",
    pattern_size: "patternSize",
    mailbox_depth: "mailboxDepth",
    max_wait_ms: "maxWaitMs",
    max_join: "maxJoin",
    cleanup_budget: "cleanupBudget"
  }

  defp limits(opts) do
    Enum.reduce_while(opts, {:ok, %{}}, fn
      {key, n}, {:ok, acc} when is_map_key(@limits, key) and is_integer(n) and n >= 0 ->
        {:cont, {:ok, Map.put(acc, @limits[key], n)}}

      other, _ ->
        {:halt, {:error, %HostError{code: "invalid value", detail: "#{inspect(other)} is not a limit"}}}
    end)
  end

  @impl true
  def terminate(reason, %__MODULE__{transport: transport} = state) do
    {code, detail} =
      case reason do
        {:shutdown, :trapped} -> {"instance trapped", inspect(Process.get(:north_talk_fault))}
        {:shutdown, {:instance_lost, _}} -> {"instance lost", inspect(reason)}
        _ -> {"instance closed", inspect(reason)}
      end

    fail_waiters(state, %HostError{code: code, detail: detail})
    for {_, {:task, pid, _}} <- state.calls, do: Process.exit(pid, :kill)
    Transport.stop(transport)
  end

  @impl true
  def handle_call(:versions, _from, state), do: {:reply, state.versions, state}

  def handle_call(:memory, _from, state),
    do: {:reply, %{linear: Transport.memory_bytes(state.transport), host: :erlang.memory(:total)}, state}

  def handle_call({:release, %NorthTalk.Function{id: id}}, _from, state) do
    :ets.delete(state.functions, id)
    {:reply, :ok, state}
  end

  def handle_call({:close_group, %Group{name: g}}, _from, state) do
    case Map.pop(state.groups, g) do
      {nil, _} ->
        {:reply, {:error, no_group(g)}, state}

      {group, groups} ->
        if group.timer, do: Process.cancel_timer(group.timer)
        :ets.match_delete(state.functions, {:_, g, :_})
        closed = %HostError{code: "group closed", detail: g}
        state = fail_group_waiters(state, g, closed)
        {mine, handles} = Map.split_with(state.handles, fn {_, h} -> h.group == g end)
        for {_, h} <- mine, {_, from} <- h.awaiters, do: GenServer.reply(from, {:error, closed})
        {:reply, :ok, %{state | groups: groups, handles: handles}}
    end
  end

  def handle_call({:load, %Group{name: g}, _, _, _}, _from, state) when not is_map_key(state.groups, g),
    do: {:reply, {:error, no_group(g)}, state}

  def handle_call({:call, %Group{name: g}, _, _}, _from, state) when not is_map_key(state.groups, g),
    do: {:reply, {:error, no_group(g)}, state}

  def handle_call({m, %Group{name: g}, _}, _from, state)
      when m in [:add_library, :pump] and not is_map_key(state.groups, g),
      do: {:reply, {:error, no_group(g)}, state}

  def handle_call({:send, _, %Group{name: g}, _, _, _}, _from, state) when not is_map_key(state.groups, g),
    do: {:reply, {:error, no_group(g)}, state}

  def handle_call({:pumped, _, %Group{name: g}, _, _}, _from, state) when not is_map_key(state.groups, g),
    do: {:reply, {:error, no_group(g)}, state}

  def handle_call({:new_group, name, opts}, _from, state) do
    fields = %{"group" => name, "name" => name, "trace" => Keyword.get(opts, :trace, false)}
    fields = if seed = opts[:seed], do: Map.put(fields, "seed", seed_field(seed)), else: fields

    case exchange(state, "new-group", fields) do
      {{:ok, _}, state} ->
        state = put_in(state.groups[name], group_entry())
        {:reply, {:ok, %Group{owner: self(), name: name}}, state}

      {error, state} ->
        {:reply, error, state}
    end
  end

  def handle_call({:define_capability, capability}, _from, state) do
    capability = Capability.resolve(capability)

    fields =
      %{"name" => capability.name, "ops" => Capability.declarations(capability)}
      |> then(&if(capability.effect, do: Map.put(&1, "segmentLifecycle", true), else: &1))
      |> then(&if(capability.release, do: Map.put(&1, "release", true), else: &1))

    case exchange(state, "define-capability", fields) do
      {{:ok, _}, state} -> {:reply, :ok, put_in(state.capabilities[capability.name], capability)}
      {error, state} -> {:reply, error, state}
    end
  end

  def handle_call({:grant, name, opts}, _from, state) do
    ops = with list when is_list(list) <- Keyword.get(opts, :ops, :all), do: list
    fields = %{"capability" => name, "ops" => if(ops == :all, do: "all", else: ops)}

    if Map.has_key?(state.capabilities, name) do
      {reply, state} = exchange(state, "grant", fields)
      grant = &%Grant{owner: self(), handle: &1["grant"], capability: name, binding: opts[:binding]}
      {:reply, ok(reply, grant), state}
    else
      {:reply, {:error, %HostError{code: "invalid value", detail: "no Capability #{name}"}}, state}
    end
  end

  def handle_call({:load, %Group{name: g}, name, source, opts}, _from, state) do
    grants = Map.new(Keyword.get(opts, :grants, %{}))

    with :ok <- own_grants(grants),
         {:ok, limits} <- limits(Keyword.get(opts, :limits, [])) do
      fields = %{
        "group" => g,
        "name" => name,
        "source" => source,
        "grants" => Map.new(grants, fn {k, %Grant{handle: h}} -> {k, h} end),
        "limits" => Map.merge(state.limits, limits)
      }

      case exchange(state, "load", fields) do
        {{:ok, ok}, state} ->
          script = ok["script"]
          bindings = Map.new(grants, fn {k, grant} -> {{g, script, k}, grant} end)
          {:reply, {:ok, script}, %{state | bindings: Map.merge(state.bindings, bindings)}}

        {error, state} ->
          {:reply, error, state}
      end
    else
      error -> {:reply, error, state}
    end
  end

  def handle_call({:settle, ref, settlement}, _from, state) do
    case Map.pop(state.deferred, ref) do
      {nil, _} ->
        {:reply, {:error, :unknown_ref}, state}

      {key, deferred} ->
        state = %{state | deferred: deferred, calls: Map.delete(state.calls, key)}
        {:reply, :ok, settle_call(state, key, settlement)}
    end
  end

  def handle_call({:compile_library, name, version, source, opts}, _from, state) do
    fields = %{
      "name" => name,
      "version" => version,
      "source" => source,
      "imports" => Enum.map(Keyword.get(opts, :imports, []), &identity/1),
      "declarations" => %{}
    }

    {reply, state} = exchange(state, "compile-library", fields)

    reply =
      ok(reply, fn ok ->
        %Library{name: name, version: version, identity: ok["identity"]["$bytes"], needs: plain(ok["needs"])}
      end)

    {:reply, reply, state}
  end

  def handle_call({:add_library, %Group{name: g}, %Library{} = library}, _from, state) do
    {reply, state} = exchange(state, "add-library", %{"group" => g, "identity" => identity(library)})
    {:reply, ok(reply, fn _ -> :ok end), state}
  end

  def handle_call({:replace_library, %Group{name: g}, %Library{} = library, opts}, _from, state) do
    fields = %{"group" => g, "identity" => identity(library), "carry" => carry(opts)}
    {reply, state} = work(state, g, exchange(state, "replace-library", fields))
    {:reply, reply, state}
  end

  def handle_call({:reload, %Group{name: g}, script, source, opts}, _from, state) do
    fields = %{
      "group" => g,
      "script" => script,
      "source" => source,
      "carry" => carry(opts),
      "keepMailbox" => Keyword.get(opts, :keep_mailbox, false)
    }

    {reply, state} = work(state, g, exchange(state, "reload", fields))
    {:reply, reply, state}
  end

  def handle_call({:extend, %Group{name: g}, script, source}, _from, state) do
    {reply, state} = exchange(state, "extend", %{"group" => g, "script" => script, "source" => source})
    {:reply, done(reply), state}
  end

  def handle_call({:stop, %Group{name: g}, script, reason}, _from, state) do
    {reply, state} = exchange(state, "stop", %{"group" => g, "script" => script, "reason" => reason})
    {:reply, done(reply), schedule_pump(state, g)}
  end

  def handle_call({:save, %Group{name: g}}, _from, state) do
    {reply, state} = exchange(state, "save", %{"group" => g})
    {:reply, ok(reply, &Base.decode64!(&1["save"]["$bytes"])), state}
  end

  def handle_call({:restore, name, save, opts}, _from, state) do
    fields = %{
      "group" => name,
      "name" => name,
      "save" => %{"$bytes" => Base.encode64(save)},
      "libraries" => Enum.map(Keyword.get(opts, :libraries, []), &identity/1),
      "mismatch" => if(opts[:mismatch] == :variables_only, do: "variables only", else: "reject"),
      "trace" => Keyword.get(opts, :trace, false)
    }

    state = %{state | restoring: Keyword.get(opts, :grants, %{})}
    {reply, state} = exchange(state, "restore", fields)
    state = %{state | restoring: nil}

    case reply do
      {:ok, ok} ->
        pending = Enum.map(ok["pending"], &pending_call(state, name, &1))
        entry = %{group_entry() | unsettled: MapSet.new(pending, & &1.call)}
        state = put_in(state.groups[name], entry)
        state = Enum.reduce(Enum.map(ok["reports"] || [], &report(state, name, &1)), state, &settle(&2, name, &1))

        restored = %Restored{
          group: %Group{owner: self(), name: name},
          variables_only: ok["variablesOnly"],
          pending: pending,
          disposed: plain(ok["disposed"]),
          discarded_runs: plain(ok["discardedRuns"]),
          dropped_messages: plain(ok["droppedMessages"]),
          abandoned_calls: plain(ok["abandonedCalls"])
        }

        {:reply, {:ok, restored}, release_held(state, name)}

      error ->
        # Bindings the resolve recorded belong to no Group.
        {:reply, error, %{state | bindings: Map.reject(state.bindings, &match?({{^name, _, _}, _}, &1))}}
    end
  end

  def handle_call({:settle_restored, %Group{name: g}, call, settlement}, _from, state) do
    {fields, adopt} =
      case settlement do
        {:answer, value} -> {%{"answer" => encode(state, g, value)}, nil}
        {:fail, failure} -> {%{"fail" => failure(failure)}, nil}
        :reissue -> {%{"reissue" => true}, nil}
        {:adopt, ref} -> {%{"adopt" => true}, ref}
      end

    if adopt != nil and Map.has_key?(state.deferred, adopt) do
      {:reply, {:error, %HostError{code: "invalid value", detail: "ref #{inspect(adopt)} is already in use"}}, state}
    else
      case exchange(state, "settle", %{"group" => g, "call" => call, "settlement" => fields}) do
        {{:ok, _}, state} ->
          state =
            if adopt != nil,
              do: %{
                state
                | calls: Map.put(state.calls, {g, call}, {:deferred, adopt}),
                  deferred: Map.put(state.deferred, adopt, {g, call})
              },
              else: state

          state = update_in(state.groups[g].unsettled, &MapSet.delete(&1, call))
          {:reply, :ok, release_held(state, g)}

        {error, state} ->
          {:reply, error, state}
      end
    end
  rescue
    error in HostError -> {:reply, {:error, error}, state}
  end

  def handle_call({:send, kind, %Group{name: g}, to, name, args}, from, state) do
    fields = %{"group" => g, "to" => target(to), "message" => %{"name" => name, "args" => encode(state, g, args)}}
    queue(state, kind, g, fields, from)
  rescue
    error in HostError -> {:reply, {:error, error}, state}
  end

  # A Function Value call has the shape of a request.
  def handle_call({:call, %Group{name: g}, fun, args}, from, state) do
    fields = %{"group" => g, "fn" => encode(state, g, fun), "args" => encode(state, g, args)}
    queue(state, "call", g, fields, from)
  rescue
    error in HostError -> {:reply, {:error, error}, state}
  end

  def handle_call({:pump, %Group{name: g}, opts}, _from, state) do
    {reply, state} = pump(state, g, now(state, opts), Keyword.get(opts, :fuel_slice, state.fuel_slice))
    {:reply, reply, state}
  end

  # A combined call: admit once, then Pump once, in one exchange. Each kind
  # is built as its ordinary message would be.
  def handle_call({:pumped, kind, %Group{name: g}, input, opts}, _from, state) do
    fields =
      case input do
        {to, name, args} ->
          %{"to" => target(to), "message" => %{"name" => name, "args" => encode(state, g, args)}}

        {fun, args} ->
          %{"fn" => encode(state, g, fun), "args" => encode(state, g, args)}
      end

    {reply, state} = combined(state, kind, g, fields, opts)
    {:reply, reply, state}
  rescue
    error in HostError -> {:reply, {:error, error}, state}
  end

  def handle_call({:await, %NorthTalk.Pending{id: id}, timeout}, from, state) do
    case state.handles[id] do
      nil ->
        {:reply, {:error, released(id)}, state}

      %{result: nil} ->
        tref = make_ref()
        if timeout != :infinity, do: Process.send_after(self(), {:await_timeout, id, tref}, timeout)
        {:noreply, put_in(state.handles[id].awaiters[tref], from)}

      %{result: result} ->
        {:reply, result, state}
    end
  end

  # Releasing discards the retained result and fails the awaiters; the
  # request itself carries on.
  def handle_call({:release_pending, %NorthTalk.Pending{id: id}}, _from, state) do
    case Map.pop(state.handles, id) do
      {nil, _} ->
        {:reply, :ok, state}

      {h, handles} ->
        for {_, from} <- h.awaiters, do: GenServer.reply(from, {:error, released(id)})
        waiters = Map.reject(state.waiters, &match?({_, {:handle, ^id}}, &1))
        {:reply, :ok, %{state | handles: handles, waiters: waiters}}
    end
  end

  defp queue(state, kind, g, fields, from) do
    case exchange(state, kind, fields) do
      {{:ok, ok}, state} ->
        delivery = ok["delivery"]

        state =
          if kind == "deliver",
            do: state,
            else: put_in(state.waiters[{g, delivery}], from)

        state = schedule_pump(state, g)
        if kind == "deliver", do: {:reply, {:ok, delivery}, state}, else: {:noreply, state}

      {error, state} ->
        {:reply, error, state}
    end
  end

  @impl true
  def handle_info({:pump, g}, state) when not is_map_key(state.groups, g), do: {:noreply, state}

  def handle_info({:pump, g}, state) do
    state = update_in(state.groups[g], &%{&1 | queued: false, timer: nil, unsettled: MapSet.new()})

    case pump(state, g, Clock.format(Clock.now(state.clock)), state.fuel_slice) do
      {{:ok, _}, state} -> {:noreply, state}
      {{:error, error}, state} -> {:noreply, fail_group_waiters(state, g, error)}
    end
  end

  # A suspending callback's Task finished.
  def handle_info({monitor, result}, %{monitors: monitors} = state) when is_map_key(monitors, monitor) do
    Process.demonitor(monitor, [:flush])
    {key, state} = forget_task(state, monitor)

    state =
      case result do
        {:defer, ref} ->
          if Map.has_key?(state.deferred, ref),
            do: settle_call(state, key, {:fail, host_failure("deferred ref #{inspect(ref)} is already in use")}),
            else: %{
              state
              | calls: Map.put(state.calls, key, {:deferred, ref}),
                deferred: Map.put(state.deferred, ref, key)
            }

        {:ok, value} ->
          settle_call(state, key, {:answer, value})

        {:error, failure} ->
          settle_call(state, key, {:fail, failure})

        other ->
          settle_call(state, key, {:fail, host_failure("unexpected result #{inspect(other)}")})
      end

    {:noreply, state}
  end

  def handle_info({:DOWN, monitor, :process, _, reason}, %{monitors: monitors} = state)
      when is_map_key(monitors, monitor) do
    {key, state} = forget_task(state, monitor)
    {:noreply, settle_call(state, key, {:fail, host_failure(Exception.format_exit(reason))})}
  end

  # The handle may have been released, completed or closed meanwhile.
  def handle_info({:await_timeout, id, tref}, state) do
    with %{awaiters: %{^tref => from} = awaiters} = h <- state.handles[id] do
      GenServer.reply(from, {:error, %HostError{code: "timeout", detail: "the request is still running"}})
      {:noreply, put_in(state.handles[id], %{h | awaiters: Map.delete(awaiters, tref)})}
    else
      _ -> {:noreply, state}
    end
  end

  def handle_info(_, state), do: {:noreply, state}

  defp forget_task(state, monitor) do
    {key, monitors} = Map.pop(state.monitors, monitor)
    {key, %{state | monitors: monitors, calls: Map.delete(state.calls, key)}}
  end

  # Answers or fails a suspending call. The Core may have abandoned it in
  # the meantime; its refusal of a late settlement is ignored.
  defp settle_call(state, {g, call}, settlement) do
    fields =
      case settlement do
        {:answer, value} -> %{"group" => g, "call" => call, "value" => encode(state, g, value)}
        {:fail, failure} -> %{"group" => g, "call" => call, "error" => failure(failure)}
      end

    {_, state} = exchange(state, elem(settlement, 0) |> Atom.to_string(), fields)
    schedule_pump(state, g)
  rescue
    error in HostError ->
      {_, state} =
        exchange(state, "fail", %{"group" => g, "call" => call, "error" => failure(host_failure(error.detail))})

      schedule_pump(state, g)
  end

  # The Core abandoned these calls: their work stops, and any settlement
  # still to come is refused as an unknown ref.
  defp abandon(state, g, ids) do
    Enum.reduce(ids, state, fn id, state ->
      case Map.pop(state.calls, {g, id}) do
        {{:task, pid, monitor}, calls} ->
          Process.demonitor(monitor, [:flush])
          Process.exit(pid, :kill)
          %{state | calls: calls, monitors: Map.delete(state.monitors, monitor)}

        {{:deferred, ref}, calls} ->
          %{state | calls: calls, deferred: Map.delete(state.deferred, ref)}

        {nil, _} ->
          state
      end
    end)
  end

  defp own_grants(grants) do
    me = self()

    Enum.find_value(grants, :ok, fn
      {name, %Grant{owner: ^me}} when is_binary(name) ->
        nil

      {name, grant} ->
        {:error,
         %HostError{code: "invalid value", detail: "#{inspect(name)}: #{inspect(grant)} is not a Grant of this owner"}}
    end)
  end

  # One Pump, its reports, and the next Pump it calls for when driving
  # automatically: at once if it was sliced, otherwise at its next deadline.
  defp pump(state, g, now, fuel_slice) do
    case exchange(state, "pump", %{"group" => g, "now" => now, "fuelSlice" => fuel_slice}) do
      {{:ok, ok}, state} -> pumped(state, g, ok)
      other -> other
    end
  end

  defp pumped(state, g, ok) do
    state = update_in(state.groups[g], &%{&1 | unsettled: MapSet.new()})
    {reports, state} = reports(state, g, ok)

    state =
      cond do
        state.drive != :auto -> state
        ok["state"] == "sliced" -> schedule_pump(state, g)
        deadline = ok["nextDeadline"] -> schedule_at(state, g, Clock.parse(deadline))
        true -> state
      end

    result = %{
      state: ok["state"],
      next_deadline: ok["nextDeadline"],
      fuel_used: ok["fuelUsed"],
      reports: reports
    }

    {{:ok, result}, state}
  end

  defp now(state, opts),
    do: if(dt = opts[:now], do: Clock.format(dt), else: Clock.format(Clock.now(state.clock)))

  # Unsupported guests are refused before admission, with no two-call
  # fallback. An admission refusal has no handle and no Pump; a Pump refusal
  # keeps the handle and leaves the input queued.
  defp combined(%{request_pump: false} = state, _kind, _g, _fields, _opts),
    do: {{:error, %HostError{code: "invalid value", detail: "talk.wasm lacks #{Binary.feature()}"}}, state}

  defp combined(%{token: token} = state, _kind, _g, _fields, _opts) when token >= 18_446_744_073_709_551_615,
    do: {{:error, %HostError{code: "invalid value", detail: "correlation tokens are exhausted"}}, state}

  defp combined(state, kind, g, fields, opts) do
    token = state.token + 1
    ref = state.ref + 1

    frame =
      Map.merge(fields, %{
        "m" => kind,
        "ref" => ref,
        "group" => g,
        "token" => token,
        "now" => now(state, opts),
        "fuelSlice" => Keyword.get(opts, :fuel_slice, state.fuel_slice)
      })

    bin = Binary.encode(frame)
    state = %{state | ref: ref, token: token}

    case exchange_frame(state, {:binary, bin}, g, false) do
      {{:binary, reply}, state} -> pumped_reply(state, g, token, reply)
      {{:ok, ok}, state} -> lost(state, {:invalid_reply, plain(ok)})
      other -> other
    end
  end

  defp pumped_reply(state, g, token, reply) do
    delivery = reply["delivery"]

    cond do
      is_binary(delivery) and reply["token"] == token ->
        id = make_ref()
        state = put_in(state.handles[id], %{group: g, delivery: delivery, result: nil, awaiters: %{}})
        state = put_in(state.waiters[{g, delivery}], {:handle, id})

        {pump, state} =
          if ok = reply["ok"] do
            pumped(state, g, ok)
          else
            state = abandon(state, g, reply["abandoned"] || [])
            {{:error, error(reply["err"])}, schedule_pump(state, g)}
          end

        pending = %NorthTalk.Pending{owner: self(), group: g, delivery: delivery, id: id}
        {{:ok, %NorthTalk.Pumped{pending: pending, pump: pump}}, state}

      delivery == nil and reply["err"] != nil ->
        {{:error, error(reply["err"])}, abandon(state, g, reply["abandoned"] || [])}

      true ->
        lost(state, {:invalid_reply, plain(reply)})
    end
  end

  # The final reply of a Pump, Reload or Library replacement: the calls the
  # Core abandoned, then its reports, in order.
  defp reports(state, g, ok) do
    reports = Enum.map(ok["reports"] || [], &report(state, g, &1))
    state = abandon(state, g, ok["abandoned"] || [])
    state = Enum.reduce(reports, state, &settle(&2, g, &1))
    {Enum.map(reports, &elem(&1, 0)), state}
  end

  # A Reload or Library replacement ends Runs, whose reports settle waiting
  # requests; the reloaded code takes new messages at once.
  defp work(_state, g, {{:ok, ok}, state}) do
    {reports, state} = reports(state, g, ok)
    {{:ok, reports}, schedule_pump(state, g)}
  end

  defp work(_state, _g, {error, state}), do: {error, state}

  defp carry(opts) do
    case Keyword.get(opts, :variables, :carry) do
      :carry -> "carry variables"
      :reset -> "reset variables"
    end
  end

  defp group_entry, do: %{timer: nil, queued: false, unsettled: MapSet.new()}

  # A restored Group isn't pumped automatically until every pending call is
  # settled, since its first Pump fails each one still unsettled.
  defp release_held(state, g) do
    if MapSet.size(state.groups[g].unsettled) == 0, do: schedule_pump(state, g), else: state
  end

  defp pending_call(state, g, p) do
    %NorthTalk.PendingCall{
      call: p["call"],
      script: p["script"],
      grant: p["grant"],
      operation: p["operation"],
      args: decode(state, g, p["args"])
    }
  end

  defp report(state, g, r) do
    plain = plain(r)

    value =
      case r["result"] do
        nil -> nil
        v -> decode(state, g, v)
      end

    {plain, value}
  end

  defp settle(state, g, {report, value}) do
    if pid = state.reports_to, do: send(pid, {:north_talk, %Group{owner: self(), name: g}, report})

    case report["kind"] do
      "run end" ->
        reply(state, g, report["delivery"], outcome(report, value))

      # A stopped or reloaded Script's Runs end with no `run end`, and the
      # messages in its mailbox are dropped.
      "run discarded" ->
        reply(state, g, report["rootDelivery"], {:error, discarded(report, report["rootDelivery"])})

      "stop" ->
        Enum.reduce(report["droppedMessages"] || [], state, &reply(&2, g, &1, {:error, discarded(report, &1)}))

      _ ->
        state
    end
  end

  defp reply(state, g, delivery, reply) do
    case Map.pop(state.waiters, {g, delivery}) do
      {nil, _} ->
        state

      {{:handle, id}, waiters} ->
        complete(%{state | waiters: waiters}, id, reply)

      {from, waiters} ->
        GenServer.reply(from, reply)
        %{state | waiters: waiters}
    end
  end

  defp discarded(report, delivery),
    do: %ScriptError{outcome: "discarded", error: %{"code" => report["reason"]}, delivery: delivery, report: report}

  defp outcome(%{"outcome" => "completed"} = report, value),
    do: {:ok, %Result{value: value, delivery: report["delivery"], report: report}}

  defp outcome(report, _),
    do:
      {:error,
       %ScriptError{outcome: report["outcome"], error: report["error"], delivery: report["delivery"], report: report}}

  defp schedule_pump(%{drive: :auto} = state, g) do
    case state.groups[g] do
      %{queued: true} ->
        state

      group ->
        if MapSet.size(group.unsettled) > 0 do
          state
        else
          if group.timer, do: Process.cancel_timer(group.timer)
          send(self(), {:pump, g})
          put_in(state.groups[g], %{group | queued: true, timer: nil})
        end
    end
  end

  defp schedule_pump(state, _), do: state

  defp schedule_at(state, g, at) do
    group = state.groups[g]
    if group.timer, do: Process.cancel_timer(group.timer)
    delay = max(0, div(at - Clock.now(state.clock) + 999, 1000))
    put_in(state.groups[g], %{group | timer: Process.send_after(self(), {:pump, g}, delay)})
  end

  # One complete exchange: the message, then every need the Core replies
  # with, answered under the same ref, until the final reply.
  defp exchange(state, m, fields) do
    state = %{state | ref: state.ref + 1}
    exchange_frame(state, Map.merge(fields, %{"m" => m, "ref" => state.ref}), fields["group"], false)
  end

  # A refused interim answer leaves the Core mid-exchange, so the instance is
  # lost; a refused opening frame never reached the Core.
  defp exchange_frame(state, message, g, interim?) do
    frame = with {:binary, bin} <- message, do: bin, else: (_ -> Jason.encode!(message))

    case Transport.exchange(state.transport, frame) do
      {:ok, reply} ->
        {binary?, reply} = read_reply(state, reply)
        ref = state.ref

        cond do
          # A refused binary frame changed nothing, so the instance carries on.
          not interim? and match?({:binary, _}, message) and reply["ref"] == 0 and
              reply["err"]["kind"] == "protocol error" ->
            {{:error, %HostError{code: "protocol error", detail: reply["err"]["detail"]}}, state}

          reply["ref"] != ref ->
            lost(state, {:invalid_reply, plain(reply)})

          binary? and not state.callbacks and reply["need"] != nil ->
            lost(state, {:invalid_reply, "unnegotiated binary callback"})

          need = reply["need"] ->
            {answer, state} = answer(state, g, plain(need), need["args"])
            answer = Map.put(answer, "ref", ref)
            answer = if binary?, do: {:binary, Binary.encode(Map.put(answer, "group", g))}, else: answer
            exchange_frame(state, answer, g, true)

          # A final reply in the binary envelope, which the caller reads.
          binary? ->
            {{:binary, reply}, state}

          ok = reply["ok"] ->
            {{:ok, ok}, state}

          err = reply["err"] ->
            {{:error, error(err)}, state}

          true ->
            lost(state, {:invalid_reply, plain(reply)})
        end

      {:refused, reason} when interim? ->
        lost(state, {:interim_answer_refused, reason})

      {:refused, reason} ->
        {{:error, %HostError{code: "refused", detail: inspect(reason)}}, state}

      {:error, reason} ->
        lost(state, reason)
    end
  end

  defp read_reply(state, reply) do
    if Binary.binary?(reply) do
      try do
        {true, Binary.decode(reply)}
      rescue
        error in HostError -> lost(state, {:invalid_reply, error.detail})
      end
    else
      {false, Jason.decode!(reply, objects: :ordered_objects, floats: :decimals)}
    end
  end

  defp answer(state, g, %{"m" => "op"} = need, args) do
    {result, state} = operation(state, g, need, args)
    {Map.merge(%{"m" => "op-result", "charged" => 0}, result), state}
  end

  defp answer(state, g, %{"m" => "effect"} = need, _args),
    do: {Map.put(effect(state, g, need), "m", "effect-result"), state}

  defp answer(state, g, %{"m" => "release"} = need, _args) do
    release(state, g, need)
    {%{"m" => "release-result"}, state}
  end

  defp answer(state, g, %{"m" => "resolve"} = need, _args) do
    grants = Enum.map(need["grants"] || [], fn [script, name] -> {script, name, rebind(state, script, name)} end)
    bindings = for {script, name, %Grant{} = grant} <- grants, into: %{}, do: {{g, script, name}, grant}

    # Host Objects come in a later slice of #963, so none resolves.
    answer = %{
      "m" => "resolve-result",
      "grants" => Enum.map(grants, fn {_, _, grant} -> grant && grant.handle end),
      "objects" => Enum.map(need["objects"] || [], fn _ -> false end)
    }

    {answer, %{state | bindings: Map.merge(state.bindings, bindings)}}
  end

  # Host Objects come in a later slice of #963; until then a property is
  # refused safely.
  defp answer(state, _g, %{"m" => "prop"}, _args),
    do: {%{"m" => "prop-result", "hostError" => %{"detail" => "no Host Objects"}}, state}

  defp answer(state, _g, need, _args), do: {%{"m" => "#{need["m"]}-result"}, state}

  # A restore's Grant for one Script's name, or nil to restore it revoked.
  defp rebind(state, script, name) do
    me = self()

    grant =
      case state.restoring do
        fun when is_function(fun, 2) -> fun.(script, name)
        %{} = grants -> grants[{script, name}]
        _ -> nil
      end

    with %Grant{owner: ^me} <- grant, do: grant, else: (_ -> nil)
  end

  @phases %{"begin" => :begin, "commit" => :commit, "rollback" => :rollback}
  @statuses [:ok, :failed, :unknown]

  # A Segment lifecycle crossing goes to the first enrolled Grant's
  # Capability. Anything but a status it returns is `unknown`.
  defp effect(state, g, need) do
    script = need["script"]
    grants = Enum.map(need["grants"] || [need["grant"]], &{&1, state.bindings[{g, script, &1}]})

    with %Grant{} = grant <- state.bindings[{g, script, need["grant"]}],
         %Capability{effect: hook} = capability when hook != nil <- state.capabilities[grant.capability] do
      effect = %Effect{
        group: %Group{owner: self(), name: g},
        script: script,
        run: need["run"],
        segment: need["segment"],
        phase: @phases[need["phase"]],
        grant: need["grant"],
        binding: grant.binding,
        grants: Enum.map(grants, fn {name, grant} -> {name, grant && grant.binding} end),
        coordinator: need["coordinator"],
        now: need["now"]
      }

      case hook(state, hook, [effect.phase, effect], capability.timeout) do
        {:ok, status} when status in @statuses ->
          %{"status" => Atom.to_string(status)}

        {:ok, {status, detail}} when status in @statuses ->
          %{"status" => Atom.to_string(status), "detail" => to_string(detail)}

        {:ok, other} ->
          %{"status" => "unknown", "detail" => "unexpected result #{inspect(other)}"}

        {:error, detail} ->
          %{"status" => "unknown", "detail" => detail}
      end
    else
      _ -> %{"status" => "unknown", "detail" => "no lifecycle hooks for #{need["grant"]}"}
    end
  end

  @reasons %{"stop" => :stop, "reload" => :reload, "revoke" => :revoke, "disable" => :disable}

  # Releasing can't be refused, so the hook's result and failures are ignored.
  defp release(state, g, need) do
    with %Grant{} = grant <- state.bindings[{g, need["script"], need["grant"]}],
         %Capability{release: hook} = capability when hook != nil <- state.capabilities[grant.capability] do
      release = %Release{
        group: %Group{owner: self(), name: g},
        script: need["script"],
        grant: need["grant"],
        binding: grant.binding,
        reason: @reasons[need["reason"]],
        now: need["now"]
      }

      hook(state, hook, [release], capability.timeout)
    end
  end

  # A lifecycle hook runs in a Task, like a callback, and the owner waits
  # for it.
  defp hook(state, hook, args, timeout) do
    task = Task.Supervisor.async_nolink(state.tasks, Capability, :hook, [hook, args])

    case Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> {:ok, result}
      {:exit, reason} -> {:error, Exception.format_exit(reason)}
      nil -> {:error, "timed out after #{timeout} ms"}
    end
  end

  # Dispatch is by the Script's Grant, so the call reaches the Capability
  # that Grant is of, with its binding, whatever other Capabilities name
  # their Operations.
  defp operation(state, g, need, args) do
    with %Grant{} = grant <- state.bindings[{g, need["script"], need["grant"]}],
         true <- grant.capability == need["capability"],
         %Capability{} = capability <- state.capabilities[grant.capability],
         %{} = op <- capability.operations[need["operation"]] do
      call = %Call{
        id: need["call"],
        owner: self(),
        group: %Group{owner: self(), name: g},
        script: need["script"],
        grant: need["grant"],
        binding: grant.binding,
        capability: grant.capability,
        operation: need["operation"],
        mode: op.mode,
        now: need["now"],
        run: need["run"],
        segment: need["segment"],
        scope: need["scope"],
        automatic: need["automatic"] == true
      }

      run(state, capability, op, decode(state, g, args), call)
    else
      _ -> {host_error("no Capability answers #{need["capability"]}.#{need["operation"]} for #{need["grant"]}"), state}
    end
  end

  defp run(state, _capability, %{mode: :suspending} = op, args, call) do
    %Task{pid: pid, ref: monitor} = Task.Supervisor.async_nolink(state.tasks, Capability, :invoke, [op, args, call])
    key = {call.group.name, call.id}

    state = %{
      state
      | calls: Map.put(state.calls, key, {:task, pid, monitor}),
        monitors: Map.put(state.monitors, monitor, key)
    }

    {%{"started" => true}, state}
  end

  defp run(state, capability, op, args, call) do
    task = Task.Supervisor.async_nolink(state.tasks, Capability, :invoke, [op, args, call])

    result =
      try do
        case Task.yield(task, capability.timeout) || Task.shutdown(task, :brutal_kill) do
          {:ok, {:ok, value}} when op.mode == :immediate -> %{"result" => encode(state, call.group.name, value)}
          {:ok, :noreply} when op.mode == :fire_and_forget -> %{"done" => true}
          {:ok, {:error, failure}} -> %{"fail" => failure(failure)}
          {:ok, other} -> host_error("unexpected result #{inspect(other)}")
          {:exit, reason} -> host_error(Exception.format_exit(reason))
          nil -> host_error("timed out after #{capability.timeout} ms")
        end
      rescue
        error in HostError -> host_error(error.detail)
      end

    {result, state}
  end

  # Values crossing for Group g: its Function Values become handles here.
  defp ctx(state, g), do: %{owner: self(), group: g, table: state.functions}
  defp encode(state, g, term), do: Value.encode(term, ctx(state, g))
  defp decode(state, g, term), do: Value.decode(term, ctx(state, g))

  defp no_group(g), do: %HostError{code: "group closed", detail: "no open Group #{g}"}

  defp host_error(detail), do: %{"hostError" => %{"detail" => detail}}

  # A failure the callback didn't declare. The Script sees `host error`.
  defp host_failure(detail), do: %{code: "host error", message: detail}

  defp failure(code) when is_binary(code), do: %{"code" => code}

  defp failure(%{code: code} = f) do
    data = if d = f[:data], do: Value.encode(d)
    Enum.reject([{"code", code}, {"message", f[:message]}, {"data", data}], &is_nil(elem(&1, 1))) |> Map.new()
  end

  defp failure(other), do: raise(HostError, code: "invalid value", detail: "#{inspect(other)} is not a failure")

  # terminate/2 fails the waiting requests. A trap or a timeout poisons the
  # instance; nothing is retried, so a caller restores from its own save.
  defp lost(_state, reason) when reason == :timeout or elem(reason, 0) == :trap do
    Process.put(:north_talk_fault, reason)
    exit({:shutdown, :trapped})
  end

  defp lost(_state, reason), do: exit({:shutdown, {:instance_lost, reason}})

  # A failed automatic Pump, such as one out of memory under `:memory_cap`,
  # would otherwise leave the Group's requests waiting for good.
  defp fail_group_waiters(state, g, error) do
    {failed, waiters} = Map.split_with(state.waiters, fn {{wg, _}, _} -> wg == g end)

    Enum.reduce(failed, %{state | waiters: waiters}, fn
      {_, {:handle, id}}, state -> complete(state, id, {:error, error})
      {_, from}, state -> GenServer.reply(from, {:error, error}) && state
    end)
  end

  defp fail_waiters(state, error) do
    for {_, from} <- state.waiters, not match?({:handle, _}, from), do: GenServer.reply(from, {:error, error})
    for {_, h} <- state.handles, {_, from} <- h.awaiters, do: GenServer.reply(from, {:error, error})
  end

  # A handle keeps its result for every later await, until it is released.
  defp complete(state, id, result) do
    case state.handles[id] do
      nil ->
        state

      h ->
        for {_, from} <- h.awaiters, do: GenServer.reply(from, result)
        put_in(state.handles[id], %{h | result: result, awaiters: %{}})
    end
  end

  defp released(id), do: %HostError{code: "pending released", detail: inspect(id)}

  defp error(err) do
    case err["kind"] do
      "load error" -> %LoadError{diagnostics: plain(err["diagnostics"])}
      "host error" -> %HostError{code: err["code"], detail: err["detail"]}
      kind -> %HostError{code: kind}
    end
  end

  defp done({:ok, _}), do: :ok
  defp done(error), do: error

  defp ok({:ok, ok}, fun), do: {:ok, fun.(ok)}
  defp ok(error, _), do: error

  defp target({:script, name}), do: %{"script" => name}
  defp target(name) when is_binary(name), do: %{"script" => name}

  defp identity(%Library{identity: id}), do: %{"$bytes" => id}

  # Protocol data, as plain maps: values are decoded separately.
  defp plain(%Jason.OrderedObject{values: values}), do: Map.new(values, fn {k, v} -> {k, plain(v)} end)
  defp plain(list) when is_list(list), do: Enum.map(list, &plain/1)
  defp plain(other), do: other
end
