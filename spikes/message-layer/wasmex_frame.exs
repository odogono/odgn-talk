# One JSON frame in and one out through linear memory, as a message-layer
# crossing would be in Wasmex: alloc export, write, frame export, read.
Mix.install([{:wasmex, "~> 0.15.1"}])
bytes = File.read!(Path.join(__DIR__, "out/spike.wasm"))
imports = %{"host" => %{
  "op" => {:fn, [:i32], [:i32], fn _ctx, x -> x * 3 end},
  "reenter" => {:fn, [:i32], [:i32], fn _c, x -> x end},
  "emit" => {:fn, [:i32, :i32], [], fn _c, _p, _n -> nil end}}}
{:ok, pid} = Wasmex.start_link(%{bytes: bytes, imports: imports, wasi: true})
{:ok, []} = Wasmex.call_function(pid, "_initialize", [])
{:ok, store} = Wasmex.store(pid)
{:ok, mem} = Wasmex.memory(pid)
msg = ~s({"m":"answer","call":"pricing/r1.c1","value":{"$quantity":["2.50","GBP"]}})
rt = fn ->
  {:ok, [p]} = Wasmex.call_function(pid, "alloc", [byte_size(msg)], :infinity)
  :ok = Wasmex.Memory.write_binary(store, mem, p, msg)
  {:ok, [r]} = Wasmex.call_function(pid, "frame", [byte_size(msg)], :infinity)
  <<ptr::32, len::32>> = <<r::unsigned-64>>
  Wasmex.Memory.read_binary(store, mem, ptr, len)
end
IO.puts(rt.())
for _ <- 1..500, do: rt.()
n = 5000
t0 = System.monotonic_time(:nanosecond)
for _ <- 1..n, do: rt.()
IO.puts("frame round trip: #{Float.round((System.monotonic_time(:nanosecond) - t0) / n / 1000, 1)} µs")
