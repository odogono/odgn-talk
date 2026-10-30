defmodule NorthTalk.Group do
  @moduledoc """
  A handle to a Script Group inside one Instance Owner. Every call through it
  is routed to that owner.
  """
  @type t :: %__MODULE__{owner: pid(), name: String.t()}
  defstruct [:owner, :name]
end

defmodule NorthTalk.Library do
  @moduledoc """
  A compiled Library. `identity` is its code identity, as raw bytes in Base64,
  and `needs` are the Operations it calls.
  """
  defstruct [:name, :version, :identity, needs: []]
end

defmodule NorthTalk.Restored do
  @moduledoc """
  A restored Group: the `group`, whether the restore was `variables_only`,
  the Scripts a Partial Restore `reloaded`, in load order, its `pending`
  calls for `NorthTalk.settle/3`, as `NorthTalk.PendingCall`s, the
  `[kind, id]` of each Host Object that `disposed` on restore, and, for a
  variables-only or Partial Restore, its `discarded_runs`,
  `dropped_messages` and `abandoned_calls`.
  """
  defstruct [
    :group,
    :variables_only,
    reloaded: [],
    pending: [],
    disposed: [],
    discarded_runs: [],
    dropped_messages: [],
    abandoned_calls: []
  ]
end

defmodule NorthTalk.PendingCall do
  @moduledoc """
  A suspending call that hadn't been answered when its Group was saved: its
  `call` id, the `script` and `grant` name that made it, its `operation` and
  its `args`.
  """
  defstruct [:call, :script, :grant, :operation, args: []]
end

defmodule NorthTalk.Pending do
  @moduledoc """
  The admitted request of `NorthTalk.request_pump/5` or
  `NorthTalk.call_pump/4`: its Group, `delivery` id and handle. Await it with
  `NorthTalk.await/2` as often as you like; its result is kept until
  `NorthTalk.release_pending/1` or the Group closes.
  """
  @type t :: %__MODULE__{owner: pid(), group: String.t(), delivery: String.t(), id: reference()}
  defstruct [:owner, :group, :delivery, :id]
end

defmodule NorthTalk.Pumped do
  @moduledoc """
  An admitted combined call: its `pending` request, a `NorthTalk.Pending`,
  and its one Pump's outcome, `{:ok, result}` as `NorthTalk.pump/2` returns
  it, or `{:error, exception}` when the Pump was refused. A refused Pump
  leaves the request queued.
  """
  @type t :: %__MODULE__{pending: NorthTalk.Pending.t(), pump: {:ok, map()} | {:error, Exception.t()}}
  defstruct [:pending, :pump]
end
