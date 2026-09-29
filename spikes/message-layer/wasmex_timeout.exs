# What a Wasmex call timeout does to a Go reactor.
Mix.install([{:wasmex, "~> 0.15.1"}])
bytes = File.read!(Path.join(__DIR__, "out/spike.wasm"))
imports = %{"host" => %{
  "op" => {:fn, [:i32], [:i32], fn _ctx, x -> x * 3 end},
  "reenter" => {:fn, [:i32], [:i32], fn _c, x -> x end},
  "emit" => {:fn, [:i32, :i32], [], fn _c, _p, _n -> nil end}}}
{:ok, pid} = Wasmex.start_link(%{bytes: bytes, imports: imports, wasi: true})
{:ok, []} = Wasmex.call_function(pid, "_initialize", [])
IO.inspect((try do Wasmex.call_function(pid, "spin", [], 200) catch :exit, e -> {:exit, e} end), label: "spin with a 200 ms timeout")
Process.sleep(300)
IO.inspect(Process.alive?(pid), label: "GenServer alive")
IO.inspect(Wasmex.call_function(pid, "inner", [4]), label: "next call")
IO.inspect(Wasmex.call_function(pid, "yield_some", [3]), label: "call that enters the scheduler")
