defmodule NorthTalk.Clock do
  @moduledoc false
  # Clock readings as `$instant` text: RFC 3339 in UTC with the shortest
  # fraction (spec/09-embedding.md#json-and-the-value-encoding).

  @doc "A reading that never goes backwards: the wall clock at `start/0`, advanced by monotonic time."
  def start, do: {System.os_time(:microsecond), System.monotonic_time(:microsecond)}
  def now({wall, mono}), do: wall + System.monotonic_time(:microsecond) - mono

  def format(%DateTime{} = dt), do: dt |> DateTime.to_unix(:microsecond) |> format()

  def format(micros) when is_integer(micros) do
    {seconds, fraction} = {Integer.floor_div(micros, 1_000_000), Integer.mod(micros, 1_000_000)}
    base = seconds |> DateTime.from_unix!() |> DateTime.to_iso8601() |> String.trim_trailing("Z")

    case fraction |> Integer.to_string() |> String.pad_leading(6, "0") |> String.trim_trailing("0") do
      "" -> base <> "Z"
      digits -> base <> "." <> digits <> "Z"
    end
  end

  def parse(nil), do: nil

  def parse(text) do
    {:ok, dt, 0} = DateTime.from_iso8601(text)
    DateTime.to_unix(dt, :microsecond)
  end
end
