defmodule NorthTalk.ClockTest do
  use ExUnit.Case, async: true
  alias NorthTalk.Clock

  test "readings use the shortest fraction" do
    assert Clock.format(~U[1970-01-01 00:00:00.500000Z]) == "1970-01-01T00:00:00.5Z"
    assert Clock.format(~U[2026-10-10 12:00:00Z]) == "2026-10-10T12:00:00Z"
    assert Clock.format(~U[2026-10-10 12:00:00.000123Z]) == "2026-10-10T12:00:00.000123Z"
    assert Clock.parse("1970-01-01T00:00:00.5Z") == 500_000
  end
end
