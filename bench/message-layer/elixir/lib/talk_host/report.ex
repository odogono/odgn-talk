defmodule TalkHost.Report do
  @moduledoc """
  Judges the measurements against #532's thresholds and writes them up.

  Latency rows gate on p50 only. A p99 above 10× its p50 is flagged for
  investigation, not failed. The fault and memory containment rows are hard
  gates. The Elixir Host passes if either transport meets every row. The C
  Host's bridge is judged on containment and faults only; its latency and
  memory rows come from bench/message-layer-c.
  """

  @mib 1024 * 1024
  @transports ["wasmex", "sidecar", "c, wasmtime"]

  def verdicts(results, payload) do
    for t <- @transports, results["latency"][t] || results["containment"][t] || results["faults"][t] do
      th = results["thresholds"][t]
      lat = get_in(results, ["latency", t])

      rows =
        if lat do
          [
            latency_row("Capability call p50", lat["call"], th["call"]),
            latency_row("Pump p50", lat["pump"], th["pump"]),
            latency_row("Instantiation p50", lat["instantiation"], th["instantiation"]),
            row("Memory per instance (median)", lat["memory"]["medianBytes"], th["memory"], &mib/1)
          ]
        else
          []
        end

      rows =
        if t == "wasmex" do
          p = results["payload"]

          rows ++
            [
              row("Payload, Brotli", p["brotli11"], payload["brotli"], &mib/1),
              row("Payload, raw", p["raw"], payload["raw"], &mib/1)
            ]
        else
          rows
        end

      rows = rows ++ containment_rows(get_in(results, ["containment", t])) ++ fault_rows(get_in(results, ["faults", t]))
      %{"transport" => t, "rows" => rows, "pass" => Enum.all?(rows, & &1["pass"])}
    end
  end

  defp latency_row(name, stats, limit) do
    flag = if stats["p99"] > 10 * stats["p50"], do: "p99 #{us(stats["p99"])} is over 10× p50: investigate"

    %{
      "row" => name,
      "value" => us(stats["p50"]),
      "threshold" => "≤ " <> us(limit),
      "pass" => stats["p50"] <= limit,
      "note" => flag || "p99 #{us(stats["p99"])}"
    }
  end

  defp row(name, nil, _limit, _fmt),
    do: %{"row" => name, "value" => "not measured", "threshold" => "", "pass" => false, "note" => ""}

  defp row(name, value, limit, fmt),
    do: %{
      "row" => name,
      "value" => fmt.(value),
      "threshold" => "≤ " <> fmt.(limit),
      "pass" => value <= limit,
      "note" => ""
    }

  defp containment_rows(nil), do: []

  defp containment_rows(%{"skipped" => why}),
    do: [%{"row" => "Memory containment", "value" => "skipped", "threshold" => "", "pass" => false, "note" => why}]

  defp containment_rows(profiles) do
    for p <- profiles, p["cap"] do
      bad =
        for c <- p["cases"], {outcome, _} <- c["outcomes"], not contained?(c["case"], outcome) do
          why = c["observed"]["fatal"] || (c["observed"]["exited"] && observed(c["observed"]))
          "#{c["case"]}: #{outcome}#{if why, do: " (#{why})", else: ""}"
        end

      %{
        "row" => "Memory containment, #{p["name"]} under #{mib(p["cap"])}",
        "value" => if(bad == [], do: "every Run ended in a Limit Fault", else: Enum.join(bad, "; ")),
        "threshold" => "Limit Fault, never out of memory",
        "pass" => bad == [] and Enum.all?(p["cases"], & &1["healthy"]),
        "note" => ""
      }
    end
  end

  defp contained?(_, "limit fault" <> _), do: true
  defp contained?("a growing Script Variable", "completed"), do: true
  defp contained?(_, _), do: false

  defp observed(%{"linearMemoryBytes" => b}), do: "linear memory #{mib(b)}"
  defp observed(%{"cgroupPeakBytes" => b, "cgroupEvents" => e}), do: "cgroup peak #{mib(b)}; #{Enum.join(e, ", ")}"

  defp observed(%{"exited" => %{"oomKilled" => oom, "exitCode" => code}}),
    do: "container exited #{code}#{if oom, do: ", killed by the OOM killer", else: ""}"

  defp observed(other), do: inspect(other)

  defp fault_rows(nil), do: []

  defp fault_rows(cases) do
    lost = Enum.sum(for c <- cases, do: c["lost"])
    unhealthy = for c <- cases, not c["healthy"], do: c["case"]
    lost_cases = for c <- cases, c["lost"] > 0, do: "#{c["case"]} (#{c["lost"]})"

    [
      %{
        "row" => "Script faults",
        "value" =>
          if(lost == 0 and unhealthy == [],
            do: "no instance lost",
            else: "#{lost} instances lost: #{Enum.join(lost_cases, "; ")}"
          ),
        "threshold" => "no trap and no lost instance",
        "pass" => lost == 0 and unhealthy == [],
        "note" => if(unhealthy == [], do: "", else: "failed health check after: #{Enum.join(unhealthy, ", ")}")
      }
    ]
  end

  def markdown(r) do
    env = r["environment"]

    """
    # Message Layer from an Elixir Host

    #{if r["quick"], do: "> **Quick run: these figures only check the harness.**\n\n", else: ""}Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

    | | |
    | --- | --- |
    | Commit | `#{env["commit"]}` |
    | Machine | #{env["cpu"]}, #{env["os"]}#{if l = env["loadAverage"], do: ", load average #{l} at the start", else: ""} |
    | Elixir | #{env["elixir"]}, OTP #{env["otp"]} |
    | Wasmex | #{env["wasmex"]} (wasmtime #{env["wasmtime"]}), Cranelift `opt_level: :speed` |
    | Go | #{env["go"]} |
    | Docker | #{env["docker"] || "not available"} |
    | Reactor | `#{r["payload"]["sha256"]}` |
    | Samples | #{sizes(r["sizes"])} |

    ## Verdict

    #{verdict_tables(r["verdicts"])}
    #{latency_md(r["latency"])}#{containment_md(r["containment"])}#{faults_md(r["faults"])}
    """
  end

  defp sizes(s),
    do:
      "#{s["samples"]} per latency run after #{s["warmup"]} warm-up, #{s["runs"]} runs judged on the median run; #{s["instances"]} instantiations; #{s["memory"]} instances for memory; #{s["reps"]} repetitions per fault; #{s["mutations"]} mutated sources"

  defp verdict_tables(verdicts) do
    Enum.map_join(verdicts, "\n", fn v ->
      """
      **#{v["transport"]}: #{if v["pass"], do: "meets every row#{if v["transport"] == "c, wasmtime", do: " judged here (containment and faults)"}", else: "misses #{Enum.count(v["rows"], &(not &1["pass"]))} rows"}**

      | Row | Measured | Threshold | | Note |
      | --- | --- | --- | --- | --- |
      #{Enum.map_join(v["rows"], "\n", fn row -> "| #{row["row"]} | #{cell(row["value"])} | #{row["threshold"]} | #{if row["pass"], do: "pass", else: "**miss**"} | #{cell(row["note"])} |" end)}
      """
    end)
  end

  defp latency_md(nil), do: ""

  defp latency_md(lat) do
    figures = for {name, f} <- lat, name != "compileMs", do: {name, f}

    rows =
      for {name, f} <- Enum.sort(figures),
          {label, key} <- [{"Capability call", "call"}, {"Pump", "pump"}, {"Instantiation", "instantiation"}] do
        s = f[key]
        runs = Enum.map_join(s["runs"], ", ", &us(&1["p50"]))

        "| #{name} | #{label} | #{us(s["p50"])} | #{us(s["p99"])} | #{us(s["mean"])} | #{us(s["min"])} | #{us(s["max"])} | #{s["n"]} | #{runs} |"
      end

    memory =
      for {name, f} <- Enum.sort(figures),
          do:
            "| #{name} | #{mib(f["memory"]["medianBytes"])} | #{mib(f["memory"]["maxBytes"])} | #{f["memory"]["instances"]} |"

    """

    ## Latency

    A Capability call is the time from the Host receiving one `op` need to receiving the next, inside one Pump of 100 calls. The handler answers at once with its argument, `{items: [i, "hello", true], count: 1}`. A Pump is a `deliver` and a `pump` of an empty Handler. Instantiation runs from a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply.

    | Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
    | --- | --- | --- | --- | --- | --- | --- | --- | --- |
    #{Enum.join(rows, "\n")}

    Compiling the module, once per Engine: #{Enum.map_join(lat["compileMs"], ", ", fn {level, c} -> "#{Float.round(c["medianMs"] / 1, 1)} ms at `#{level}`" end)}.

    ### Memory per instance

    Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

    | Transport | median | max | instances |
    | --- | --- | --- | --- |
    #{Enum.join(memory, "\n")}
    """
  end

  defp containment_md(nil), do: ""

  defp containment_md(c) do
    rows =
      for {t, profiles} <- Enum.sort(c), is_list(profiles), p <- profiles, case <- p["cases"] do
        cap = if p["cap"], do: mib(p["cap"]), else: "none"

        "| #{t} | #{p["name"]} | #{cap} | #{case["case"]} | #{outcomes(case["outcomes"])} | #{cell(observed(case["observed"]))} |"
      end

    """

    ## Memory containment

    Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

    | Transport | Limits | Cap | Script | Outcomes | Observed |
    | --- | --- | --- | --- | --- | --- |
    #{Enum.join(rows, "\n")}
    """
  end

  defp faults_md(nil), do: ""

  defp faults_md(f) do
    Enum.map_join(Enum.sort(f), "\n", fn {t, cases} ->
      rows =
        Enum.map_join(cases, "\n", fn c ->
          lost_on = if c["lostOn"] == [], do: "", else: Enum.map_join(c["lostOn"], "<br>", &cell/1)

          "| #{c["case"]} | #{outcomes(c["outcomes"])} | #{c["lost"]} | #{lost_on} | #{if c["healthy"], do: "yes", else: "**no**"} | #{Float.round(c["ms"] / 1000, 1)} s |"
        end)

      """

      ## Script faults: #{t}

      | Case | Outcomes | Lost | Lost on | Healthy after | Time |
      | --- | --- | --- | --- | --- | --- |
      #{rows}
      """
    end)
  end

  defp outcomes(o), do: o |> Enum.sort() |> Enum.map_join("<br>", fn {k, v} -> "#{cell(k)}: #{v}" end)
  defp cell(s), do: s |> to_string() |> String.replace("|", "\\|") |> String.replace("\n", " ")
  defp us(x) when x >= 1000, do: "#{Float.round(x / 1000, 2)} ms"
  defp us(x), do: "#{Float.round(x / 1, 1)} µs"
  defp mib(b), do: "#{Float.round(b / @mib, 1)} MiB"
end
