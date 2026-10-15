defmodule TalkHost.Transport do
  @moduledoc """
  The transports this Host measures: `NorthTalk.Transport.Wasi` from the
  library, and the Port-based `Sidecar` and `Bridge` here, which implement
  `NorthTalk.Transport`.

  The fault suite counts `{:error, reason}` from `exchange/2` as a lost
  instance: a Wasm trap, a sidecar exit or a timeout.
  """

  defdelegate exchange(t, frame), to: NorthTalk.Transport
  defdelegate memory_bytes(t), to: NorthTalk.Transport
  defdelegate stop(t), to: NorthTalk.Transport
end
