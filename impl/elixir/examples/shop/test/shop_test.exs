defmodule ShopTest do
  use ExUnit.Case
  alias NorthTalk.ScriptError

  test "a quote crosses into Elixir and back" do
    assert {:ok, total} = Shop.quote("apple", 3)
    assert Decimal.equal?(total, Decimal.new("1.20"))
  end

  test "a Script reaches an Erlang function" do
    assert {:ok, :erlang.crc32("apple")} == Shop.tag("apple")
  end

  test "a declared failure raises in the Script and comes back as its error" do
    assert {:error, %ScriptError{error: %{"code" => "unknown sku"}}} = Shop.quote("plum", 1)
  end

  test "an order waits for the Warehouse to confirm it later" do
    assert {:ok, "R-" <> _} = Shop.order("pear", 1)
    assert {:error, %ScriptError{error: %{"code" => "out of stock"}}} = Shop.order("pear", 100)
  end

  test "a Function Value the Script returns is called from Elixir" do
    assert {:ok, total} = Shop.discounted(Decimal.new("20"), 10)
    assert Decimal.equal?(total, Decimal.new("18"))
  end
end
