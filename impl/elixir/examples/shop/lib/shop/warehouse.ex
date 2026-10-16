defmodule Shop.Warehouse do
  @moduledoc """
  Ordinary Elixir state the Scripts reach through `Shop.Stock`: prices,
  stock levels, and reservations that are confirmed later.
  """
  use GenServer

  @prices %{"apple" => Decimal.new("0.40"), "pear" => Decimal.new("0.55")}
  @confirm_after 20

  def start_link(_), do: GenServer.start_link(__MODULE__, %{"apple" => 10, "pear" => 3}, name: __MODULE__)

  def price(sku), do: Map.fetch(@prices, sku)
  def count(sku), do: GenServer.call(__MODULE__, {:count, sku})

  @doc "Asks for `qty` of `sku`; answers `ref` on `owner` once confirmed."
  def reserve(sku, qty, owner, ref), do: GenServer.cast(__MODULE__, {:reserve, sku, qty, owner, ref})

  @impl true
  def init(stock), do: {:ok, %{stock: stock, next: 1}}

  @impl true
  def handle_call({:count, sku}, _from, state), do: {:reply, Map.get(state.stock, sku, 0), state}

  # A reservation is confirmed a little later, as one from a real
  # warehouse would be.
  @impl true
  def handle_cast({:reserve, sku, qty, owner, ref}, state) do
    Process.send_after(self(), {:confirm, sku, qty, owner, ref}, @confirm_after)
    {:noreply, state}
  end

  @impl true
  def handle_info({:confirm, sku, qty, owner, ref}, state) do
    left = Map.get(state.stock, sku, 0)

    if left >= qty do
      id = "R-#{state.next}"
      NorthTalk.answer(owner, ref, id)
      {:noreply, %{state | stock: Map.put(state.stock, sku, left - qty), next: state.next + 1}}
    else
      NorthTalk.fail(owner, ref, %{code: "out of stock", message: "only #{left} #{sku} left"})
      {:noreply, state}
    end
  end
end
