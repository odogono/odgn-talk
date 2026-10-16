defmodule Shop do
  @moduledoc """
  An OTP application that embeds NorthTalk. `Shop.Application` supervises
  the Instance Owner `Shop.Talk`, and `load/0` gives it the `Shop.Stock`
  Capability and the `orders` Script.

      iex> Shop.quote("apple", 3)
      {:ok, Decimal.new("1.20")}
      iex> Shop.order("apple", 2)
      {:ok, "R-1"}
  """

  @source """
  on quote sku, qty
    ask stock to price sku
    return it * qty
  end quote

  on order sku, qty
    ask stock to reserve sku, qty and wait
    return it
  end order

  on discounter percent
    return given total: total - total * percent / 100
  end discounter

  on tag sku
    ask stock to checksum sku
    return it
  end tag
  """

  @doc "Defines the Capability, grants it and loads the Script, in Group `shop`."
  def load do
    :ok = NorthTalk.define_capability!(Shop.Talk, Shop.Stock)
    grant = NorthTalk.grant!(Shop.Talk, Shop.Stock)
    group = NorthTalk.new_group!(Shop.Talk, "shop", [])
    "orders" = NorthTalk.load!(group, "orders", @source, grants: %{"stock" => grant})
    :persistent_term.put({__MODULE__, :group}, group)
  end

  @doc false
  def start_load do
    load()
    :ignore
  end

  defp group, do: :persistent_term.get({__MODULE__, :group})

  @doc "Elixir → NorthTalk → `Shop.Stock.price/2` → NorthTalk → Elixir."
  def quote(sku, qty), do: value(NorthTalk.request(group(), "orders", "quote", [sku, qty]))

  @doc "Elixir → NorthTalk → Erlang's `:erlang.crc32/1` → NorthTalk → Elixir."
  def tag(sku), do: value(NorthTalk.request(group(), "orders", "tag", [sku]))

  @doc "A Request that waits on a reservation the Warehouse confirms later."
  def order(sku, qty), do: value(NorthTalk.request(group(), "orders", "order", [sku, qty]))

  @doc "Returns a Function Value from the Script, calls it, then releases it."
  def discounted(total, percent) do
    with {:ok, discount} <- value(NorthTalk.request(group(), "orders", "discounter", [percent])) do
      result = value(NorthTalk.call(group(), discount, [total]))
      :ok = NorthTalk.release(discount)
      result
    end
  end

  defp value({:ok, %NorthTalk.Result{value: value}}), do: {:ok, value}
  defp value({:error, _} = error), do: error
end
