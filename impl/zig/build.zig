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
    core.addAnonymousImport("talk.h", .{ .root_source_file = b.path("include/talk.h") });

    if (target.result.os.tag == .wasi) {
        // A WASI reactor: no `_start`, and the `talk_*` exports kept. It
        // ships without debug sections, as the Go reactor's `-s -w` does.
        core.strip = true;
        const module = b.addExecutable(.{ .name = "talk", .root_module = core });
        // The stack lives in linear memory, where Zig's default 16 MiB would
        // be most of an instance. Nothing recurses past the depth guards
        // (128 levels of source and of Value nesting), which the WASI check
        // in tools/wasi/zig.py exercises at this size.
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
    }

    const corpus_module = b.createModule(.{
        .root_source_file = b.path("src/corpus/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    corpus_module.addImport("northtalk", core);
    const c_api = b.addTranslateC(.{ .root_source_file = b.path("include/talk.h"), .target = target, .optimize = optimize, .link_libc = false });
    corpus_module.addImport("talk-c", c_api.createModule());
    corpus_module.addIncludePath(b.path("include"));
    const corpus = b.addExecutable(.{ .name = "talk-corpus", .root_module = corpus_module });
    const run_corpus = b.addRunArtifact(corpus);
    run_corpus.setCwd(b.path("."));
    run_corpus.addPassthruArgs();
    b.step("corpus", "Run supported conformance cases through talk.h").dependOn(&run_corpus.step);

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

    // The C API's own tests, compiled as a Host would compile them against
    // talk.h. libc serves only the test program; the Core links none.
    const c_library = b.addLibrary(.{
        .name = "talk-test",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/root.zig"),
            .target = target,
            .optimize = optimize,
        }),
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
