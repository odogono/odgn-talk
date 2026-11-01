const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // Every build keeps bounds and overflow checks, because the Core reads
    // hostile input. `fast` is never shipped.
    const optimize = b.option(
        std.builtin.Optimize,
        "optimize",
        "Optimization mode (default: safe; fast is refused)",
    ) orelse .safe;
    if (optimize == .fast) {
        std.debug.panic("the Zig Core never builds with -Doptimize=fast", .{});
    }

    const core = b.addModule("northtalk", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    // Lets the tests hold talk.zig's enums to talk.h's.
    core.addAnonymousImport("request-pump-vectors", .{ .root_source_file = b.path("../testdata/request-pump-binary.json") });
    core.addAnonymousImport("envelope-frames", .{ .root_source_file = b.path("../testdata/envelope-frames.json") });
    core.addAnonymousImport("talk.h", .{ .root_source_file = b.path("include/talk.h") });
    // The normative `:inspect` reader, from the Spec, which the Session
    // Host and the Message Layer's `analysis-v1` share.
    core.addAnonymousImport("inspect-reader", .{ .root_source_file = b.path("../../spec/session/inspect-reader.talk") });

    if (target.result.os.tag == .wasi) {
        // A WASI reactor: no `_start`, and the `talk_*` exports kept. It
        // ships without debug sections, as the Go reactor's `-s -w` does.
        core.strip = b.option(bool, "strip", "Omit WASI debug sections (default: true)") orelse true;
        const module = b.addExecutable(.{ .name = "talk", .root_module = core });
        // The stack lives in linear memory, where Zig's default 16 MiB would
        // be most of an instance. Source recursion stops at its 128-level
        // guards; Value traversal uses heap work stacks. The WASI check in
        // tools/wasi/zig.py exercises both at this size.
        module.stack_size = 1 << 20;
        module.entry = .disabled;
        module.rdynamic = true;
        b.installArtifact(module);
    } else {
        const library = b.addLibrary(.{
            .name = "talk",
            .linkage = .static,
            .root_module = core,
        });
        library.installHeader(b.path("include/talk.h"), "talk.h");
        b.installArtifact(library);

        // Native Message Layer transport, sharing the reactor's Session and
        // dispatcher. This step needs neither Go nor a WASI runtime.
        const sidecar_module = b.createModule(.{
            .root_source_file = b.path("src/sidecar.zig"),
            .target = target,
            .optimize = optimize,
            .strip = true,
        });
        sidecar_module.addImport("northtalk", core);
        const sidecar = b.addExecutable(.{ .name = "messagelayer", .root_module = sidecar_module });
        const install_sidecar = b.addInstallArtifact(sidecar, .{});
        b.getInstallStep().dependOn(&install_sidecar.step);
        b.step("sidecar", "Build the native framed Message Layer sidecar").dependOn(&install_sidecar.step);
    }

    const corpus_module = b.createModule(.{
        .root_source_file = b.path("src/corpus/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    corpus_module.addImport("northtalk", core);
    const c_api = b.addTranslateC(.{ .root_source_file = b.path("include/talk.h"), .target = target, .optimize = optimize, .link_libc = false });
    const c_module = c_api.createModule();
    corpus_module.addImport("talk-c", c_module);
    corpus_module.addIncludePath(b.path("include"));
    // The Session Host, an ordinary Host over talk.h (chapter 12).
    const session_module = b.createModule(.{
        .root_source_file = b.path("src/session/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    session_module.addImport("northtalk", core);
    session_module.addImport("talk-c", c_module);
    corpus_module.addImport("session", session_module);
    const corpus = b.addExecutable(.{ .name = "talk-corpus", .root_module = corpus_module });
    const run_corpus = b.addRunArtifact(corpus);
    run_corpus.setCwd(b.path("."));
    run_corpus.addPassthruArgs();
    b.step("corpus", "Run supported conformance cases through talk.h").dependOn(&run_corpus.step);

    // The differential fuzz worker (tooling/fuzz/README.md), which
    // northtalk-fuzz runs with --zig-runner.
    const fuzz_module = b.createModule(.{
        .root_source_file = b.path("src/corpus/fuzzworker.zig"),
        .target = target,
        .optimize = optimize,
    });
    fuzz_module.addImport("northtalk", core);
    fuzz_module.addImport("talk-c", c_module);
    const fuzzworker = b.addExecutable(.{ .name = "talk-fuzzworker", .root_module = fuzz_module });
    b.step("fuzzworker", "Build the differential fuzz worker").dependOn(&b.addInstallArtifact(fuzzworker, .{}).step);

    // The native Script Runner and its HTTP router (chapter 12, The Script
    // Runner; ADR 0126). Its sockets and signals come from libc; the Core
    // itself still links none.
    const runner_module = b.createModule(.{
        .root_source_file = b.path("src/runner/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    runner_module.addImport("northtalk", core);
    runner_module.addImport("talk-c", c_module);
    runner_module.addImport("session", session_module);

    // `northtalk`: the Script Runner given a file, and otherwise the REPL,
    // the Session Host at a terminal (chapter 12).
    const repl_module = b.createModule(.{
        .root_source_file = b.path("src/repl/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    repl_module.addImport("talk-c", c_module);
    repl_module.addImport("session", session_module);
    repl_module.addImport("runner", runner_module);
    const repl = b.addExecutable(.{ .name = "northtalk", .root_module = repl_module });
    // It waits on standard input and sockets with poll, which WASI hasn't.
    if (target.result.os.tag != .wasi) b.installArtifact(repl);
    const run_repl = b.addRunArtifact(repl);
    run_repl.stdio = .inherit;
    run_repl.addPassthruArgs();
    b.step("repl", "Run northtalk: the REPL, or a Script file given after --").dependOn(&run_repl.step);

    // Runs northtalk on examples/http/hello.talk over real sockets, and
    // stops it with SIGINT; then on a Script that fetches from itself.
    const smoke = b.addExecutable(.{ .name = "runner-smoke", .root_module = b.createModule(.{
        .root_source_file = b.path("src/runner/smoke.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    }) });
    const run_smoke = b.addRunArtifact(smoke);
    run_smoke.addArtifactArg(repl);
    run_smoke.addFileArg(b.path("../../examples/http/hello.talk"));
    run_smoke.addFileArg(b.path("src/runner/fetch-smoke.talk"));
    run_smoke.has_side_effects = true;
    b.step("runner-test", "Run northtalk on examples/http/hello.talk and a fetching Script, and check their answers").dependOn(&run_smoke.step);

    // The http test kit (corpus/http-kit/) through the native router.
    const kit_module = b.createModule(.{
        .root_source_file = b.path("src/runner/http_kit.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    kit_module.addImport("talk-c", c_module);
    kit_module.addImport("northtalk", core);
    kit_module.addImport("runner", runner_module);
    const kit = b.addExecutable(.{ .name = "http-kit", .root_module = kit_module });
    const run_kit = b.addRunArtifact(kit);
    run_kit.setCwd(b.path("."));
    run_kit.has_side_effects = true;
    b.step("http-kit", "Run the http test kit through the native router").dependOn(&run_kit.step);

    const test_step = b.step("test", "Run the Zig Core's tests");
    const tests = b.addTest(.{ .root_module = core });
    const run_tests = b.addRunArtifact(tests);
    // Tests read the pinned Unicode data from the repository's .cache.
    run_tests.setCwd(b.path("."));
    test_step.dependOn(&run_tests.step);
    const corpus_tests = b.addTest(.{ .root_module = corpus_module });
    const run_corpus_tests = b.addRunArtifact(corpus_tests);
    run_corpus_tests.setCwd(b.path("."));
    test_step.dependOn(&run_corpus_tests.step);
    const session_tests = b.addTest(.{ .root_module = session_module });
    test_step.dependOn(&b.addRunArtifact(session_tests).step);
    if (target.result.os.tag != .wasi) {
        const runner_tests = b.addTest(.{ .root_module = runner_module });
        test_step.dependOn(&b.addRunArtifact(runner_tests).step);
        test_step.dependOn(&run_smoke.step);
        test_step.dependOn(&run_kit.step);
    }

    // The C API's own tests, compiled as a Host would compile them against
    // talk.h. libc serves only the test program; the Core links none.
    const c_library = b.addLibrary(.{
        .name = "talk-test",
        .linkage = .static,
        .root_module = core,
    });
    const c_tests = b.addExecutable(.{
        .name = "talk-h-test",
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    c_tests.root_module.addCSourceFile(.{
        .file = b.path("tests/talk_h_test.c"),
        .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic" },
    });
    c_tests.root_module.addIncludePath(b.path("include"));
    c_tests.root_module.linkLibrary(c_library);
    test_step.dependOn(&b.addRunArtifact(c_tests).step);
}
