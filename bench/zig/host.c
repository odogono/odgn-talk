// Native Zig Core timings through talk.h. The TS driver supplies manifest sizes.
// See bench/README.md for timing boundaries and supported workloads.
#define _POSIX_C_SOURCE 200809L
#include "talk.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK(call) do { talk_host_error_code e = (call); if (e != TALK_OK) { fprintf(stderr, "%s: error %d\n", #call, e); exit(1); } } while (0)
static double now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) exit(1);
    return (double)t.tv_sec * 1e9 + t.tv_nsec;
}
static talk_group *load(talk_core *core, const char *source, talk_script **script) {
    static unsigned serial;
    char name[64];
    snprintf(name, sizeof name, "load%u", ++serial);
    talk_group *group;
    talk_group_options go = {.name = "bench", .name_len = 5};
    CHECK(talk_new_group(core, &go, &group));
    talk_limits limits = {.fuel_per_run = 1000000000, .alloc_per_run = 268435456, .call_depth = 1000};
    talk_load_options opts = {.name = name, .name_len = strlen(name), .source = source, .source_len = strlen(source), .limits = &limits};
    CHECK(talk_load(group, &opts, script));
    return group;
}
typedef struct { int64_t fuel, alloc; } accounting;
static accounting run(talk_group *group, talk_script *script, int64_t n, int64_t slice, const char *expected) {
    talk_value *arg;
    CHECK(talk_int(n, &arg));
    talk_message message = {.name = "run", .name_len = 3, .args = &arg, .args_len = 1};
    talk_owned_bytes id = {0};
    CHECK(talk_script_deliver(script, &message, &id));
    talk_value_release(arg);
    accounting total = {0};
    bool ended = false;
    for (;;) {
        talk_pump_result pump;
        talk_pump_options opts = {.fuel_slice = slice};
        CHECK(talk_pump(group, 1767225600, 0, &opts, &pump));
        total.fuel += pump.fuel_used;
        const talk_report *reports;
        size_t len = talk_reports_items(pump.reports, &reports);
        for (size_t i = 0; i < len; ++i) {
            if (reports[i].kind != TALK_REPORT_RUN_END) continue;
            const talk_run_end *end = &reports[i].as.run_end;
            total.alloc += end->alloc;
            if (end->delivery_len != id.len || memcmp(end->delivery, id.data, id.len)) continue;
            if (end->outcome != TALK_COMPLETED) {
                fprintf(stderr, "Run failed: outcome %d, limit %.*s\n", end->outcome, (int)end->limit_len, end->limit);
                exit(1);
            }
            talk_owned_bytes result;
            CHECK(talk_value_string(end->result, &result));
            if (result.len != strlen(expected) || memcmp(result.data, expected, result.len)) {
                fprintf(stderr, "Output %.*s, expected %s\n", (int)result.len, result.data, expected);
                exit(1);
            }
            talk_owned_bytes_release(&result);
            ended = true;
        }
        talk_reports_release(pump.reports);
        if (ended && pump.state == TALK_IDLE && !pump.has_next_deadline) break;
        if (!pump.fuel_used && !len) { fprintf(stderr, "Pump made no progress\n"); exit(1); }
    }
    talk_owned_bytes_release(&id);
    return total;
}
int main(int argc, char **argv) {
    if (argc != 7) { fprintf(stderr, "Usage: host source n expected slice count smoke\n"); return 1; }
    FILE *file = fopen(argv[1], "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 1;
    long size = ftell(file);
    if (size < 0 || fseek(file, 0, SEEK_SET)) return 1;
    char *source = calloc((size_t)size + 1, 1);
    if (!source || fread(source, 1, (size_t)size, file) != (size_t)size) return 1;
    fclose(file);
    int count = atoi(argv[5]);
    bool smoke = atoi(argv[6]) != 0;
    if (count < 1) return 1;
    int64_t n = strtoll(argv[2], NULL, 10), slice = strtoll(argv[4], NULL, 10);
    talk_core *core = talk_new();
    if (!core) return 1;
    talk_script *script;
    talk_group *group = load(core, source, &script);
    accounting checked = run(group, script, n, slice, argv[3]);
    printf("{\"fuel\":%" PRId64 ",\"logicalAlloc\":%" PRId64 ",\"run\":[", checked.fuel, checked.alloc);
    for (int sample = 0; sample < count; ++sample) {
        double start = now(), elapsed;
        unsigned iterations = 0;
        do {
            accounting got = run(group, script, n, slice, argv[3]);
            if (got.fuel != checked.fuel || got.alloc != checked.alloc) return 1;
            ++iterations;
            elapsed = now() - start;
        } while (!smoke && elapsed < 50000000);
        printf("%s%.3f", sample ? "," : "", elapsed / iterations);
    }
    talk_group_release(group);
    printf("],\"load\":[");
    for (int sample = 0; sample < count; ++sample) {
        double elapsed = 0;
        unsigned iterations = 0;
        do {
            double start = now();
            group = load(core, source, &script);
            elapsed += now() - start;
            talk_group_release(group); // Destruction is outside the Load timing.
            ++iterations;
        } while (!smoke && elapsed < 50000000);
        printf("%s%.3f", sample ? "," : "", elapsed / iterations);
    }
    puts("]}");
    talk_core_release(core);
    free(source);
}
