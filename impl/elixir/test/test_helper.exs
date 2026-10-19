ExUnit.start()

# Run the same Host suite with binary callbacks as well.
if System.get_env("NORTH_TALK_CALLBACKS") == "fields" do
  Application.put_env(:north_talk, :binary_callbacks, true)
end

defmodule NorthTalk.TestWire do
  @moduledoc false
  alias NorthTalk.Binary

  # Decodes a frame or reply in either encoding, as the owner reads it.
  def decode(bytes) do
    if Binary.binary?(bytes),
      do: Binary.decode(bytes),
      else: Jason.decode!(bytes, objects: :ordered_objects, floats: :decimals)
  end
end
