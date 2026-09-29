# Runs a subset of the checks in Wasmex (Wasmtime inside the BEAM).
Mix.install([{:wasmex, "~> 0.15.1"}])

bytes = File.read!(Path.join(__DIR__, "out/spike.wasm"))
me = self()

imports = %{
  "host" => %{
    "op" => {:fn, [:i32], [:i32], fn _ctx, x -> send(me, {:op_in, self()}); x * 3 end},
    "reenter" =>
      {:fn, [:i32], [:i32],
       fn %{caller: caller, instance: instance}, x ->
         ref = make_ref()
         :ok = Wasmex.Instance.call_exported_function(caller, instance, "inner", [x], {self(), ref})
         receive do {^ref, {:ok, [v]}} -> v + 1 after 1000 -> raise "reentry timed out" end
       end},
    "emit" => {:fn, [:i32, :i32], [], fn %{memory: mem, caller: caller}, p, n ->
      IO.puts("emit " <> Wasmex.Memory.read_binary(caller, mem, p, n)) end}
  }
}

fresh = fn ->
  {:ok, pid} = Wasmex.start_link(%{bytes: bytes, imports: imports, wasi: true})
  {:ok, []} = Wasmex.call_function(pid, "_initialize", [])
  pid
end

check = fn name, f ->
  pid = fresh.()
  res = try do f.(pid) rescue e -> {:raised, Exception.message(e)} catch k, r -> {k, r} end
  IO.puts("## #{name}\n#{inspect(res)}\n")
end

check.("4 synchronous import", fn pid ->
  t = System.monotonic_time(:microsecond)
  r = Wasmex.call_function(pid, "call_op", [4])
  receive do {:op_in, p} -> IO.puts("import ran in #{inspect(p)}, GenServer #{inspect(pid)}") end
  n = 2000
  t0 = System.monotonic_time(:microsecond)
  for _ <- 1..n, do: {:ok, _} = Wasmex.call_function(pid, "call_op", [4])
  t1 = System.monotonic_time(:microsecond)
  for _ <- 1..n, do: {:ok, _} = Wasmex.call_function(pid, "inner", [4])
  t2 = System.monotonic_time(:microsecond)
  _ = t
  {r, per_export_us: (t2 - t1) / n, per_export_plus_import_us: (t1 - t0) / n}
end)
check.("4b reentrant export from inside an import", fn pid -> Wasmex.call_function(pid, "call_reenter", [4]) end)
check.("6 plain-data Run", fn pid ->
  :ok = elem(Wasmex.call_function(pid, "deliver", [5]), 0)
  {:ok, [p1]} = Wasmex.call_function(pid, "pump", [])
  {:ok, []} = Wasmex.call_function(pid, "answer", [p1, 37])
  {:ok, [p2]} = Wasmex.call_function(pid, "pump", [])
  {p1, p2}
end)
check.("1 export blocks on a channel", fn pid ->
  r = Wasmex.call_function(pid, "block_chan", [])
  {r, Process.alive?(pid)}
end)
