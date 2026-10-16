defmodule Shop.Stock do
  @moduledoc "The Capability the Scripts use to reach `Shop.Warehouse`."
  use NorthTalk.Capability, name: "stock"

  operation("price", args: ["text"], result: "number", cost: 1, errors: [%{code: "unknown sku"}])

  def price([sku], _call) do
    case Shop.Warehouse.price(sku) do
      {:ok, price} -> {:ok, price}
      :error -> {:error, %{code: "unknown sku", message: sku}}
    end
  end

  # An Erlang function, called straight from the callback.
  operation("checksum", args: ["text"], result: "number", cost: 1)
  def checksum([text], _call), do: {:ok, :erlang.crc32(text)}

  operation("count", args: ["text"], result: "number", cost: 1)
  def count([sku], _call), do: {:ok, Shop.Warehouse.count(sku)}

  # Genuinely deferred: the callback returns at once, and the Warehouse
  # answers the call later with NorthTalk.answer/3 or fail/3.
  operation("reserve",
    mode: :suspending,
    args: ["text", "number"],
    result: "text",
    cost: 5,
    errors: [%{code: "out of stock"}]
  )

  def reserve([sku, qty], call) do
    ref = make_ref()
    Shop.Warehouse.reserve(sku, qty, call.owner, ref)
    {:defer, ref}
  end
end
