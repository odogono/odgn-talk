defmodule NorthTalk.Group do
  @moduledoc "An opaque Group handle, routed through its Instance Owner."
  @enforce_keys [:owner, :id, :token]
  defstruct [:owner, :id, :token]
end

defmodule NorthTalk.Delivery do
  @moduledoc "Acceptance of a Delivery, before execution. Use `NorthTalk.await/1` for completion."
  @enforce_keys [:group, :id]
  defstruct [:group, :id]
end

defmodule NorthTalk.Result do
  @moduledoc "A terminal Handler outcome with its identity, value and execution reports."
  defstruct [:delivery, :run, :outcome, :value, :report, reports: []]
end
