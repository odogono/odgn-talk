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
  its `pending` calls for `NorthTalk.settle/3`, as `NorthTalk.PendingCall`s,
  the `[kind, id]` of each Host Object that `disposed` on restore, and, for a
  variables-only restore, its `discarded_runs`, `dropped_messages` and
  `abandoned_calls`.
  """
  defstruct [
    :group,
    :variables_only,
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
