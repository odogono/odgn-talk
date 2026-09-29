# Per-crossing cost in Wasmex: an export alone, and an export that makes one import.
Mix.install([{:wasmex, "~> 0.15.1"}])
bytes = File.read!(Path.join(__DIR__, "out/spike.wasm"))
imports = %{"host" => %{
  "op" => {:fn, [:i32], [:i32], fn _ctx, x -> x * 3 end},
  "reenter" => {:fn, [:i32], [:i32], fn _c, x -> x end},
  "emit" => {:fn, [:i32, :i32], [], fn _c, _p, _n -> nil end}}}
{:ok, pid} = Wasmex.start_link(%{bytes: bytes, imports: imports, wasi: true})
{:ok, []} = Wasmex.call_function(pid, "_initialize", [])
time = fn name, args, timeout, n ->
  for _ <- 1..500, do: {:ok, _} = Wasmex.call_function(pid, name, args, timeout)
  t0 = System.monotonic_time(:nanosecond)
  for _ <- 1..n, do: {:ok, _} = Wasmex.call_function(pid, name, args, timeout)
  us = (System.monotonic_time(:nanosecond) - t0) / n / 1000
  IO.puts("#{name} timeout=#{inspect(timeout)}: #{Float.round(us, 1)} µs per call")
end
time.("inner", [4], :infinity, 5000)
time.("inner", [4], 5000, 5000)
time.("call_op", [4], :infinity, 5000)
