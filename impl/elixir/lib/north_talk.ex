defmodule NorthTalk do
  @moduledoc """
  Embeds NorthTalk in an OTP application, through the Zig Core's WASI reactor
  in Wasmex.

  An Instance Owner is one process holding one reactor instance. It conducts
  every exchange with the instance, one at a time, and may drive several
  Script Groups. Independent owners run concurrently.

      {:ok, owner} = NorthTalk.start_link()
      {:ok, group} = NorthTalk.new_group(owner, "tenant-1")
      {:ok, "pricing"} = NorthTalk.load(group, "pricing", source)
      {:ok, %NorthTalk.Result{value: total}} = NorthTalk.request(group, "pricing", "total", [items])

  ## Driving

  By default an owner drives its Groups itself (`drive: :auto`): after each
  delivery it Pumps the Group, one Fuel Slice per Pump, until it is idle,
  and Pumps again at its next deadline. Each slice is a separate message to
  the owner, so other callers' work is interleaved, and other owners are
  never held up. The Clock reading is the wall clock when the owner started,
  advanced by monotonic time, so it never goes backwards.

  With `drive: :manual`, nothing Pumps until the caller calls `pump/2`, with
  its own Clock reading if it likes. A `request/5` then waits until a Pump
  ends its Run.

  ## Results

  Calls return `{:ok, _}` or `{:error, exception}`, where the exception is a
  `NorthTalk.HostError`, a `NorthTalk.LoadError` or, for a Run that didn't
  complete, a `NorthTalk.ScriptError`. The `!` variants raise it instead.
  Values convert as `NorthTalk.Value` describes.
  """

  alias NorthTalk.{Group, Library}

  @doc """
  Starts an Instance Owner, linked to the caller.

  Options:

    * `:name` - registers the owner.
    * `:drive` - `:auto` (the default) or `:manual`.
    * `:fuel_slice` - the Fuel one Pump may spend; 10,000 by default.
    * `:reports_to` - a pid sent `{:north_talk, group, report}` for every
      report a Pump returns.
    * `:path`, `:memory_cap`, `:timeout` - passed to `NorthTalk.Transport.Wasi`.
  """
  def start_link(opts \\ []), do: NorthTalk.Owner.start_link(opts)

  @doc "A child spec, so an owner can be supervised as `{NorthTalk, opts}`."
  def child_spec(opts) do
    %{id: Keyword.get(opts, :name, __MODULE__), start: {__MODULE__, :start_link, [opts]}}
  end

  @doc "Stops an owner, failing any request still waiting with `instance closed`."
  def close(owner), do: GenServer.stop(owner)

  @doc "The Core's versions and features from `hello`."
  def versions(owner), do: GenServer.call(owner, :versions)

  @doc "Makes a Script Group. `trace: true` records its Trace."
  def new_group(owner, name, opts \\ []), do: GenServer.call(owner, {:new_group, name, opts})

  @doc """
  Defines a Capability for this owner: a module that uses
  `NorthTalk.Capability`, or a `NorthTalk.Capability.from_functions/3` value.
  Every Group of the owner can then be granted it.
  """
  def define_capability(owner, capability), do: GenServer.call(owner, {:define_capability, capability})

  @doc """
  Grants some of a defined Capability's Operations. Returns a
  `NorthTalk.Grant` to pass to `load/4`.

  Options:

    * `:ops` - Operation names, or `:all` (the default).
    * `:binding` - any term, given to every call through the Grant as
      `NorthTalk.Call`'s `binding`.
  """
  def grant(owner, capability, opts \\ [])
  def grant(owner, name, opts) when is_binary(name), do: GenServer.call(owner, {:grant, name, opts})
  def grant(owner, capability, opts), do: grant(owner, NorthTalk.Capability.resolve(capability).name, opts)

  @doc """
  Answers a suspending call a callback deferred with `{:defer, ref}`.
  Returns `{:error, :unknown_ref}` when no call is waiting under `ref`: it was
  settled already, or abandoned on its Run's cancellation or deadline.
  """
  def answer(owner, ref, value), do: GenServer.call(owner, {:settle, ref, {:answer, value}})

  @doc """
  Fails a deferred call, as `answer/3` answers one. `failure` is a code, or
  `%{code: c, message: m, data: map}`.
  """
  def fail(owner, ref, failure), do: GenServer.call(owner, {:settle, ref, {:fail, failure}})

  @doc """
  Loads a Script into a Group. Returns its name, or a `NorthTalk.LoadError`.
  `grants:` maps each name the Script uses to a `NorthTalk.Grant`.
  """
  def load(%Group{owner: owner} = group, name, source, opts \\ []),
    do: GenServer.call(owner, {:load, group, name, source, opts})

  @doc """
  Compiles a Library. `imports:` lists the `NorthTalk.Library` values it uses.
  A Library is compiled once per owner and added to each Group that uses it.
  """
  def compile_library(owner, name, version, source, opts \\ []),
    do: GenServer.call(owner, {:compile_library, name, version, source, opts})

  @doc "Adds a compiled Library to a Group of the same owner."
  def add_library(%Group{owner: owner} = group, %Library{} = library),
    do: GenServer.call(owner, {:add_library, group, library})

  @doc """
  Delivers a message to a Script and returns once it is accepted, with its
  delivery id. Its Run ends later, in a Pump; `:reports_to` receives the
  report.
  """
  def deliver(%Group{owner: owner} = group, to, name, args \\ []),
    do: GenServer.call(owner, {:send, "deliver", group, to, name, args})

  @doc """
  Sends a message to a Script and waits until its Run ends. Returns its
  `NorthTalk.Result`, or a `NorthTalk.ScriptError` when the Run didn't
  complete. `timeout` bounds the wait, 5 s by default; a timeout exits the
  caller, and the Run carries on.
  """
  def request(%Group{owner: owner} = group, to, name, args \\ [], timeout \\ 5_000),
    do: GenServer.call(owner, {:send, "request", group, to, name, args}, timeout)

  @doc """
  Pumps a Group once. For `drive: :manual`; an automatic owner Pumps itself.
  Options: `:now`, a `DateTime` Clock reading, and `:fuel_slice`.
  Returns the Group's `state`, `next_deadline`, `fuel_used` and `reports`.
  """
  def pump(%Group{owner: owner} = group, opts \\ []), do: GenServer.call(owner, {:pump, group, opts})

  @doc """
  Stops a Script, as a queued Host Input: its Runs are discarded at the next
  Pump, its Grants released, and it takes no more messages.
  """
  def stop(%Group{owner: owner} = group, script, reason \\ "stopped"),
    do: GenServer.call(owner, {:stop, group, script, reason})

  @doc """
  Replaces a Script's code: its Runs are discarded, without `finally`, its
  live scopes abandoned and its Segment participant rolled back, its Grants
  released with reason `:reload`, then the new code takes over. Returns the
  reports for the Runs it discarded. A `NorthTalk.LoadError` leaves the
  Script unchanged.

  Options:

    * `:variables` - `:carry` (the default) carries over the Script Variables
      both versions declare; `:reset` starts from the new initialiser's.
    * `:keep_mailbox` - keeps the Script's queued messages for the new code.
  """
  def reload(%Group{owner: owner} = group, script, source, opts \\ []),
    do: GenServer.call(owner, {:reload, group, script, source, opts})

  @doc "Adds new Handlers, functions and Script Variables to a Script, leaving its running code alone."
  def extend(%Group{owner: owner} = group, script, source),
    do: GenServer.call(owner, {:extend, group, script, source})

  @doc """
  Replaces a Library in a Group with a newer compiled version, reloading
  every Script that imports it as `reload/4` does, all at once or not at
  all. Takes `reload/4`'s `:variables` option, and returns the reports.
  """
  def replace_library(%Group{owner: owner} = group, %Library{} = library, opts \\ []),
    do: GenServer.call(owner, {:replace_library, group, library, opts})

  @doc """
  Saves a Group, as bytes only a Zig Core reads. A save holds no Grant
  bindings, callbacks or waiting requests, and is refused with
  `effects pending` while a Capability Scope or Segment participant is live.
  """
  def save(%Group{owner: owner} = group), do: GenServer.call(owner, {:save, group})

  @doc """
  Restores a save as a new Group of this owner, named `name`. Returns a
  `NorthTalk.Restored`.

  Options:

    * `:grants` - each Script's Grants, as a map from `{script, grant name}`
      to a `NorthTalk.Grant` of this owner, or a function of the two names
      returning one or `nil`. A Grant not given restores revoked.
    * `:libraries` - the compiled `NorthTalk.Library` values the save uses.
    * `:mismatch` - `:reject` (the default) refuses a save whose versions,
      Libraries or Grants don't match with `save mismatch`;
      `:variables_only` keeps only its Script Variables.
    * `:trace` - records the new Group's Trace.

  Host Objects don't resolve yet, so each restores disposed.

  An automatic owner doesn't Pump the Group until every pending call is
  settled with `settle/3`, since its first Pump fails each call still
  unsettled with `call lost`. Requests waiting on the saved Group aren't
  carried over: `:reports_to` receives their Runs' reports.
  """
  def restore(owner, name, save, opts \\ []), do: GenServer.call(owner, {:restore, name, save, opts})

  @doc """
  Settles a restored Group's pending call, before its first Pump, with one of:

    * `{:answer, value}` or `{:fail, failure}` - as if the call had settled.
    * `:reissue` - calls the Operation's callback again, with the saved
      arguments, at the first Pump.
    * `{:adopt, ref}` - the Host still has the call in progress, and settles
      it later with `answer/3` or `fail/3` under `ref`.

  Settling a call that isn't pending, or settling twice, is `unknown call`.
  """
  def settle(%Group{owner: owner} = group, call, settlement),
    do: GenServer.call(owner, {:settle_restored, group, call, settlement})

  for {name, arity} <- [
        define_capability: 2,
        grant: 2,
        grant: 3,
        new_group: 3,
        load: 4,
        compile_library: 5,
        add_library: 2,
        deliver: 4,
        request: 5,
        pump: 2,
        stop: 3,
        reload: 4,
        extend: 3,
        replace_library: 3,
        save: 1,
        restore: 4,
        settle: 3
      ] do
    args = Macro.generate_arguments(arity, __MODULE__)

    @doc "Like `#{name}/#{arity}`, but raises the error."
    def unquote(:"#{name}!")(unquote_splicing(args)) do
      case unquote(name)(unquote_splicing(args)) do
        {:ok, value} -> value
        :ok -> :ok
        {:error, error} -> raise error
      end
    end
  end
end
