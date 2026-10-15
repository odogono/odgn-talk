defmodule NorthTalk.Map do
  @moduledoc """
  A NorthTalk map, in insertion order. Keys are text.

  Elixir maps don't keep order, so every map a Script returns arrives as this
  struct. A plain Elixir map with at most one key is accepted on input, since
  it has only one order.
  """

  @type t :: %__MODULE__{entries: [{String.t(), term()}]}
  defstruct entries: []

  @doc "A map with these entries, in this order."
  def new(entries \\ []), do: %__MODULE__{entries: Enum.to_list(entries)}

  @doc "The value under `key`, or `default`."
  def get(%__MODULE__{entries: entries}, key, default \\ nil) do
    case List.keyfind(entries, key, 0) do
      {_, value} -> value
      nil -> default
    end
  end

  def keys(%__MODULE__{entries: entries}), do: Enum.map(entries, &elem(&1, 0))
end
