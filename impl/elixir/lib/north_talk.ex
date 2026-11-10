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
    * `:limits` - the Script limits every `load/4` starts from, as
      `fuel_per_run:`, `alloc_per_run:`, `persistent_state:`, `call_depth:`,
      `pattern_size:`, `mailbox_depth:`, `max_wait_ms:`, `max_join:` and
      `cleanup_budget:` (spec/data/limits.toml). The Core's defaults apply
      to any not given.
    * `:binary_callbacks` - request `callbacks-fields-v1` when offered, false
      by default, as it measures slightly slower than JSON (#1316). Set true to exchange
      callback needs and results in binary frames.
      Defaults to the `:north_talk, :binary_callbacks` application setting.
    * `:memory_cap` - the most bytes guest linear memory may grow to.
      Unlimited by default.
    * `:timeout` - milliseconds one reactor call may run, 60 s by default.
    * `:path` - the reactor, passed to `NorthTalk.Transport.Wasi`.

  A trap or a timeout poisons the instance: the owner fails every waiting
  request with `instance trapped` and stops with `{:shutdown, :trapped}`.
  Nothing is retried. To carry on, start a new owner and restore a save
  kept from before.
  """
  def start_link(opts \\ []), do: NorthTalk.Owner.start_link(opts)

  @doc "A child spec, so an owner can be supervised as `{NorthTalk, opts}`."
  def child_spec(opts) do
    %{id: Keyword.get(opts, :name, __MODULE__), start: {__MODULE__, :start_link, [opts]}}
  end

  @doc "Stops an owner, failing any request still waiting with `instance closed`."
  def close(owner), do: GenServer.stop(owner)

  @doc """
  The instance's memory in bytes: `:linear` is the guest's linear memory,
  which `:memory_cap` bounds; `:host` is the whole BEAM's, from
  `:erlang.memory(:total)`, which excludes linear memory.
  """
  def memory(owner), do: GenServer.call(owner, :memory)

  @doc "The Core's versions and features from `hello`."
  def versions(owner), do: GenServer.call(owner, :versions)

  @doc """
  Makes a Script Group. `trace: true` records its Trace, and `seed:`, a
  whole number from 0 to 2^64 - 1, seeds the generator `random` draws from
  (0 without one). `musical_clock:` is a `NorthTalk.Grant` of a Capability
  `NorthTalk.Capability.musical_clock/2` made: every Script of the Group
  holds it as `musical-clock`, and `wait 8 bars` calls its `wait`. Without
  one, a `wait` in bars or beats raises `no musical time`.
  """
  def new_group(owner, name, opts \\ []), do: GenServer.call(owner, {:new_group, name, opts})

  @doc """
  Defines a Capability for this owner: a module that uses
  `NorthTalk.Capability`, or a `NorthTalk.Capability.from_functions/3` value.
  Every Group of the owner can then be granted it.
  """
  def define_capability(owner, capability), do: GenServer.call(owner, {:define_capability, capability})

  @doc """
  Defines an Object Kind, a `NorthTalk.ObjectKind`, for this owner. Every
  Group of the owner can then make Host Objects of it. Defining the same Kind
  again is `:ok`; another Kind under its name is `invalid value`, as is a
  collection when the reactor lacks `object-elements-v1`. `object/5` defines
  its Kind if needed, but a restore can resolve only Objects of Kinds already
  defined.
  """
  def define_object_kind(owner, %NorthTalk.ObjectKind{} = kind),
    do: GenServer.call(owner, {:define_object_kind, kind})

  @doc """
  Makes a Host Object of `kind` in a Group, with an `id` unique for its Kind
  in that Group, and returns its `NorthTalk.Object` handle. `native` is any
  term, given to the Kind's callbacks; the owner keeps it until the Group
  closes. `parent:` sets the Object's parent, another Object of the Group, on
  its Message Path. A reused id, even of a disposed Object, is `duplicate
  object id`.
  """
  def object(%Group{owner: owner} = group, %NorthTalk.ObjectKind{} = kind, id, native, opts \\ [])
      when is_binary(id),
      do: GenServer.call(owner, {:object, group, kind, id, native, opts})

  @doc "The handle of a Group's Host Object by its Kind's name and id, or `:error`."
  def object_by_id(%Group{owner: owner} = group, kind, id), do: GenServer.call(owner, {:object_by_id, group, kind, id})

  @doc "Sets a Host Object's parent on its Message Path, or clears it with `nil`."
  def set_parent(%Group{owner: owner} = group, %NorthTalk.Object{} = object, parent),
    do: GenServer.call(owner, {:set_parent, group, object, parent})

  @doc """
  Disposes of a Host Object. Sending to it, or reading or setting a
  property of it, then raises `object gone`, and its Owning Script stops.
  """
  def dispose(%Group{owner: owner} = group, %NorthTalk.Object{} = object),
    do: GenServer.call(owner, {:dispose, group, object, nil})

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
  `grants:` maps each name the Script uses to a `NorthTalk.Grant`, except the
  reserved `musical-clock`, which is the Group's own, and
  `limits:` overrides the owner's `:limits` for this Script. `owner:` makes the
  Script the Owning Script of a Host Object of the Group, its `me`, and `objects:` maps names
  the Script uses to Host Objects of the Group.
  """
  def load(%Group{owner: owner} = group, name, source, opts \\ []),
    do: GenServer.call(owner, {:load, group, name, source, opts})

  @doc """
  Compiles a Library. `imports:` lists the `NorthTalk.Library` values it uses,
  and `capabilities:` the defined Capabilities its functions may call with
  their caller's Grants: each a name, granted under that name, or
  `{grant, capability}`. A Library is compiled once per owner and added to
  each Group that uses it.
  """
  def compile_library(owner, name, version, source, opts \\ []),
    do: GenServer.call(owner, {:compile_library, name, version, source, opts})

  @doc "Adds a compiled Library to a Group of the same owner."
  def add_library(%Group{owner: owner} = group, %Library{} = library),
    do: GenServer.call(owner, {:add_library, group, library})

  @doc """
  Delivers a message to a Script or a Host Object and returns once it is accepted, with its
  delivery id. Its Run ends later, in a Pump; `:reports_to` receives the
  report.
  """
  def deliver(%Group{owner: owner} = group, to, name, args \\ []),
    do: GenServer.call(owner, {:send, "deliver", group, to, name, args})

  @doc """
  Broadcasts a message to every Script in the Group that currently wants it,
  through a Handler for it or a pending `wait for`, and returns once it is
  accepted, with its delivery id. A Broadcast never climbs a Message Path.
  """
  def broadcast(%Group{owner: owner} = group, name, args \\ []),
    do: GenServer.call(owner, {:send, "broadcast", group, nil, name, args})

  @doc """
  Asks a Script or a Host Object, by a Decision, whether something may
  happen. Returns a `NorthTalk.Pending` at once; `await/2` gives
  `{:ok, %NorthTalk.Verdict{}}` once the first deciding Run seals it, at the
  end of its first Segment. The Decision climbs a Message Path as a Request
  does, and one that reaches its end is allowed.
  """
  def decide(%Group{owner: owner} = group, to, name, args \\ []),
    do: GenServer.call(owner, {:decide, group, to, name, args})

  @doc """
  Asks every Script that wants the message, as `broadcast/3` sends it, by one
  Decision. It is vetoed if any recipient vetoes, undecided if none does but
  one is undecided, and allowed otherwise, including with no recipients.
  """
  def decide_broadcast(%Group{owner: owner} = group, name, args \\ []),
    do: GenServer.call(owner, {:decide, group, :broadcast, name, args})

  @doc """
  Sends a message to a Script or a Host Object and waits until the Run that
  answers it ends, after it climbs any Message Path. Returns its
  `NorthTalk.Result`, or a `NorthTalk.ScriptError` when the Run didn't
  complete, of outcome `"unhandled"` when no Handler took it. `timeout` bounds the wait, 5 s by default; a timeout exits the
  caller, and the Run carries on.
  """
  def request(%Group{owner: owner} = group, to, name, args \\ [], timeout \\ 5_000),
    do: GenServer.call(owner, {:send, "request", group, to, name, args}, timeout)

  @doc """
  Sends a message as `request/5` does, but returns its `NorthTalk.Pending` as
  soon as it is admitted, with its delivery id, before any Run starts.
  `await/2` gives what `request/5` would. An automatic owner Pumps on its
  own; under manual drive nothing runs until the caller Pumps. An admission
  refusal is `{:error, exception}`, with no handle. Use it when the Host needs
  the delivery id before the Run; otherwise `request_pump/5` saves an exchange.
  """
  def send_request(%Group{owner: owner} = group, to, name, args \\ []),
    do: GenServer.call(owner, {:send, :handle, group, to, name, args})

  @doc """
  Calls a Function Value a Script gave the Host, through its own Group, and
  waits until its Run ends, as `request/5` does. A handle of another Group,
  or one released, is a `NorthTalk.HostError`: `wrong group` or `function
  released`. A call through a closed owner is `instance closed`.
  """
  def call(%Group{owner: owner} = group, %NorthTalk.Function{} = fun, args \\ [], timeout \\ 5_000) do
    GenServer.call(owner, {:call, group, fun, args}, timeout)
  catch
    # A timeout still exits the caller, as a request's does.
    :exit, reason ->
      if Process.alive?(owner),
        do: exit(reason),
        else: {:error, %NorthTalk.HostError{code: "instance closed", detail: "#{inspect(owner)} is not running"}}
  end

  @doc """
  Sends a message to a Script and Pumps its Group once, in one exchange,
  under either drive. An admission refusal is `{:error, exception}`, with no
  handle and no Pump. Once admitted, it returns `{:ok, %NorthTalk.Pumped{}}`
  holding the request's `NorthTalk.Pending` and the Pump's outcome; a refused
  Pump leaves the request queued. Earlier inputs run first, and the Run may
  still be going after the Pump; an automatic owner Pumps on afterwards.

  Options: `:now`, a `DateTime` Clock reading, and `:fuel_slice`, as for
  `pump/2`. A reactor without `request-pump-fields-v1` refuses it before
  admission with `invalid value`; `request/5` and `pump/2` still work there.
  """
  def request_pump(%Group{owner: owner} = group, to, name, args \\ [], opts \\ []),
    do: GenServer.call(owner, {:pumped, "request-pump", group, {to, name, args}, opts})

  @doc """
  Calls a Function Value and Pumps its Group once, as `request_pump/5` sends
  a message. A stale Function Value fails its Run, not the admission.
  """
  def call_pump(%Group{owner: owner} = group, %NorthTalk.Function{} = fun, args \\ [], opts \\ []),
    do: GenServer.call(owner, {:pumped, "call-pump", group, {fun, args}, opts})

  @doc """
  Waits up to `timeout` ms for a pending request's Run to end, returning what
  `request/5` would. It can be awaited again, and returns the same result.
  A timeout is a `NorthTalk.HostError` with code `timeout`, and the Run carries
  on. A released handle is `pending released`.
  """
  def await(%NorthTalk.Pending{owner: owner} = pending, timeout \\ 5_000) do
    GenServer.call(owner, {:await, pending, timeout}, :infinity)
  catch
    :exit, _ -> {:error, %NorthTalk.HostError{code: "instance closed", detail: "#{inspect(owner)} is not running"}}
  end

  @doc """
  Releases a pending request: discards its result and fails its awaiters,
  now and later, with `pending released`. The request is not cancelled.
  Releasing it twice, or through a closed owner, does nothing.
  """
  def release_pending(%NorthTalk.Pending{owner: owner} = pending) do
    GenServer.call(owner, {:release_pending, pending})
  catch
    :exit, _ -> :ok
  end

  @doc """
  Checks `value` against `shape`, a Shape in the Host Manifest's data
  spelling (`"text"`, `%{"list" => "number"}`, …), with a Capability
  argument's acceptance (ADR 0176). Returns `{:ok, true}` exactly when it fits.

  The check is pure: it charges nothing and writes no Trace. Pass a Group
  instead of an owner when `value` holds that Group's Host Objects or
  Function Values. A malformed Shape is `invalid value`.
  """
  def conforms(owner_or_group, value, shape) do
    with {:ok, report} <- explain(owner_or_group, value, shape), do: {:ok, report == []}
  end

  @doc """
  The `explain` Built-in's report for `value` against `shape`: a list of
  mismatch maps (`code`, `expected`, `got`, `value`, `path`, `alternatives`),
  empty when it fits. Takes what `conforms/3` takes.
  """
  def explain(%Group{owner: owner} = group, value, shape), do: GenServer.call(owner, {:explain, group, value, shape})
  def explain(owner, value, shape), do: GenServer.call(owner, {:explain, nil, value, shape})

  @doc """
  Releases a Function Value handle. Later use of it is `function released`.
  Releasing it twice, or through a closed owner, does nothing. A Group's or
  owner's handles are all released when it closes; there are no finalisers.
  """
  def release(%NorthTalk.Function{owner: owner} = fun) do
    GenServer.call(owner, {:release, fun})
  catch
    :exit, _ -> :ok
  end

  @doc """
  Closes a Group on the Host's side: releases its Function Values, fails its
  waiting requests and stops Pumping it. Later calls through it are a
  `NorthTalk.HostError` with code `group closed`. The Core has no message
  that frees a Group, so its state stays in the instance until the owner
  closes.
  """
  def close_group(%Group{owner: owner} = group), do: GenServer.call(owner, {:close_group, group})

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
  all. Takes `reload/4`'s `:variables` and `:keep_mailbox` options, and
  returns the reports.
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
    * `:musical_clock` - the new Group's musical clock, as for
      `new_group/3`. A save's `musical-clock` Grant restores to it, never to
      `:grants`, and restores revoked without one.
    * `:libraries` - the compiled `NorthTalk.Library` values the save uses.
    * `:mismatch` - `:reject` (the default) refuses a save whose versions,
      Libraries or Grants don't match with `save mismatch`;
      `:variables_only` keeps only its Script Variables; `:reload_changed`
      continues the Scripts whose code matches and reloads the others, a
      Partial Restore, when only Script code differs, and is variables-only
      otherwise.
    * `:keep_mailbox` - with `:reload_changed`, keeps each reloaded Script's
      mailbox for its new code, so a Request's sender goes on waiting
      instead of failing. Ignored by other restores.
    * `:trace` - records the new Group's Trace.

    * `:resolve_object` - a function of a saved Host Object's Kind name and
      id, returning `{:ok, native}` to restore it live or `:error` to restore
      it disposed. Its Kind must be defined already. Without it, every Host
      Object restores disposed.

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
        define_object_kind: 2,
        object: 4,
        object: 5,
        set_parent: 3,
        dispose: 2,
        grant: 2,
        grant: 3,
        new_group: 3,
        load: 4,
        compile_library: 5,
        add_library: 2,
        deliver: 4,
        broadcast: 3,
        decide: 4,
        decide_broadcast: 3,
        request: 5,
        send_request: 4,
        pump: 2,
        stop: 3,
        reload: 4,
        extend: 3,
        replace_library: 3,
        save: 1,
        restore: 4,
        settle: 3,
        call: 4,
        request_pump: 5,
        call_pump: 4,
        await: 2,
        close_group: 1
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
