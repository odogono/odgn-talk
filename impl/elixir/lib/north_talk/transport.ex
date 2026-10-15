defmodule NorthTalk.Transport do
  @moduledoc """
  Carries Message Layer frames to one Core instance and back
  (spec/09-embedding.md#the-message-layer). Each frame is the JSON only; the
  transport adds its own framing.

  `exchange/2` returns `{:error, reason}` when the instance is lost: a Wasm
  trap, an exit or a timeout. It returns `{:refused, reason}` when the
  transport declines a frame before the Core sees it, such as `talk_buffer(0)`
  returning a null pointer, and the instance carries on.
  """

  @type t :: struct()

  @callback start(keyword()) :: {:ok, t()} | {:error, term()}
  @callback exchange(t(), binary()) :: {:ok, binary()} | {:refused, term()} | {:error, term()}
  @doc "The instance's memory: guest linear memory under WASI, RSS for a process."
  @callback memory_bytes(t()) :: non_neg_integer()
  @callback stop(t()) :: :ok

  def exchange(%mod{} = t, frame), do: mod.exchange(t, frame)
  def memory_bytes(%mod{} = t), do: mod.memory_bytes(t)
  def stop(%mod{} = t), do: mod.stop(t)
end
