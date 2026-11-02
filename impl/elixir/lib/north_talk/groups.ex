defmodule NorthTalk.Groups do
  @moduledoc """
  Supervises long-lived Script Groups, such as tenants, rooms or sessions,
  each in its own Instance Owner and reactor instance, found by a key.

      children = [{NorthTalk.Groups, name: MyApp.Groups, notify: MyApp.Watcher}]

      init = fn owner, key ->
        with {:ok, group} <- NorthTalk.new_group(owner, key),
             {:ok, _} <- NorthTalk.load(group, "room", source) do
          {:ok, group}
        end
      end

      {:ok, group} = NorthTalk.Groups.start_group(MyApp.Groups, "room-1", init)
      {:ok, group} = NorthTalk.Groups.lookup(MyApp.Groups, "room-1")
      :ok = NorthTalk.Groups.stop_group(MyApp.Groups, "room-1")

  This is optional: `NorthTalk.start_link/1` and `NorthTalk.new_group/3`
  still make an owner that drives several Groups.

  ## Initialization

  The initialization function is called as `init.(owner, key)` in a process
  of its own, never inside the owner or on a supervisor's start path, so a
  slow load or restore holds up no other group. It configures the new owner
  (Capabilities, Object Kinds, Grants, Libraries), makes the group's one
  Script Group, loads Scripts or restores a save, and returns
  `{:ok, %NorthTalk.Group{}}` for a Group of that owner. Anything else, a
  raise or exit, or running past `:init_timeout`, is an initialization
  failure: the group's owner and every process of it are stopped.

  It runs again, against a fresh owner, after every restart. Whether the
  group starts fresh or restores the application's last save is the
  function's choice; nothing is saved or replayed for it. A restored pending
  call can be settled with `:reissue` through `NorthTalk.settle/3`, but only
  if the function does so.

  ## Lookup and stale handles

  `lookup/2` returns the current Group only once its initialization has
  succeeded, and `:error` while it is starting, restarting or stopped.
  Handles stay bound to the instance they came from and are never
  redirected. After a restart the old owner is gone, so a call through an
  old Group, Function, Object or pending handle exits with `:noproc`, as a
  `GenServer.call/3` to a dead process does. Reacquire the Group with
  `lookup/2`, and any handles from it.

  ## Restarts

  Any exit of the owner, including `{:shutdown, :trapped}` after a WASM trap
  or timeout, restarts the group by default, and so does a failed
  initialization after a restart. Each group has its own budget of
  `:max_restarts` in `:max_seconds` (3 in 5 by default); `restart: :never`
  sets it to 0. A group that exhausts it stops alone, and the `:notify`
  process is sent `{:north_talk_group, key, {:stopped, :restarts_exhausted}}`.
  Other groups are never affected.
  """

  use Supervisor

  alias NorthTalk.Groups.{Member, Watcher}

  @doc """
  Starts the groups supervisor. Options:

    * `:name` - required; the name `start_group/4` and the other calls take.
    * `:notify` - a pid or name sent `{:north_talk_group, key, event}`,
      where `event` is `{:ready, group}` after every successful
      initialization, or `{:stopped, reason}` when a group stops without
      `stop_group/2`: `{:init_failed, reason}` or `:restarts_exhausted`.
  """
  def start_link(opts) do
    name = Keyword.fetch!(opts, :name)
    Supervisor.start_link(__MODULE__, opts, name: name)
  end

  @impl true
  def init(opts) do
    name = Keyword.fetch!(opts, :name)

    children = [
      {Registry, keys: :unique, name: registry(name)},
      {Watcher, name: watcher(name), notify: opts[:notify]},
      {DynamicSupervisor, name: members(name), strategy: :one_for_one}
    ]

    Supervisor.init(children, strategy: :one_for_all)
  end

  @doc """
  Starts the group `key` and waits until its initialization ends. Returns
  `{:ok, group}`, `{:error, :already_started}` when the key has a group,
  starting or ready, or `{:error, reason}` when it failed to start, after
  everything it started has stopped. Options:

    * `:owner` - options for `NorthTalk.start_link/1`, except `:name`.
    * `:init_timeout` - milliseconds the initialization may take, 30 s by default.
    * `:restart` - `:always` (the default) or `:never`.
    * `:max_restarts`, `:max_seconds` - this group's restart budget, 3 in 5 s.
  """
  def start_group(groups, key, init, opts \\ []) when is_function(init, 2) do
    reply = Process.alias()

    spec = %{
      id: key,
      start: {Member, :start_link, [{groups, key, init, opts, reply}]},
      restart: :temporary,
      type: :supervisor
    }

    try do
      case DynamicSupervisor.start_child(members(groups), spec) do
        {:ok, member} ->
          Watcher.watch(watcher(groups), member, key)
          await(groups, member, reply)

        {:error, {:already_started, member}} ->
          if Process.alive?(member) do
            {:error, :already_started}
          else
            # A group just stopped, and the Registry hasn't forgotten it yet.
            Process.sleep(1)
            start_group(groups, key, init, opts)
          end

        {:error, {:shutdown, {:failed_to_start_child, _, reason}}} ->
          {:error, reason}

        {:error, reason} ->
          {:error, reason}
      end
    after
      Process.unalias(reply)
    end
  end

  defp await(groups, member, reply) do
    monitor = Process.monitor(member)

    receive do
      {^reply, {:ok, _} = ok} ->
        Process.demonitor(monitor, [:flush])
        ok

      {^reply, {:error, reason} = error} ->
        # Returns only once nothing of the group is left.
        stop_member(groups, member, {:init_failed, reason})
        Process.demonitor(monitor, [:flush])
        error

      {:DOWN, ^monitor, :process, _, _} ->
        receive do
          {^reply, result} -> result
        after
          0 -> {:error, :restarts_exhausted}
        end
    end
  end

  @doc "The ready Group for `key`, or `:error`."
  def lookup(groups, key) do
    case Registry.lookup(registry(groups), {:ready, key}) do
      # The Registry forgets a stopped process a moment after it exits.
      [{initializer, group}] -> if Process.alive?(initializer), do: {:ok, group}, else: :error
      [] -> :error
    end
  end

  @doc """
  Stops the group `key` and releases its reactor instance, without
  restarting it. Returns `{:error, :not_found}` for an unknown key.
  `NorthTalk.close_group/1` still only releases one Group's handles.
  """
  def stop_group(groups, key) do
    case Registry.lookup(registry(groups), {:member, key}) do
      [{member, _}] -> stop_member(groups, member)
      [] -> {:error, :not_found}
    end
  end

  @doc "The keys of every group, starting or ready."
  def keys(groups) do
    registry(groups)
    |> Registry.select([{{{:member, :"$1"}, :"$2", :_}, [], [{{:"$1", :"$2"}}]}])
    |> Enum.flat_map(fn {key, member} -> if Process.alive?(member), do: [key], else: [] end)
  end

  @doc false
  def stop_member(groups, member, reason \\ nil) do
    Watcher.expect(watcher(groups), member, reason)

    case DynamicSupervisor.terminate_child(members(groups), member) do
      :ok -> :ok
      {:error, :not_found} -> {:error, :not_found}
    end
  end

  @doc false
  def registry(groups), do: Module.concat(groups, Registry)
  @doc false
  def members(groups), do: Module.concat(groups, Members)
  @doc false
  def watcher(groups), do: Module.concat(groups, Watcher)
end

defmodule NorthTalk.Groups.Member do
  @moduledoc false
  # One group: its owner, then the process that initializes it, restarted
  # together within the group's own budget.
  use Supervisor

  alias NorthTalk.Groups

  def start_link({groups, key, _init, _opts, _reply} = args) do
    Supervisor.start_link(__MODULE__, args, name: {:via, Registry, {Groups.registry(groups), {:member, key}}})
  end

  @impl true
  def init({groups, key, init, opts, reply}) do
    owner_name = {:via, Registry, {Groups.registry(groups), {:owner, key}}}
    owner_opts = opts |> Keyword.get(:owner, []) |> Keyword.put(:name, owner_name)

    children = [
      %{id: :owner, start: {NorthTalk.Owner, :start_link, [owner_opts]}, restart: :permanent},
      %{
        id: :initializer,
        start: {Groups.Initializer, :start_link, [{groups, key, init, opts, reply, owner_name}]},
        restart: :permanent
      }
    ]

    max_restarts =
      case Keyword.get(opts, :restart, :always) do
        :never -> 0
        :always -> Keyword.get(opts, :max_restarts, 3)
      end

    Supervisor.init(children,
      strategy: :one_for_all,
      max_restarts: max_restarts,
      max_seconds: Keyword.get(opts, :max_seconds, 5)
    )
  end
end

defmodule NorthTalk.Groups.Initializer do
  @moduledoc false
  # Runs the initialization function after the owner starts, then holds the
  # group's ready entry in the Registry for as long as it lives.
  use GenServer

  alias NorthTalk.Groups

  def start_link(args), do: GenServer.start_link(__MODULE__, args)

  @impl true
  def init(args), do: {:ok, args, {:continue, :initialize}}

  @impl true
  def handle_continue(:initialize, {groups, key, init, opts, reply, owner_name} = state) do
    owner = GenServer.whereis(owner_name)
    timeout = Keyword.get(opts, :init_timeout, 30_000)
    task = Task.async(fn -> run(init, owner, key) end)

    result =
      case Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill) do
        {:ok, {:ok, %NorthTalk.Group{owner: ^owner} = group}} -> {:ok, group}
        {:ok, {:ok, other}} -> {:error, {:not_this_owners_group, other}}
        {:ok, {:error, reason}} -> {:error, reason}
        {:ok, other} -> {:error, other}
        {:exit, reason} -> {:error, reason}
        nil -> {:error, :init_timeout}
      end

    case result do
      {:ok, group} ->
        {:ok, _} = Registry.register(Groups.registry(groups), {:ready, key}, group)
        send(reply, {reply, {:ok, group}})
        Groups.Watcher.notify(Groups.watcher(groups), key, {:ready, group})
        {:noreply, state}

      {:error, reason} ->
        # A waiting start_group/4 stops the group itself before it returns.
        # After a restart nothing waits, so this does it too, from another
        # process, since stopping the group stops this one.
        send(reply, {reply, {:error, reason}})
        [{member, _}] = Registry.lookup(Groups.registry(groups), {:member, key})
        spawn(fn -> Groups.stop_member(groups, member, {:init_failed, reason}) end)

        {:noreply, state}
    end
  end

  defp run(init, owner, key) do
    init.(owner, key)
  rescue
    error -> {:error, error}
  catch
    :exit, reason -> {:error, {:exit, reason}}
    thrown -> {:error, {:throw, thrown}}
  end
end

defmodule NorthTalk.Groups.Watcher do
  @moduledoc false
  # Tells the application when a group stops on its own.
  use GenServer

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts[:notify], name: opts[:name])

  def watch(watcher, member, key), do: GenServer.call(watcher, {:watch, member, key})
  def expect(watcher, member, reason), do: GenServer.call(watcher, {:expect, member, reason})
  def notify(watcher, key, event), do: GenServer.cast(watcher, {:notify, key, event})

  @impl true
  def init(notify), do: {:ok, %{notify: notify, watched: %{}, expected: %{}}}

  @impl true
  def handle_call({:watch, member, key}, _from, state) do
    Process.monitor(member)
    {:reply, :ok, put_in(state.watched[member], key)}
  end

  def handle_call({:expect, member, reason}, _from, state),
    do: {:reply, :ok, put_in(state.expected[member], reason)}

  @impl true
  def handle_cast({:notify, key, event}, state) do
    tell(state, key, event)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, _, :process, member, _}, state) do
    {key, watched} = Map.pop(state.watched, member)
    {expected, expected_map} = Map.pop(state.expected, member, :restarts_exhausted)

    if key != nil and expected != nil, do: tell(state, key, {:stopped, expected})

    {:noreply, %{state | watched: watched, expected: expected_map}}
  end

  defp tell(%{notify: nil}, _, _), do: :ok
  defp tell(%{notify: notify}, key, event), do: send(notify, {:north_talk_group, key, event})
end
