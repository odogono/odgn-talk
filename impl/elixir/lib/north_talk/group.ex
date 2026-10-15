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
