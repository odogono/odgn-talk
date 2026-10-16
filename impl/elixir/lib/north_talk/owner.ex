defmodule NorthTalk.Owner do
  @moduledoc false
  # The Instance Owner: the one process that holds a reactor instance and
  # conducts every Message Layer exchange with it, one complete exchange at a
  # time, including the needs answered inside it. Use it through `NorthTalk`.

  use GenServer

  alias NorthTalk.{
    Call,
    Capability,
    Clock,
    Grant,
    Group,
    HostError,
    Library,
    LoadError,
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
    :tasks,
    ref: 0,
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
    deferred: %{}
  ]

  def start_link(opts) do
    {gen_opts, opts} = Keyword.split(opts, [:name])
    GenServer.start_link(__MODULE__, opts, gen_opts)
  end

  @impl true
  def init(opts) do
    module = Keyword.get(opts, :transport, Transport.Wasi)
    transport_opts = Keyword.drop(opts, [:transport, :drive, :fuel_slice, :reports_to])

    {:ok, tasks} = Task.Supervisor.start_link()

    with {:ok, transport} <- module.start(transport_opts),
         :ok <- stop_with_owner(transport),
         state = %__MODULE__{
           transport: transport,
           tasks: tasks,
           drive: Keyword.get(opts, :drive, :auto),
           clock: Clock.start(),
           fuel_slice: Keyword.get(opts, :fuel_slice, @default_fuel_slice),
           reports_to: opts[:reports_to]
         },
         {{:ok, versions}, state} <- exchange(state, "hello", %{"protocol" => @protocol}),
         :ok <- check_versions(versions) do
      {:ok, %{state | versions: plain(versions)}}
    else
      {{:error, error}, state} ->
        Transport.stop(state.transport)
        {:stop, error}

      {:error, error} ->
        {:stop, error}
    end
  end

  # The backend is unlinked, and terminate/2 does not run when the owner is
  # killed, so a watcher closes the instance whenever the owner exits.
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

  defp check_versions(versions) do
    if is_binary(versions["core"]) and is_binary(versions["saveFormat"]),
      do: :ok,
      else: {:error, %HostError{code: "incompatible core", detail: inspect(versions)}}
  end

  @impl true
  def terminate(reason, %__MODULE__{transport: transport} = state) do
    code = if match?({:shutdown, {:instance_lost, _}}, reason), do: "instance lost", else: "instance closed"
    fail_waiters(state, %HostError{code: code, detail: inspect(reason)})
    for {_, {:task, pid, _}} <- state.calls, do: Process.exit(pid, :kill)
    Transport.stop(transport)
  end

  @impl true
  def handle_call(:versions, _from, state), do: {:reply, state.versions, state}

  def handle_call({:new_group, name, opts}, _from, state) do
    fields = %{"group" => name, "name" => name, "trace" => Keyword.get(opts, :trace, false)}

    case exchange(state, "new-group", fields) do
      {{:ok, _}, state} ->
        state = put_in(state.groups[name], %{timer: nil, queued: false})
        {:reply, {:ok, %Group{owner: self(), name: name}}, state}

      {error, state} ->
        {:reply, error, state}
    end
  end

  def handle_call({:define_capability, capability}, _from, state) do
    capability = Capability.resolve(capability)
    fields = %{"name" => capability.name, "ops" => Capability.declarations(capability)}

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

    with :ok <- own_grants(grants) do
      fields = %{
        "group" => g,
        "name" => name,
        "source" => source,
        "grants" => Map.new(grants, fn {k, %Grant{handle: h}} -> {k, h} end)
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

  def handle_call({:send, kind, %Group{name: g}, to, name, args}, from, state) do
    fields = %{"group" => g, "to" => target(to), "message" => %{"name" => name, "args" => Value.encode(args)}}

    case exchange(state, kind, fields) do
      {{:ok, ok}, state} ->
        delivery = ok["delivery"]

        state =
          if kind == "request",
            do: put_in(state.waiters[{g, delivery}], from),
            else: state

        state = schedule_pump(state, g)
        if kind == "request", do: {:noreply, state}, else: {:reply, {:ok, delivery}, state}

      {error, state} ->
        {:reply, error, state}
    end
  rescue
    error in HostError -> {:reply, {:error, error}, state}
  end

  def handle_call({:pump, %Group{name: g}, opts}, _from, state) do
    now = if dt = opts[:now], do: Clock.format(dt), else: Clock.format(Clock.now(state.clock))
    {reply, state} = pump(state, g, now, Keyword.get(opts, :fuel_slice, state.fuel_slice))
    {:reply, reply, state}
  end

  @impl true
  def handle_info({:pump, g}, state) do
    state = update_in(state.groups[g], &%{&1 | queued: false, timer: nil})
    {_, state} = pump(state, g, Clock.format(Clock.now(state.clock)), state.fuel_slice)
    {:noreply, state}
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
        {:answer, value} -> %{"group" => g, "call" => call, "value" => Value.encode(value)}
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
      {{:ok, ok}, state} ->
        reports = Enum.map(ok["reports"], &report/1)
        state = abandon(state, g, ok["abandoned"] || [])
        state = Enum.reduce(reports, state, &settle(&2, g, &1))

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
          reports: Enum.map(reports, &elem(&1, 0))
        }

        {{:ok, result}, state}

      other ->
        other
    end
  end

  defp report(r) do
    plain = plain(r)

    value =
      case r["result"] do
        nil -> nil
        v -> Value.decode(v)
      end

    {plain, value}
  end

  defp settle(state, g, {report, value}) do
    if pid = state.reports_to, do: send(pid, {:north_talk, %Group{owner: self(), name: g}, report})

    with "run end" <- report["kind"],
         {from, waiters} when from != nil <- Map.pop(state.waiters, {g, report["delivery"]}) do
      GenServer.reply(from, outcome(report, value))
      %{state | waiters: waiters}
    else
      _ -> state
    end
  end

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
        if group.timer, do: Process.cancel_timer(group.timer)
        send(self(), {:pump, g})
        put_in(state.groups[g], %{group | queued: true, timer: nil})
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
    case Transport.exchange(state.transport, Jason.encode!(message)) do
      {:ok, reply} ->
        reply = Jason.decode!(reply, objects: :ordered_objects, floats: :decimals)
        ref = state.ref

        cond do
          reply["ref"] != ref ->
            lost(state, {:invalid_reply, plain(reply)})

          need = reply["need"] ->
            {answer, state} = answer(state, g, plain(need), need["args"])
            exchange_frame(state, Map.put(answer, "ref", ref), g, true)

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

  # Host Objects and lifecycle hooks answer their needs in later slices of
  # #963; until then each is refused safely.
  defp answer(state, g, %{"m" => "op"} = need, args) do
    {result, state} = operation(state, g, need, args)
    {Map.merge(%{"m" => "op-result", "charged" => 0}, result), state}
  end

  defp answer(state, _g, need, _args), do: {answer(need), state}

  defp answer(need) do
    case need["m"] do
      "prop" ->
        %{"m" => "prop-result", "hostError" => %{"detail" => "no Host Objects"}}

      "effect" ->
        %{"m" => "effect-result", "status" => "unknown", "detail" => "no lifecycle hooks"}

      "release" ->
        %{"m" => "release-result"}

      "resolve" ->
        %{
          "m" => "resolve-result",
          "grants" => Enum.map(need["grants"] || [], fn _ -> nil end),
          "objects" => Enum.map(need["objects"] || [], fn _ -> false end)
        }

      m ->
        %{"m" => "#{m}-result"}
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
        now: need["now"]
      }

      run(state, capability, op, Value.decode(args), call)
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
          {:ok, {:ok, value}} when op.mode == :immediate -> %{"result" => Value.encode(value)}
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

  defp host_error(detail), do: %{"hostError" => %{"detail" => detail}}

  # A failure the callback didn't declare. The Script sees `host error`.
  defp host_failure(detail), do: %{code: "host error", message: detail}

  defp failure(code) when is_binary(code), do: %{"code" => code}

  defp failure(%{code: code} = f) do
    data = if d = f[:data], do: Value.encode(d)
    Enum.reject([{"code", code}, {"message", f[:message]}, {"data", data}], &is_nil(elem(&1, 1))) |> Map.new()
  end

  defp failure(other), do: raise(HostError, code: "invalid value", detail: "#{inspect(other)} is not a failure")

  # terminate/2 fails the waiting requests.
  defp lost(_state, reason), do: exit({:shutdown, {:instance_lost, reason}})

  defp fail_waiters(state, error) do
    for {_, from} <- state.waiters, do: GenServer.reply(from, {:error, error})
  end

  defp error(err) do
    case err["kind"] do
      "load error" -> %LoadError{diagnostics: plain(err["diagnostics"])}
      "host error" -> %HostError{code: err["code"], detail: err["detail"]}
      kind -> %HostError{code: kind}
    end
  end

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
