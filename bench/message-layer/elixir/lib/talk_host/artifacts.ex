defmodule TalkHost.Artifacts do
  @moduledoc """
  The Zig reactor and native sidecar this Host loads, kept in the repository's `.cache/`.
  `build!/0` makes them with the commands in the Core guides.
  """

  def root, do: Path.expand("../../..", File.cwd!())

  @doc "The Zig reactor module by default; TALK_WASM selects another build."
  def wasm, do: System.get_env("TALK_WASM") || zig_wasm()
  defp zig_wasm, do: Path.join(root(), ".cache/zig-wasi/bin/talk.wasm")
  def sidecar, do: Path.join(root(), ".cache/zig-native/bin/messagelayer")
  @doc "The minimal C Host, built by bench/message-layer-c/run.sh."
  def c_host, do: Path.join(root(), "bench/message-layer-c/out/host")
  def linux_sidecar, do: Path.join(root(), ".cache/zig-linux-#{linux_arch()}/bin/messagelayer")

  def build! do
    File.mkdir_p!(Path.join(root(), ".cache"))

    {_, 0} =
      System.cmd("zig", ["build", "-Dtarget=wasm32-wasi", "--prefix", "../../.cache/zig-wasi"],
        cd: Path.join(root(), "impl/zig"), into: IO.stream())

    zig_sidecar!(["--prefix", "../../.cache/zig-native"])
    arch = if linux_arch() == "arm64", do: "aarch64", else: "x86_64"
    zig_sidecar!(["-Dtarget=#{arch}-linux-musl", "--prefix", "../../.cache/zig-linux-#{linux_arch()}"])
  end

  defp zig_sidecar!(args) do
    {_, 0} = System.cmd("zig", ["build", "sidecar" | args], cd: Path.join(root(), "impl/zig"), into: IO.stream())
  end

  defp linux_arch do
    case :erlang.system_info(:system_architecture) |> to_string() do
      "aarch64" <> _ -> "arm64"
      "arm64" <> _ -> "arm64"
      _ -> "amd64"
    end
  end
end
