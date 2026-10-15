defmodule TalkHost.Artifacts do
  @moduledoc """
  The Zig reactor and Go sidecar this Host loads, kept in the repository's `.cache/`.
  `build!/0` makes them with the commands in the Core guides.
  """

  def root, do: Path.expand("../../..", File.cwd!())

  @doc "The Zig reactor module by default; TALK_WASM selects another build."
  def wasm, do: System.get_env("TALK_WASM") || zig_wasm()
  defp zig_wasm, do: Path.join(root(), ".cache/zig-wasi/bin/talk.wasm")
  def sidecar, do: Path.join(root(), ".cache/messagelayer")
  @doc "The minimal C Host, built by bench/message-layer-c/run.sh."
  def c_host, do: Path.join(root(), "bench/message-layer-c/out/host")
  def linux_sidecar, do: Path.join(root(), ".cache/messagelayer-linux-#{linux_arch()}")

  def build! do
    File.mkdir_p!(Path.join(root(), ".cache"))
    out = fn path -> Path.relative_to(path, Path.join(root(), "impl/go"), force: true) end

    {_, 0} =
      System.cmd("zig", ["build", "-Dtarget=wasm32-wasi", "--prefix", "../../.cache/zig-wasi"],
        cd: Path.join(root(), "impl/zig"), into: IO.stream())

    go!(%{}, ["-o", out.(sidecar()), "./cmd/messagelayer"])

    go!(%{"CGO_ENABLED" => "0", "GOOS" => "linux", "GOARCH" => linux_arch()}, [
      "-o",
      out.(linux_sidecar()),
      "./cmd/messagelayer"
    ])
  end

  defp go!(env, args) do
    args = ["-C", Path.join(root(), "impl/go"), "build", "-trimpath", "-buildvcs=false" | args]
    {_, 0} = System.cmd("go", args, env: env, into: IO.stream())
  end

  defp linux_arch do
    case :erlang.system_info(:system_architecture) |> to_string() do
      "aarch64" <> _ -> "arm64"
      "arm64" <> _ -> "arm64"
      _ -> "amd64"
    end
  end
end
