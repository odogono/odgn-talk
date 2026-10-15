defmodule NorthTalk.Owner do
  @moduledoc false
  use GenServer
  alias NorthTalk.{Delivery, Group, HostError, LoadError, Result, ScriptError, Transport, Value}

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  @impl true
  def init(opts) do
    drive = Keyword.get(opts, :drive, :automatic)
    slice = Keyword.get(opts, :fuel_slice, 10_000)

    if drive not in [:automatic, :manual] or not is_integer(slice) or slice <= 0 do
      {:stop, %HostError{code: "invalid options", detail: "drive or fuel_slice"}}
    else
      start_transport(opts, drive, slice)
    end
  rescue
    error -> {:stop, %HostError{code: "instance start failed", detail: Exception.message(error)}}
  end

  defp start_transport(opts, drive, slice) do
    module = Keyword.get(opts, :transport, Transport.Wasi)

    case module.start(Keyword.drop(opts, [:name, :drive, :fuel_slice, :transport, :required_features])) do
      {:ok, transport} ->
        # The backend is unlinked. Even an untrappable owner exit must close it.
        owner = self()

        spawn(fn ->
          monitor = Process.monitor(owner)

          receive do
            {:DOWN, ^monitor, :process, ^owner, _} -> Transport.stop(transport)
          end
        end)

        state = %{
          transport: transport,
          ref: 0,
          groups: %{},
          deliveries: %{},
          lost: nil,
          drive: drive,
          slice: slice,
          epoch: System.monotonic_time(:microsecond),
          clock_origin: System.system_time(:microsecond)
        }

        {reply, state} = exchange(state, "hello", %{"protocol" => 1})

        case compatible(reply, Keyword.get(opts, :required_features, [])) do
          {:ok, hello} ->
            {:ok, Map.put(state, :hello, hello)}

          {:error, error} ->
            Transport.stop(transport)
            {:stop, error}
        end

      {:error, reason} ->
        {:stop, %HostError{code: "instance start failed", detail: reason}}
    end
  end

  defp compatible({:ok, hello}, required) do
    # Match this package's reactor contract, rather than silently accepting
    # another Core, language revision, Cost Model or save format.
    with %{
           "core" => "zig/0.0.0",
           "saveFormat" => "zig/7",
           "language" => "1.0-rc.3",
           "costModel" => "0",
           "unicode" => "18.0.0"
         } <- hello,
         features when is_list(features) <- Map.get(hello, "features", []),
         true <- Enum.all?(features, &is_binary/1) and Enum.all?(required, &(&1 in features)) do
      {:ok, hello}
    else
      _ -> {:error, %HostError{code: "incompatible core", detail: hello}}
    end
  end

  defp compatible(error, _), do: error

  @impl true
  def handle_call(:info, _from, state), do: {:reply, {:ok, state.hello}, state}

  def handle_call({:new_group, opts}, _from, state) do
    id = "g#{map_size(state.groups) + 1}"
    {reply, state} = exchange(state, "new-group", %{"group" => id, "name" => opts[:name] || id})

    case reply do
      {:ok, _} ->
        group = %Group{owner: self(), id: id, token: make_ref()}
        entry = %{handle: group, timer: nil, libraries: %{}}
        {:reply, {:ok, group}, put_in(state.groups[id], entry)}

      error ->
        {:reply, error, state}
    end
  end

  def handle_call({:group, %Group{id: id} = group, request}, from, state) do
    case state.groups[id] do
      %{handle: ^group} ->
        group_call(request, id, from, state)

      _ ->
        {:reply, {:error, %HostError{code: "wrong group", detail: id}}, state}
    end
  end

  defp group_call({:load, name, source, opts}, id, _from, state) do
    fields = %{"group" => id, "name" => name, "source" => source}
    {reply, state} = exchange(state, "load", put_limits(fields, opts))
    {:reply, reply, state}
  end

  defp group_call({:library, name, source, opts}, id, _from, state) do
    imports = Keyword.get(opts, :imports, [])
    libraries = state.groups[id].libraries

    if Enum.all?(imports, &Map.has_key?(libraries, &1)) do
      fields = %{
        "name" => name,
        "version" => Keyword.get(opts, :version, "1"),
        "source" => source,
        "imports" => Enum.map(imports, &Map.fetch!(libraries, &1))
      }

      {compiled, state} = exchange(state, "compile-library", fields)

      case compiled do
        {:ok, %{"identity" => identity}} ->
          {reply, state} = exchange(state, "add-library", %{"group" => id, "identity" => identity})

          state =
            case reply do
              {:ok, _} -> put_in(state.groups[id].libraries[name], identity)
              _ -> state
            end

          {:reply, reply, state}

        error ->
          {:reply, error, state}
      end
    else
      {:reply, {:error, %HostError{code: "unknown library", detail: imports}}, state}
    end
  end

  defp group_call({:enqueue, kind, script, handler, args, opts}, id, _from, state) do
    message = put_limits(%{"name" => handler, "args" => args}, opts)
    {reply, state} = exchange(state, kind, %{"group" => id, "to" => %{"script" => script}, "message" => message})

    case reply do
      {:ok, %{"delivery" => delivery}} ->
        receipt = %Delivery{group: state.groups[id].handle, id: delivery}
        # Only a Request's outcome outlives its awaiters; a Delivery's is dropped.
        entry = %{result: nil, waiters: [], reports: [], runs: MapSet.new(), retain: kind == "request"}
        state = put_in(state.deliveries[{id, delivery}], entry)
        {:reply, {:ok, receipt}, schedule(state, id, 0)}

      error ->
        {:reply, error, state}
    end
  end

  defp group_call({:await, delivery}, id, from, state) do
    case state.deliveries[{id, delivery}] do
      nil ->
        {:reply, {:error, %HostError{code: "unknown delivery", delivery: delivery}}, state}

      %{result: nil} = entry ->
        {:noreply, put_in(state.deliveries[{id, delivery}], %{entry | waiters: [from | entry.waiters]})}

      %{result: result} ->
        {:reply, result, %{state | deliveries: Map.delete(state.deliveries, {id, delivery})}}
    end
  end

  defp group_call({:forget, delivery}, id, _from, state) do
    {entry, deliveries} = Map.pop(state.deliveries, {id, delivery})

    if entry do
      error = %HostError{code: "delivery forgotten", delivery: delivery}
      Enum.each(entry.waiters, &GenServer.reply(&1, {:error, error}))
    end

    {:reply, {:ok, :forgotten}, %{state | deliveries: deliveries}}
  end

  defp group_call({:pump, now}, id, _from, %{drive: :manual} = state) do
    {reply, state} = pump(state, id, now)
    {:reply, reply, state}
  end

  defp group_call({:pump, _}, _, _, state),
    do:
      {:reply, {:error, %HostError{code: "automatic drive", detail: "use drive: :manual to supply Clock readings"}},
       state}

  defp put_limits(fields, opts) do
    if limits = opts[:limits], do: Map.put(fields, "limits", limits), else: fields
  end

  @impl true
  def handle_info({:pump, id, token}, state) do
    case state.groups[id].timer do
      {_, ^token} ->
        state = put_in(state.groups[id].timer, nil)
        now = clock(state)
        {reply, state} = pump(state, id, now)

        state =
          case reply do
            {:ok, %{"state" => "sliced"}} ->
              schedule(state, id, 0)

            {:ok, %{"nextDeadline" => instant}} when is_binary(instant) ->
              {:ok, deadline, _} = DateTime.from_iso8601(instant)
              delay = max(0, div(DateTime.diff(deadline, now, :microsecond) + 999, 1000))
              schedule(state, id, min(delay, 4_294_967_295))

            {:ok, _} ->
              state

            {:error, error} ->
              fail_deliveries(state, id, error)
          end

        {:noreply, state}

      _ ->
        {:noreply, state}
    end
  end

  defp clock(state) do
    # A monotonic elapsed duration on a fixed epoch gives the Core an Instant
    # without wall-clock corrections ever sending a Group backwards.
    DateTime.from_unix!(state.clock_origin + System.monotonic_time(:microsecond) - state.epoch, :microsecond)
  end

  defp schedule(%{drive: :manual} = state, _, _), do: state

  defp schedule(state, id, delay) do
    if timer = state.groups[id].timer, do: Process.cancel_timer(elem(timer, 0))
    token = make_ref()
    timer = Process.send_after(self(), {:pump, id, token}, delay)
    put_in(state.groups[id].timer, {timer, token})
  end

  defp pump(state, id, now) do
    fields = %{
      "group" => id,
      "now" => DateTime.to_iso8601(DateTime.shift_zone!(now, "Etc/UTC")),
      "fuelSlice" => state.slice
    }

    {reply, state} = exchange(state, "pump", fields)

    state =
      case reply do
        {:ok, %{"reports" => reports}} -> record_reports(state, id, reports)
        _ -> state
      end

    {reply, state}
  end

  defp record_reports(state, id, reports) do
    # Later entries overwrite earlier ones, so the last terminal report wins.
    terminals =
      for %{"kind" => kind, "delivery" => delivery} = report <- reports,
          kind in ["run end", "unhandled"],
          into: %{},
          do: {delivery, report}

    Enum.reduce(state.deliveries, state, fn
      {{^id, delivery} = key, %{result: nil} = entry}, state ->
        {own, runs} = own_reports(reports, delivery, entry.runs)
        entry = %{entry | reports: [own | entry.reports], runs: runs}

        if terminal = terminals[delivery] do
          settle(state, key, entry, outcome(delivery, terminal, report_history(entry)))
        else
          put_in(state.deliveries[key], entry)
        end

      _, state ->
        state
    end)
  end

  # A report belongs to a Delivery through its id, its root, or one of its Runs.
  defp own_reports(reports, delivery, runs) do
    runs =
      for %{"run" => run} = report <- reports, owned?(report, delivery), into: runs, do: run

    {Enum.filter(reports, &(owned?(&1, delivery) or owned_run?(&1, runs))), runs}
  end

  defp owned?(report, delivery), do: report["delivery"] == delivery or report["rootDelivery"] == delivery

  defp owned_run?(%{"run" => run}, runs), do: MapSet.member?(runs, run)

  defp owned_run?(%{"call" => call}, runs) when is_binary(call),
    do: Enum.any?(runs, &String.starts_with?(call, &1 <> ".c"))

  defp owned_run?(_, _), do: false

  defp outcome(delivery, %{"kind" => "run end", "outcome" => "completed"} = report, reports) do
    {:ok,
     %Result{
       delivery: delivery,
       run: report["run"],
       outcome: "completed",
       value: Value.decode(report["result"]),
       report: report,
       reports: reports
     }}
  rescue
    e in HostError -> {:error, %{e | delivery: delivery, report: report, reports: reports}}
  end

  defp outcome(delivery, report, reports) do
    error = report["error"] || %{}

    if error["code"] == "host error" do
      failed =
        Enum.find(Enum.reverse(reports), fn r ->
          r["kind"] == "call failed" and String.starts_with?(r["call"], report["run"] <> ".c")
        end) || %{}

      {:error,
       %HostError{
         code: "host error",
         detail: failed["detail"] || error["message"],
         call: failed["call"],
         delivery: delivery,
         report: report,
         reports: reports
       }}
    else
      {:error,
       %ScriptError{
         code: error["code"] || "send failed",
         message: error["message"] || report["outcome"] || "unhandled",
         data: Map.drop(error, ["code", "message"]),
         delivery: delivery,
         run: report["run"],
         outcome: report["outcome"] || "unhandled",
         report: report,
         reports: reports
       }}
    end
  end

  defp settle(state, key, entry, result) do
    Enum.each(entry.waiters, &GenServer.reply(&1, result))

    if entry.waiters == [] and entry.retain do
      put_in(state.deliveries[key], %{entry | result: result, reports: []})
    else
      %{state | deliveries: Map.delete(state.deliveries, key)}
    end
  end

  defp report_history(entry), do: entry.reports |> Enum.reverse() |> List.flatten()

  defp fail_deliveries(state, group, error) do
    Enum.reduce(state.deliveries, state, fn
      {{id, delivery} = key, %{result: nil} = entry}, state when group == :all or group == id ->
        settle(state, key, entry, {:error, %{error | delivery: delivery, reports: report_history(entry)}})

      _, state ->
        state
    end)
  end

  # Each exchange, including all interim needs, finishes before returning to
  # the GenServer mailbox. This slice registers no user callbacks.
  defp exchange(%{lost: error} = state, _, _) when not is_nil(error), do: {{:error, error}, state}

  defp exchange(state, message, fields) do
    state = %{state | ref: state.ref + 1}
    frame = Map.merge(fields, %{"m" => message, "ref" => state.ref})
    conversation(state, frame, false)
  end

  defp conversation(state, frame, interim?) do
    ref = state.ref

    case Transport.exchange(state.transport, Jason.encode!(frame)) do
      {:ok, bytes} ->
        case Jason.decode!(bytes) do
          %{"ref" => ^ref, "ok" => body} ->
            {{:ok, body}, state}

          %{"ref" => ^ref, "err" => error} ->
            if error["kind"] == "protocol error", do: lost(state, error), else: {{:error, protocol_error(error)}, state}

          %{"ref" => ^ref, "need" => need} ->
            conversation(state, Map.merge(answer(need), %{"ref" => ref}), true)

          other ->
            lost(state, {"invalid reply", other})
        end

      {:refused, reason} ->
        if interim?,
          do: lost(state, {:interim_answer_refused, reason}),
          else: {{:error, %HostError{code: "frame refused", detail: reason}}, state}

      {:error, reason} ->
        lost(state, reason)
    end
  rescue
    error -> lost(state, Exception.message(error))
  end

  defp answer(%{"m" => "op"}),
    do: %{"m" => "op-result", "hostError" => %{"detail" => "no registered Operation"}, "charged" => 0}

  defp answer(%{"m" => "prop"}), do: %{"m" => "prop-result", "hostError" => %{"detail" => "no registered property"}}

  defp answer(%{"m" => "effect"}),
    do: %{"m" => "effect-result", "status" => "failed", "detail" => "no registered lifecycle hook"}

  defp answer(%{"m" => "release"}), do: %{"m" => "release-result"}

  defp answer(%{"m" => "resolve", "grants" => grants, "objects" => objects}),
    do: %{
      "m" => "resolve-result",
      "grants" => Enum.map(grants, fn _ -> nil end),
      "objects" => Enum.map(objects, fn _ -> false end)
    }

  defp protocol_error(%{"kind" => "load error", "diagnostics" => diagnostics}), do: %LoadError{diagnostics: diagnostics}
  defp protocol_error(error), do: %HostError{code: error["code"] || error["kind"], detail: error["detail"]}

  defp lost(state, reason) do
    error = %HostError{code: "instance lost", detail: reason}
    Transport.stop(state.transport)
    state = fail_deliveries(%{state | lost: error}, :all, error)
    {{:error, error}, state}
  end

  @impl true
  def terminate(_, state) do
    fail_deliveries(state, :all, %HostError{code: "instance closed"})
    Transport.stop(state.transport)
  end
end
