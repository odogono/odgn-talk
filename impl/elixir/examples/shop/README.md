# Getting started: an OTP application with NorthTalk

`Shop` is a small OTP application that embeds NorthTalk through the [Elixir package](../../). Its Scripts price and reserve stock that ordinary Elixir state holds. It needs neither Go, Zig nor a sidecar: compiling the package fetches the pinned reactor release.

```sh
cd impl/elixir/examples/shop
mix deps.get
mix test
iex -S mix
```

```elixir
iex> Shop.quote("apple", 3)
{:ok, Decimal.new("1.20")}
iex> Shop.order("apple", 2)        # returns once the Warehouse confirms, about 20 ms later
{:ok, "R-1"}
iex> Shop.discounted(Decimal.new("20"), 10)
{:ok, 18}
```

## 1. Depend on the package

```elixir
# mix.exs
deps: [{:north_talk, path: "../.."}]
```

`mix compile` downloads `talk.wasm` from the release `NorthTalk.Artifact` pins and checks its SHA-256. To use a local build, set `NORTH_TALK_WASM` to its path.

## 2. Supervise an Instance Owner

[`Shop.Application`](lib/shop/application.ex) starts three children, `:rest_for_one`:

```elixir
children = [
  Shop.Warehouse,
  {NorthTalk, name: Shop.Talk},
  %{id: :load, start: {Shop, :start_load, []}}
]
```

`Shop.Talk` is one Instance Owner: one process holding one reactor instance. The `:load` child defines the Capability, grants it and loads the Script before `start_link` returns, then returns `:ignore`. If the owner stops, for example `{:shutdown, :trapped}` after a trap, the supervisor restarts it and loads everything again from source. The Script Variables don't survive a restart; to keep them, `NorthTalk.save/1` and `restore/4`.

## 3. Give Scripts an Elixir Capability

[`Shop.Stock`](lib/shop/stock.ex) declares each Operation, answered by the function of the same name. Each callback runs in its own Task, never in the owner:

```elixir
use NorthTalk.Capability, name: "stock"

operation "price", args: ["text"], result: "number", cost: 1, errors: [%{code: "unknown sku"}]
def price([sku], _call), do: ...                 # {:ok, value} or {:error, %{code: ...}}

operation "checksum", args: ["text"], result: "number", cost: 1
def checksum([text], _call), do: {:ok, :erlang.crc32(text)}
```

`Shop.load/0` gives it to the owner and grants it under the name the Script uses:

```elixir
:ok = NorthTalk.define_capability!(Shop.Talk, Shop.Stock)
grant = NorthTalk.grant!(Shop.Talk, Shop.Stock)
group = NorthTalk.new_group!(Shop.Talk, "shop", [])
"orders" = NorthTalk.load!(group, "orders", source, grants: %{"stock" => grant})
```

## 4. Call a Handler

`Shop.quote/2` goes Elixir → NorthTalk → Elixir → NorthTalk → Elixir:

```elixir
NorthTalk.request(group, "orders", "quote", ["apple", 3])
#=> {:ok, %NorthTalk.Result{value: Decimal.new("1.20"), report: %{"fuel" => ...}}}
```

```text
on quote sku, qty
  ask stock to price sku
  return it * qty
end quote
```

Numbers arrive as integers or `Decimal`s, never floats. A declared failure, such as `unknown sku`, raises in the Script; uncaught, it comes back as `{:error, %NorthTalk.ScriptError{}}`.

## 5. Defer an Operation

`reserve` is suspending. Its callback hands the work to `Shop.Warehouse` and returns `{:defer, ref}` at once. The Run waits, and the owner carries on with other work. About 20 ms later the Warehouse settles the call:

```elixir
def reserve([sku, qty], call) do
  ref = make_ref()
  Shop.Warehouse.reserve(sku, qty, call.owner, ref)
  {:defer, ref}
end

# in Shop.Warehouse, later:
NorthTalk.answer(owner, ref, "R-1")
NorthTalk.fail(owner, ref, %{code: "out of stock", message: "only 3 pear left"})
```

`Shop.order/2` returns when the Run ends, after the answer. A callback must not wait on a Run that needs its own call settled.

## 6. Use a Function Value

A Script can return a function. In Elixir it's a `NorthTalk.Function` handle bound to its Group, called with `NorthTalk.call/4` and held until `release/1`:

```elixir
{:ok, %NorthTalk.Result{value: discount}} = NorthTalk.request(group, "orders", "discounter", [10])
{:ok, %NorthTalk.Result{value: total}} = NorthTalk.call(group, discount, [Decimal.new("20")])
:ok = NorthTalk.release(discount)
```

## What it costs

[`bench/message-layer/elixir`](../../../../bench/message-layer/elixir/)'s `api` section measures these paths through `NorthTalk`. See the [package README](../../README.md#measurements) for the figures.
