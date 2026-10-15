defmodule NorthTalk.TransportTest do
  use ExUnit.Case, async: true
  alias NorthTalk.Transport

  test "the reactor answers hello as the Zig Core" do
    {:ok, t} = Transport.Wasi.start()
    {:ok, reply} = Transport.exchange(t, ~s({"m":"hello","ref":1,"protocol":1}))
    assert %{"ok" => %{"core" => "zig/" <> _}} = :json.decode(reply)
    assert Transport.memory_bytes(t) > 0
    assert :ok = Transport.stop(t)
  end

  test "a zero-length buffer is refused and the instance carries on" do
    {:ok, t} = Transport.Wasi.start()
    assert {:refused, :null_buffer} = Transport.exchange(t, "")
    assert {:ok, _} = Transport.exchange(t, ~s({"m":"hello","ref":1,"protocol":1}))
    Transport.stop(t)
  end
end
