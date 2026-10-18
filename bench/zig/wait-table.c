// Compare this Host's Trace and saved bytes against pre/post-refactor libraries.
// Usage: wait-table <output-prefix>; writes <prefix>-<scenario>-<step>.save.
#include "talk.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(call) do { talk_host_error_code e = (call); if (e != TALK_OK) { fprintf(stderr, "%s: error %d\n", #call, e); exit(1); } } while (0)

static void trace(void *context, const char *line, size_t len) {
    (void)context;
    fwrite(line, 1, len, stdout);
    putchar('\n');
}

static void pump(talk_group *group, int ms, int slice) {
    talk_pump_result result;
    talk_pump_options options = {.fuel_slice = slice};
    CHECK(talk_pump(group, 1767225600, ms * 1000, &options, &result));
    talk_reports_release(result.reports);
}

static void save(talk_group *group, const char *prefix, int scenario, int step) {
    talk_owned_bytes bytes;
    CHECK(talk_save(group, &bytes));
    char path[1024];
    int len = snprintf(path, sizeof path, "%s-%d-%d.save", prefix, scenario, step);
    if (len < 0 || (size_t)len >= sizeof path) exit(1);
    FILE *file = fopen(path, "wb");
    if (!file || fwrite(bytes.data, 1, bytes.len, file) != bytes.len) exit(1);
    if (fclose(file)) exit(1);
    talk_owned_bytes_release(&bytes);
}

static void deliver(talk_script *script, const char *name, talk_value *arg) {
    talk_message message = {.name = name, .name_len = strlen(name), .args = arg ? &arg : NULL, .args_len = arg ? 1 : 0};
    CHECK(talk_script_deliver(script, &message, NULL));
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "Usage: wait-table output-prefix\n");
        return 1;
    }
    const char *sources[] = {
        "on go n\n"
        " wait n * 1 ms\n"
        " return n\n"
        "end go\n",
        "on go n\n"
        " wait for ping or 10 ms\n"
        " return n\n"
        "end go\n"
        "on ping\n"
        " return 1\n"
        "end ping\n",
        "on go n\n"
        " with timeout of 50 ms\n"
        "  wait for all\n"
        "   send slow with n to me and wait\n"
        "   send slow with n to me and wait\n"
        "  end wait\n"
        " end timeout\n"
        " return it\n"
        "end go\n"
        "on slow n\n"
        " wait n * 1 ms\n"
        " return n\n"
        "end slow\n",
    };
    talk_core *core = talk_new();
    if (!core) return 1;
    // Ordinary deadlines, event observation, suspended Joins, preempted Joins.
    for (int scenario = 0; scenario < 4; ++scenario) {
        talk_group *group;
        talk_group_options options = {.name = "waits", .name_len = 5, .trace = trace};
        CHECK(talk_new_group(core, &options, &group));
        const char *source = sources[scenario < 3 ? scenario : 2];
        talk_script *script;
        talk_load_options load = {.name = "s", .name_len = 1, .source = source, .source_len = strlen(source)};
        CHECK(talk_load(group, &load, &script));
        for (int n = 10; n <= 20; n += 10) {
            talk_value *value;
            CHECK(talk_int(n, &value));
            deliver(script, "go", value);
            talk_value_release(value);
        }
        int slice = scenario == 3 ? 40 : 0;
        pump(group, 0, slice);
        save(group, argv[1], scenario, 0);
        pump(group, 5, slice);
        save(group, argv[1], scenario, 1);
        if (scenario == 1) deliver(script, "ping", NULL);
        pump(group, 10, slice);
        save(group, argv[1], scenario, 2);
        if (scenario != 3) CHECK(talk_script_stop(script, "done", 4));
        pump(group, 20, 0);
        save(group, argv[1], scenario, 3);
        talk_group_release(group);
    }
    talk_core_release(core);
    return 0;
}
