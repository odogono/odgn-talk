defmodule Mix.Tasks.Talk.Measure do
  @shortdoc "Measures the Message Layer from this Elixir Host"
  @moduledoc """
  Measures the Go Core's Message Layer from Elixir, over Wasmex and over the
  sidecar on an Erlang Port, against the thresholds set in #532.

      mix talk.measure [--quick] [--only latency,containment,faults] [--transports wasmex,sidecar,c]
                       [--no-save] [--build]
      mix talk.measure --render bench/results/<file>.json

    * `--quick` takes few samples, to check the harness. Its figures mean nothing.
    * `--only` runs some sections. When the results file for the day and commit exists, they
      replace those sections in it and the rest are kept.
    * `--transports` measures some transports. `c` is the minimal C Host's
      bridge, from `bench/message-layer-c/run.sh`, for containment and faults
      only: its latency is measured inside the C Host. It runs by default when
      that build exists.
    * `--no-save` prints the report without writing it to `bench/results/`.
    * `--build` rebuilds the Go artifacts in `.cache/` first.
    * `--render` rewrites a saved run's Markdown from its JSON, without measuring.

  The sidecar's containment section needs Docker, for a cgroup memory limit.
  """
  use Mix.Task

  alias TalkHost.{Containment, Faults, Measure, Transport}

  @mib 1024 * 1024
  @sections ~w(latency containment faults)

  # spec: https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407
  @thresholds %{
    "wasmex" => %{"call" => 500, "pump" => 250, "instantiation" => 50_000, "memory" => 16 * @mib},
    "sidecar" => %{"call" => 100, "pump" => 100, "instantiation" => 100_000, "memory" => 32 * @mib}
  }
  @payload %{"brotli" => 3 * @mib, "raw" => 25 * @mib}

  @impl true
  def run(argv) do
    {opts, _} =
      OptionParser.parse!(argv,
        strict: [
          quick: :boolean,
          only: :string,
          transports: :string,
          save: :boolean,
          build: :boolean,
          render: :string
        ]
      )

    if path = opts[:render] do
      results = path |> File.read!() |> JSON.decode!()
      results = Map.put(results, "verdicts", TalkHost.Report.verdicts(results, @payload))
      File.write!(Path.rootname(path) <> ".md", TalkHost.Report.markdown(results))
      File.write!(path, JSON.encode!(results) <> "\n")
      Mix.shell().info("Rendered #{Path.rootname(path)}.md")
    else
      measure(opts)
    end
  end

  defp measure(opts) do
    Mix.Task.run("app.start")
    if opts[:build], do: TalkHost.Artifacts.build!()

    sections = if only = opts[:only], do: String.split(only, ","), else: @sections
    quick = Keyword.get(opts, :quick, false)

    sizes =
      if quick,
        do: [runs: 1, samples: 500, warmup: 100, warmup_instances: 3, instances: 30, memory: 3, reps: 3, mutations: 100],
        else: [
          runs: 3,
          samples: 5_000,
          warmup: 500,
          warmup_instances: 20,
          instances: 5_000,
          memory: 20,
          reps: 20,
          mutations: 2_000
        ]

    chosen =
      if t = opts[:transports],
        do: String.split(t, ","),
        else: ["wasmex", "sidecar"] ++ if(File.exists?(TalkHost.Artifacts.c_host()), do: ["c"], else: [])

    transports =
      Enum.filter(
        [
          {"wasmex", fn -> Transport.Wasi.start(opt_level: :speed) end},
          {"sidecar", fn -> Transport.Sidecar.start() end}
        ],
        fn {name, _} -> name in chosen end
      )

    bridge? = "c" in chosen

    results =
      %{
        "environment" => environment(),
        "quick" => quick,
        "sizes" => stringify(Map.new(sizes)),
        "thresholds" => @thresholds
      }
      |> Map.put("payload", payload())
      |> maybe("latency" in sections and transports != [], "latency", fn -> latency(transports, sizes) end)
      |> maybe("containment" in sections, "containment", fn -> containment(chosen, sizes) end)
      |> maybe("faults" in sections, "faults", fn -> faults(transports, bridge?, sizes) end)

    base = Path.join(TalkHost.Artifacts.root(), "bench/results/#{file_stem(results["environment"])}")

    results =
      if opts[:only] && not quick && File.exists?(base <> ".json") do
        earlier = (base <> ".json") |> File.read!() |> JSON.decode!()
        Map.merge(earlier, JSON.encode!(results) |> JSON.decode!())
      else
        results
      end

    results = Map.put(results, "verdicts", TalkHost.Report.verdicts(results, @payload))
    markdown = TalkHost.Report.markdown(results)
    IO.puts(markdown)

    if Keyword.get(opts, :save, true) and not quick do
      File.write!(base <> ".json", JSON.encode!(results) <> "\n")
      File.write!(base <> ".md", markdown)
      Mix.shell().info("Wrote #{Path.relative_to(base, TalkHost.Artifacts.root())}.{json,md}")
    end
  end

  defp stringify(map), do: Map.new(map, fn {k, v} -> {to_string(k), v} end)

  defp maybe(results, false, _, _), do: results
  defp maybe(results, true, key, fun), do: Map.put(results, key, fun.())

  defp latency(transports, sizes) do
    wasmex_none = {"wasmex, opt-level none", fn -> Transport.Wasi.start(opt_level: :none) end}

    compile =
      for level <- [:speed, :none] do
        micros = for _ <- 1..3, do: elem(Transport.Wasi.compile(TalkHost.Artifacts.wasm(), level), 1)
        {Atom.to_string(level), %{"medianMs" => Enum.at(Enum.sort(micros), 1) / 1000}}
      end
      |> Map.new()

    extra = if List.keymember?(transports, "wasmex", 0), do: [wasmex_none], else: []

    figures =
      for {name, start} <- transports ++ extra, into: %{} do
        IO.puts(:stderr, "latency: #{name}")
        start.() |> elem(1) |> Transport.stop()

        {name,
         %{
           "call" => Measure.capability_call(start, sizes),
           "pump" => Measure.pump(start, sizes),
           "instantiation" => Measure.instantiation(start, Keyword.put(sizes, :samples, sizes[:instances])),
           "memory" => Measure.memory(start, sizes[:memory])
         }}
      end

    Map.put(figures, "compileMs", compile)
  end

  defp containment(chosen, sizes) do
    sidecar = fn ->
      case System.cmd("docker", ["info", "--format", "{{.ServerVersion}}"], stderr_to_stdout: true) do
        {_, 0} -> Containment.sidecar(sizes[:reps])
        {out, _} -> %{"skipped" => "Docker isn't available: #{String.trim(out)}"}
      end
    end

    for {name, label, fun} <- [
          {"wasmex", "wasmex", fn -> Containment.wasi(sizes[:reps]) end},
          {"sidecar", "sidecar in a container", sidecar},
          {"c", "c, wasmtime", fn -> Containment.bridge(sizes[:reps]) end}
        ],
        name in chosen,
        into: %{} do
      IO.puts(:stderr, "containment: #{label}")
      {key(name), fun.()}
    end
  end

  defp faults(transports, bridge?, sizes) do
    bridge = if bridge?, do: [{"c", fn -> Transport.Bridge.start(memory_cap: 1024 * @mib) end}], else: []

    for {name, start} <- transports ++ bridge, into: %{} do
      IO.puts(:stderr, "faults: #{name}")

      start =
        if name == "wasmex", do: fn -> Transport.Wasi.start(opt_level: :speed, memory_cap: 1024 * @mib) end, else: start

      {key(name), Faults.run(start, Keyword.merge(sizes, seed: 532, extra: extra(name)))}
    end
  end

  defp key("c"), do: "c, wasmtime"
  defp key(name), do: name

  # The WASI framing has a failure the Port's framing can't express: a length
  # that doesn't match the buffer. Wasmex takes an i32, so -1 is the length
  # 0xFFFFFFFF.
  defp extra("wasmex") do
    [
      {"talk_send past the talk_buffer allocation",
       fn session ->
         case Transport.Wasi.send_length(session.transport, -1) do
           {:ok, json} -> {session, %{JSON.decode!(json)["err"]["kind"] => 1}}
           {:error, reason} -> {session, %{"lost" => 1, "lostOn" => ["talk_send(0xFFFFFFFF): #{inspect(reason)}"]}}
         end
       end}
    ]
  end

  defp extra(_), do: []

  defp payload do
    path = TalkHost.Artifacts.wasm()
    bytes = File.read!(path)
    sha = :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

    # Erlang has no Brotli encoder, so this uses Brotli's CLI as the Go guide does.
    brotli =
      case System.find_executable("brotli") do
        nil ->
          nil

        exe ->
          {out, 0} = System.cmd(exe, ["--quality=11", "--lgwin=22", "--stdout", path])
          byte_size(out)
      end

    %{"sha256" => sha, "raw" => byte_size(bytes), "gzip9" => byte_size(:zlib.gzip(bytes)), "brotli11" => brotli}
  end

  defp environment do
    {cpu, 0} = System.cmd("sysctl", ["-n", "machdep.cpu.brand_string"])
    {os, 0} = System.cmd("sw_vers", ["-productVersion"])
    {go, 0} = System.cmd("go", ["env", "GOVERSION"])
    {commit, 0} = System.cmd("git", ["-C", TalkHost.Artifacts.root(), "rev-parse", "--short", "HEAD"])

    docker =
      case System.cmd(
             "docker",
             ["info", "--format", "{{.ServerVersion}} {{.OperatingSystem}} cgroup v{{.CgroupVersion}}"],
             stderr_to_stdout: true
           ) do
        {out, 0} -> String.trim(out)
        _ -> nil
      end

    {load, 0} = System.cmd("sysctl", ["-n", "vm.loadavg"])

    %{
      "date" => Date.utc_today() |> Date.to_iso8601(),
      "loadAverage" => load |> String.trim() |> String.trim("{ ") |> String.trim(" }"),
      "commit" => String.trim(commit),
      "cpu" => String.trim(cpu),
      "os" => "macOS " <> String.trim(os),
      "arch" => :erlang.system_info(:system_architecture) |> to_string(),
      "elixir" => System.version(),
      "otp" => :erlang.system_info(:otp_release) |> to_string(),
      "wasmex" => Application.spec(:wasmex, :vsn) |> to_string(),
      "wasmtime" => wasmtime_version(),
      "go" => String.trim(go),
      "docker" => docker
    }
  end

  defp wasmtime_version do
    Path.join(Mix.Project.deps_paths()[:wasmex], "native/wasmex/Cargo.toml")
    |> File.read!()
    |> then(&Regex.run(~r/^wasmtime = "([^"]+)"/m, &1, capture: :all_but_first))
    |> hd()
  end

  defp file_stem(env) do
    cpu = env["cpu"] |> String.downcase() |> String.replace(~r/[^a-z0-9]+/, "-")
    "#{env["date"]}-#{env["commit"]}-message-layer-elixir-darwin-arm64-#{cpu}"
  end
end
