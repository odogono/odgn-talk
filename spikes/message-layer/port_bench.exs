# Round trip of one {packet, 4} frame to a Go sidecar over an Erlang Port.
port = Port.open({:spawn_executable, Path.join(__DIR__, "out/sidecar")}, [:binary, {:packet, 4}, :exit_status])
msg = ~s({"m":"answer","call":"pricing/r1.c1","value":{"$quantity":["2.50","GBP"]}})
rt = fn -> send(port, {self(), {:command, msg}}); receive do {^port, {:data, _}} -> :ok end end
for _ <- 1..2000, do: rt.()
n = 20000
t0 = System.monotonic_time(:nanosecond)
for _ <- 1..n, do: rt.()
IO.puts("port round trip: #{Float.round((System.monotonic_time(:nanosecond) - t0) / n / 1000, 1)} µs")
{:os_pid, os_pid} = Port.info(port, :os_pid)
System.cmd("kill", ["-9", "#{os_pid}"])
receive do {^port, {:exit_status, s}} -> IO.puts("sidecar killed: port reports exit_status #{s}, BEAM alive") after 2000 -> IO.puts("no exit_status") end
