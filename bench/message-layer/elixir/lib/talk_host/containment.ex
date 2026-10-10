defmodule TalkHost.Containment do
  @moduledoc """
  A Script that allocates without bound must end in a Limit Fault, never in
  the instance running out of memory (#532).

  Under WASI the cap is Wasmex's `StoreLimits` on linear memory. For the
  sidecar it is a cgroup memory limit, by running the Linux build of the
  sidecar in a container with `docker run --memory`.

  Each profile pairs the Script's limits with a memory cap: the default limit
  profile under a small cap, and the conformance minimums, the largest values
  every Core must honour, under a larger one. Each Script also runs without a
  cap, to show how much memory it reaches before its Limit Fault.

  Every Script runs on a fresh instance, so a loss doesn't spill into the
  next one, and the memory observed belongs to that Script.
  """
  alias TalkHost.{Faults, Transport}

  @mib 1024 * 1024

  def profiles do
    [
      %{
        "name" => "default limits",
        "cap" => 128 * @mib,
        "perRun" => 1_000,
        "limits" => %{"fuelPerRun" => 1_000_000_000}
      },
      %{
        "name" => "conformance minimum limits",
        "cap" => 1024 * @mib,
        "perRun" => 10_000,
        "limits" => %{"fuelPerRun" => 1_000_000_000, "allocPerRun" => 268_435_456, "persistentState" => 67_108_864}
      }
    ]
  end

  @scripts [{"a growing List", "hog"}, {"doubling text", "double"}, {"a growing Script Variable", :hoard}]

  def wasi(reps) do
    run(reps, fn cap ->
      start = fn -> Transport.Wasi.start(memory_cap: cap) end

      observe = fn t ->
        fatal = Regex.run(~r/^runtime: out of memory.*$|^fatal error: .*$/m, Transport.Wasi.stderr(t))
        %{"linearMemoryBytes" => Transport.memory_bytes(t), "fatal" => fatal && hd(fatal)}
      end

      {start, observe}
    end)
  end

  def sidecar(reps) do
    run(reps, fn cap ->
      name = "talk-containment-#{System.unique_integer([:positive])}"
      memory = if cap, do: ["--memory", "#{cap}", "--memory-swap", "#{cap}"], else: []
      dir = Path.dirname(TalkHost.Artifacts.linux_sidecar())

      command =
        ["docker", "run", "-i", "--name", name] ++
          memory ++ ["-v", "#{dir}:/w:ro", "busybox:1.37", "/w/" <> Path.basename(TalkHost.Artifacts.linux_sidecar())]

      start = fn -> Transport.Sidecar.start(command: command, timeout: 300_000) end

      # The container is kept after it exits, so a kill can be read back.
      observe = fn _ ->
        observed =
          case System.cmd("docker", ["exec", name, "cat", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.events"],
                 stderr_to_stdout: true
               ) do
            {out, 0} ->
              [peak | events] = String.split(out, "\n", trim: true)
              %{"cgroupPeakBytes" => String.to_integer(peak), "cgroupEvents" => events}

            {_, _} ->
              {out, 0} = System.cmd("docker", ["inspect", "-f", "{{.State.OOMKilled}} {{.State.ExitCode}}", name])
              [oom, code] = String.split(String.trim(out))
              %{"exited" => %{"oomKilled" => oom == "true", "exitCode" => String.to_integer(code)}}
          end

        System.cmd("docker", ["rm", "-f", name], stderr_to_stdout: true)
        observed
      end

      {start, observe}
    end)
  end

  defp run(reps, instance) do
    for profile <- profiles(), cap <- [nil, profile["cap"]] do
      IO.puts(:stderr, "  #{profile["name"]}, #{if cap, do: "#{div(cap, @mib)} MiB cap", else: "no cap"}")

      cases =
        for {name, handler} <- @scripts do
          {start, observe} = instance.(cap)
          session = Faults.fresh_session(start)

          {session, outcomes} =
            case handler do
              :hoard -> Faults.hoard_case(session, reps, profile["limits"], profile["perRun"])
              handler -> Faults.contained(session, handler, profile["limits"], reps)
            end

          # Observe before the health check, which a lost instance would fail.
          observed = observe.(session.transport)
          {health, session} = if outcomes["lost"], do: {:lost, session}, else: Faults.health_check(session)
          Transport.stop(session.transport)

          %{
            "case" => name,
            "outcomes" => outcomes,
            "healthy" => health == :ok,
            "observed" => observed
          }
        end

      profile |> Map.put("cap", cap) |> Map.put("cases", cases)
    end
  end
end
