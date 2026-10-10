defmodule TalkHost.Faults do
  @moduledoc """
  Evidence that no Script fault traps the instance (#532).

  The cases run in turn against one instance per transport. Losing the
  instance (a Wasm trap, a sidecar exit or a timeout) is recorded against the
  input that caused it, and the instance is replaced so the remaining inputs
  still run. After each case a health check asks for `hello` again, expects
  the first reply, and runs a fresh Script in a new Group.
  """
  alias TalkHost.{Session, Transport}

  @now "2026-10-10T12:00:00Z"

  @faults_source """
  function down n
    return down(n + 1) + 1
  end down

  on spin
    repeat forever
    end repeat
  end spin

  on dive
    return down(0)
  end dive

  on boom
    throw "first"
  end boom

  on zero
    return 1 / 0
  end zero

  on hog
    put [] into xs
    repeat forever
      put "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" after xs
    end repeat
  end hog

  on double
    put "x" into s
    repeat forever
      put s & s into s
    end repeat
  end double

  on fails
    ask api to fail
  end fails

  on breaks
    ask api to break
  end breaks
  """

  @hoard_source """
  script variable hoard = []

  on stash n
    repeat for each i in 1..n
      put "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" after hoard
    end repeat
  end stash
  """

  @ops [
    %{"name" => "fail", "mode" => "immediate", "result" => "nothing", "errors" => [%{"code" => "refused"}]},
    %{"name" => "break", "mode" => "immediate", "result" => "nothing"}
  ]

  @handlers %{
    "fail" => &__MODULE__.fail_op/1,
    "break" => &__MODULE__.break_op/1
  }

  def fail_op(_), do: %{"fail" => %{"code" => "refused", "message" => "no"}, "charged" => 0}
  def break_op(_), do: %{"hostError" => %{"detail" => "the Host's own bug"}, "charged" => 0}

  @doc """
  Runs every fault case. `start` makes a fresh instance. `opts[:extra]` adds
  transport-specific cases as `{name, fun(session) -> {session, tally}}`.
  """
  def run(start, opts) do
    reps = opts[:reps]

    script = fn handler, limits ->
      &each(&1, List.duplicate({handler, limits}, reps), fn s, i -> run_fault(s, i) end)
    end

    cases =
      [
        {"Fuel Limit Fault", script.("spin", %{"fuelPerRun" => 100_000})},
        {"Allocation Limit Fault: a growing List", script.("hog", %{"fuelPerRun" => 1_000_000_000})},
        {"Allocation Limit Fault: doubling text", script.("double", %{"fuelPerRun" => 1_000_000_000})},
        {"Persistent State Limit Fault", &hoard(&1, reps, %{}, 1_000)},
        {"call depth Limit Fault at the default depth", script.("dive", %{"fuelPerRun" => 1_000_000})},
        {"deep recursion at the conformance minimum depth",
         script.("dive", %{"fuelPerRun" => 1_000_000_000, "callDepth" => 1_000})},
        {"deep recursion at a depth of 1,000,000",
         script.("dive", %{"fuelPerRun" => 1_000_000_000, "callDepth" => 1_000_000})},
        {"mailbox full", &each(&1, List.duplicate(:mailbox, reps), fn s, _ -> mailbox(s) end)},
        {"throw", script.("boom", %{})},
        {"run-time error", script.("zero", %{})},
        {"Operation failure", script.("fails", %{})},
        {"Host error from an Operation", script.("breaks", %{})},
        {"hostile Script source: pathological",
         &each(&1, TalkHost.Hostile.pathological(), fn s, src -> source(s, src) end)},
        {"hostile Script source: mutated corpus",
         &each(&1, TalkHost.Hostile.mutated(opts[:mutations], opts[:seed]), fn s, src -> source(s, src) end)},
        {"malformed frames", &each(&1, TalkHost.Hostile.frames(), fn s, f -> frame(s, f) end)}
      ] ++ Keyword.get(opts, :extra, [])

    {results, session} =
      Enum.map_reduce(cases, fresh(start), fn {name, fun}, session ->
        IO.puts(:stderr, "  #{name}")
        t0 = System.monotonic_time(:millisecond)

        {session, tally} =
          try do
            fun.(session)
          catch
            kind, reason -> {session, %{"harness error" => Exception.format(kind, reason) |> String.slice(0, 500)}}
          end

        {health, session} = health(session)

        result = %{
          "case" => name,
          "outcomes" => Map.delete(tally, "lostOn"),
          "lost" => Map.get(tally, "lost", 0),
          "lostOn" => Map.get(tally, "lostOn", []) |> Enum.reverse(),
          "healthy" => health == :ok,
          "health" => inspect(health, limit: 10, printable_limit: 300),
          "ms" => System.monotonic_time(:millisecond) - t0
        }

        {result, if(result["healthy"], do: session, else: revive(session))}
      end)

    Transport.stop(session.transport)
    results
  end

  # Runs `fun` on each input, tallying the outcome it returns. A lost
  # instance is recorded with a description of its input, then replaced.
  defp each(session, inputs, fun) do
    Enum.reduce(inputs, {session, %{}}, fn input, {session, tally} ->
      {session, outcome} = fun.(session, input)
      tally = Map.update(tally, outcome, 1, &(&1 + 1))

      if outcome == "lost" do
        lost_on = "#{label(input)}: #{why_lost(session)}"
        {revive(session), Map.update(tally, "lostOn", [lost_on], &[lost_on | &1])}
      else
        {session, tally}
      end
    end)
  end

  @doc """
  Why the instance was lost: the Go runtime's fatal error from stderr if it
  wrote one, or else the transport's reason, such as a Wasm trap.
  """
  def why_lost(session) do
    stderr =
      case session.transport do
        %Transport.Wasi{} = t -> Transport.Wasi.stderr(t)
        %Transport.Sidecar{} = t -> Transport.Sidecar.stderr(t)
      end

    case Regex.run(~r/^(?:fatal error: |messagelayer: |runtime: goroutine stack).*$/m, stderr) do
      [line] ->
        line

      nil ->
        reason = Process.get(:lost_reason, :unknown)

        reason =
          if is_binary(reason), do: reason |> String.split(": error while executing") |> hd(), else: inspect(reason)

        String.slice(reason, 0, 160)
    end
  end

  defp label({name, frame}) when is_binary(name) and is_binary(frame), do: name
  defp label({handler, limits}) when is_map(limits), do: "#{handler} #{JSON.encode!(limits)}"
  defp label(source) when is_binary(source), do: "#{byte_size(source)} bytes: #{inspect(String.slice(source, 0, 40))}"
  defp label(other), do: inspect(other)

  defp fresh(start) do
    {:ok, t} = start.()
    s = Session.new(t, ops: @handlers)
    {s, hello} = Session.ok!(s, "hello", %{"protocol" => 1})
    {s, _} = Session.ok!(s, "define-capability", %{"name" => "api", "ops" => @ops})
    {s, %{"grant" => grant}} = Session.ok!(s, "grant", %{"capability" => "api", "ops" => "all"})
    %{s | meta: %{grant: grant, hello: hello, start: start}}
  end

  defp revive(session) do
    Transport.stop(session.transport)
    fresh(session.meta.start)
  end

  defp health(session) do
    group = "health-#{System.unique_integer([:positive])}"
    hello = session.meta.hello

    with {session, %{"ok" => ^hello}} <- Session.request(session, "hello", %{"protocol" => 1}),
         {session, %{"ok" => _}} <- Session.request(session, "new-group", %{"group" => group, "name" => group}),
         {session, %{"ok" => _}} <-
           Session.request(session, "load", %{
             "group" => group,
             "name" => "ok",
             "source" => "on ok\n  return 1\nend ok\n"
           }),
         {session, %{"ok" => _}} <-
           Session.request(session, "deliver", %{
             "group" => group,
             "to" => %{"script" => "ok"},
             "message" => %{"name" => "ok"}
           }),
         {session, %{"ok" => pump}} <- Session.request(session, "pump", %{"group" => group, "now" => @now}),
         [%{"outcome" => "completed", "result" => 1}] <- Session.run_ends(pump) do
      {:ok, session}
    else
      {session, other} -> {other, session}
      other -> {other, session}
    end
  end

  # Loads the fault Script under `limits` in a new Group, and delivers `handler`.
  defp run_fault(session, {handler, limits}) do
    case new_script(session, @faults_source, limits) do
      {session, {:ok, group}} -> deliver_and_pump(session, group, handler)
      {session, other} -> {session, other}
    end
  end

  defp new_script(session, source, limits) do
    group = "g#{System.unique_integer([:positive])}"

    with {session, %{"ok" => _}} <- Session.request(session, "new-group", %{"group" => group, "name" => group}),
         {session, %{"ok" => _}} <-
           Session.request(session, "load", %{
             "group" => group,
             "name" => "s",
             "grants" => %{"api" => session.meta.grant},
             "source" => source,
             "limits" => limits
           }) do
      {session, {:ok, group}}
    else
      {session, reply} -> {session, describe_reply("load", reply)}
    end
  end

  defp deliver_and_pump(session, group, handler, args \\ []) do
    with {session, %{"ok" => _}} <-
           Session.request(session, "deliver", %{
             "group" => group,
             "to" => %{"script" => "s"},
             "message" => %{"name" => handler, "args" => args}
           }),
         {session, %{"ok" => pump}} <- Session.request(session, "pump", %{"group" => group, "now" => @now}) do
      {session, describe(Session.run_ends(pump))}
    else
      {session, reply} -> {session, describe_reply("deliver", reply)}
    end
  end

  # The reason is kept for `why_lost/1`; the outcome only counts the loss.
  defp describe_reply(_, {:lost, reason}) do
    Process.put(:lost_reason, reason)
    "lost"
  end

  defp describe_reply(_, {:refused, reason}), do: "refused by the transport: #{reason}"
  defp describe_reply(m, %{"err" => %{"kind" => "host error", "code" => code}}), do: "#{m} refused: host error #{code}"

  defp describe_reply(m, %{"err" => %{"kind" => "protocol error", "detail" => d}}),
    do: "#{m} refused: protocol error: #{d}"

  defp describe_reply(m, %{"err" => %{"kind" => kind}}), do: "#{m} refused: #{kind}"

  defp describe([%{"outcome" => "limit fault", "limit" => limit}]), do: "limit fault: #{limit}"
  defp describe([%{"outcome" => "errored", "error" => %{"code" => code}}]), do: "errored: #{code}"
  defp describe([%{"outcome" => outcome}]), do: outcome
  defp describe(ends), do: "#{length(ends)} run ends"

  # Grows a Script Variable by `per_run` short texts each Run, until
  # Persistent State has faulted `reps` times.
  defp hoard(session, reps, limits, per_run) do
    {session, {:ok, group}} = new_script(session, @hoard_source, limits)

    Enum.reduce_while(1..1_000, {session, %{}}, fn _, {session, tally} ->
      {session, outcome} = deliver_and_pump(session, group, "stash", [per_run])
      tally = Map.update(tally, outcome, 1, &(&1 + 1))
      faults = Enum.sum(for {"limit fault" <> _, n} <- tally, do: n)
      if outcome == "lost" or faults >= reps, do: {:halt, {session, tally}}, else: {:cont, {session, tally}}
    end)
  end

  # A full mailbox is refused at the Host's `deliver`, and the Core goes on.
  defp mailbox(session) do
    {session, {:ok, group}} = new_script(session, "on go\nend go\n", %{"mailboxDepth" => 1})
    to = %{"group" => group, "to" => %{"script" => "s"}, "message" => %{"name" => "go"}}
    {session, first} = Session.request(session, "deliver", to)
    {session, second} = Session.request(session, "deliver", to)
    {session, pump} = Session.request(session, "pump", %{"group" => group, "now" => @now})

    case {first, second, pump} do
      {%{"ok" => _}, %{"err" => %{"kind" => "mailbox full"}}, %{"ok" => p}} ->
        {session, "mailbox full, then #{describe(Session.run_ends(p))}"}

      replies ->
        lost = replies |> Tuple.to_list() |> Enum.any?(&match?({:lost, _}, &1))
        {session, if(lost, do: "lost", else: inspect(replies, limit: 5))}
    end
  end

  # Loads a source in a Group of its own, and delivers up to three of its
  # Handlers with no arguments under tight limits. Any reply counts; only a
  # lost instance is a failure.
  defp source(session, source) do
    case new_script(session, source, %{"fuelPerRun" => 100_000}) do
      {session, {:ok, group}} ->
        Regex.scan(~r/^on ([A-Za-z][A-Za-z0-9]*)/m, source, capture: :all_but_first)
        |> Enum.take(3)
        |> Enum.reduce_while({session, "loaded"}, fn [handler], {session, _} ->
          case deliver_and_pump(session, group, handler) do
            {session, "lost"} -> {:halt, {session, "lost"}}
            {session, _} -> {:cont, {session, "loaded and ran"}}
          end
        end)

      {session, outcome} ->
        {session, outcome}
    end
  end

  defp frame(session, {_label, frame}) do
    outcome =
      case Session.raw(session, frame) do
        {:lost, reason} -> describe_reply("frame", {:lost, reason})
        {:refused, reason} -> "refused by the transport: #{reason}"
        %{"err" => %{"kind" => kind}} -> kind
        %{"ok" => _} -> "ok"
        other -> "other: #{inspect(other, limit: 5)}"
      end

    {session, outcome}
  end

  @doc """
  Delivers `handler` `reps` times to the fault Script under `limits`, for
  containment. It stops at a lost instance, since a trapped Go reactor goes
  on answering with stale protocol errors.
  """
  def contained(session, handler, limits, reps) do
    {session, {:ok, group}} = new_script(session, @faults_source, limits)

    Enum.reduce_while(1..reps, {session, %{}}, fn _, {session, tally} ->
      {session, outcome} = deliver_and_pump(session, group, handler)
      tally = Map.update(tally, outcome, 1, &(&1 + 1))
      if outcome == "lost", do: {:halt, {session, tally}}, else: {:cont, {session, tally}}
    end)
  end

  def faults_source, do: @faults_source
  def fresh_session(start), do: fresh(start)
  def health_check(session), do: health(session)
  def hoard_case(session, reps, limits, per_run), do: hoard(session, reps, limits, per_run)
end
