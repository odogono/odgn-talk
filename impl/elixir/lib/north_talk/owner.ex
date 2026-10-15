defmodule NorthTalk.Owner do
  @moduledoc false
  # The Instance Owner: the one process that holds a reactor instance and
  # conducts every Message Layer exchange with it, one complete exchange at a
  # time, including the needs answered inside it. Use it through `NorthTalk`.

  use GenServer

  alias NorthTalk.{Clock, Group, HostError, Library, LoadError, Result, ScriptError, Transport, Value}

  @protocol 1
  @default_fuel_slice 10_000

  defstruct [
    :transport,
    :versions,
    :drive,
    :clock,
    :fuel_slice,
    :reports_to,
    ref: 0,
    groups: %{},
    waiters: %{}
  ]

  def start_link(opts) do
    {gen_opts, opts} = Keyword.split(opts, [:name])
    GenServer.start_link(__MODULE__, opts, gen_opts)
  end

  @impl true
  def init(opts) do
    transport_opts = Keyword.take(opts, [:path, :compiled, :memory_cap, :timeout, :opt_level])

    with {:ok, transport} <- Transport.Wasi.start(transport_opts),
         state = %__MODULE__{
           transport: transport,
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

  defp check_versions(versions) do
    if is_binary(versions["core"]) and is_binary(versions["saveFormat"]),
      do: :ok,
      else: {:error, %HostError{code: "incompatible core", detail: inspect(versions)}}
  end

  @impl true
  def terminate(reason, %__MODULE__{transport: transport} = state) do
    code = if match?({:shutdown, {:instance_lost, _}}, reason), do: "instance lost", else: "instance closed"
    fail_waiters(state, %HostError{code: code, detail: inspect(reason)})
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

  def handle_call({:load, %Group{name: g}, name, source, opts}, _from, state) do
    fields = %{"group" => g, "name" => name, "source" => source, "grants" => Keyword.get(opts, :grants, %{})}
    {reply, state} = exchange(state, "load", fields)
    {:reply, ok(reply, fn ok -> ok["script"] end), state}
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

  def handle_info(_, state), do: {:noreply, state}

  # One Pump, its reports, and the next Pump it calls for when driving
  # automatically: at once if it was sliced, otherwise at its next deadline.
  defp pump(state, g, now, fuel_slice) do
    case exchange(state, "pump", %{"group" => g, "now" => now, "fuelSlice" => fuel_slice}) do
      {{:ok, ok}, state} ->
        reports = Enum.map(ok["reports"], &report/1)
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
    exchange_frame(state, Map.merge(fields, %{"m" => m, "ref" => state.ref}))
  end

  defp exchange_frame(state, message) do
    case Transport.exchange(state.transport, Jason.encode!(message)) do
      {:ok, reply} ->
        reply = Jason.decode!(reply, objects: :ordered_objects, floats: :decimals)

        cond do
          need = reply["need"] -> exchange_frame(state, Map.put(answer(need), "ref", state.ref))
          ok = reply["ok"] -> {{:ok, ok}, state}
          err = reply["err"] -> {{:error, error(err)}, state}
        end

      {:refused, reason} ->
        {{:error, %HostError{code: "refused", detail: inspect(reason)}}, state}

      {:error, reason} ->
        lost(state, reason)
    end
  end

  # The Capabilities, Host Objects and lifecycle hooks that answer these
  # needs come in later slices of #963; until then each is refused safely.
  defp answer(need) do
    case need["m"] do
      "op" ->
        %{
          "m" => "op-result",
          "hostError" => %{"detail" => "no Capability answers #{need["capability"]}"},
          "charged" => 0
        }

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
