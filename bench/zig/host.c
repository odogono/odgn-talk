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
/* Opt-in allocation probe, separate from default-allocator timings. It wraps
 * the allocator the Host hands the Group, so every figure counts parent
 * allocator requests for Group memory only; process-owned Host values and
 * returned bytes are outside this allocator. hostBytes/hostAllocs are
 * cumulative requests over one checked Run (Load excluded) and frees do not
 * subtract. hostFrees counts free calls in the same span, hostLivePeakDelta
 * is the largest rise in live requested bytes above the level at Run start,
 * and hostTopSizes lists the exact request sizes with the most requests in
 * the span, so a fixed-size node (a Value) stands apart from variable-size
 * scratch and collection buffers. groupPeak is the Group's own physical
 * high-water mark, including Load; groupUsed is held memory after the checked
 * Run, including retained cache capacity. None of these is resident memory. */
/* Long Text growth has one distinct buffer size per append, plus the
 * Group's other storage. Keep the untimed size histogram above 8,192 joins. */
#define MAX_SIZES 32768
#define TOP_SIZES 8
typedef struct { size_t size, count, bytes; } size_stat;
static size_t host_bytes, host_allocs, host_frees, host_live, host_live_peak;
static size_stat size_stats[MAX_SIZES];
static size_t size_stat_count;
static void *count_alloc(void *context, size_t size, size_t alignment) {
    (void)context;
    void *ptr = NULL;
    if (posix_memalign(&ptr, alignment < sizeof(void *) ? sizeof(void *) : alignment, size)) return NULL;
    host_bytes += size;
    ++host_allocs;
    host_live += size;
    if (host_live > host_live_peak) host_live_peak = host_live;
    for (size_t i = 0; i < size_stat_count; ++i) {
        if (size_stats[i].size == size) {
            ++size_stats[i].count;
            size_stats[i].bytes += size;
            return ptr;
        }
    }
    if (size_stat_count == MAX_SIZES) { fprintf(stderr, "allocation size table full\n"); exit(1); }
    size_stats[size_stat_count++] = (size_stat){.size = size, .count = 1, .bytes = size};
    return ptr;
}
static void count_free(void *context, void *ptr, size_t size, size_t alignment) {
    (void)context; (void)alignment;
    ++host_frees;
    host_live -= size;
    free(ptr);
}
typedef struct {
    size_t bytes, allocs, frees, live;
    size_stat stats[MAX_SIZES];
    size_t stat_count;
} alloc_snapshot;
static alloc_snapshot snapshot_allocations(void) {
    static alloc_snapshot snap;
    snap = (alloc_snapshot){.bytes = host_bytes, .allocs = host_allocs, .frees = host_frees, .live = host_live, .stat_count = size_stat_count};
    memcpy(snap.stats, size_stats, size_stat_count * sizeof *size_stats);
    host_live_peak = host_live; // The peak restarts at the Run boundary.
    return snap;
}
static int by_count(const void *a, const void *b) {
    const size_stat *x = a, *y = b;
    if (x->count != y->count) return x->count < y->count ? 1 : -1;
    return x->size < y->size ? -1 : x->size > y->size;
}
static void print_allocations(const alloc_snapshot *snap, talk_group *group) {
    talk_memory memory;
    talk_group_memory(group, &memory);
    printf(",\"hostBytes\":%zu,\"hostAllocs\":%zu,\"hostFrees\":%zu,\"hostLivePeakDelta\":%zu,\"groupUsed\":%zu,\"groupPeak\":%zu,\"hostTopSizes\":[",
           host_bytes - snap->bytes, host_allocs - snap->allocs, host_frees - snap->frees,
           host_live_peak - snap->live, memory.used, memory.peak);
    static size_stat deltas[MAX_SIZES];
    size_t delta_count = 0;
    for (size_t i = 0; i < size_stat_count; ++i) {
        size_t base_count = 0, base_bytes = 0;
        for (size_t j = 0; j < snap->stat_count; ++j) {
            if (snap->stats[j].size == size_stats[i].size) {
                base_count = snap->stats[j].count;
                base_bytes = snap->stats[j].bytes;
                break;
            }
        }
        if (size_stats[i].count > base_count)
            deltas[delta_count++] = (size_stat){.size = size_stats[i].size, .count = size_stats[i].count - base_count, .bytes = size_stats[i].bytes - base_bytes};
    }
    qsort(deltas, delta_count, sizeof *deltas, by_count);
    size_t shown = delta_count < TOP_SIZES ? delta_count : TOP_SIZES;
    for (size_t i = 0; i < shown; ++i)
        printf("%s{\"size\":%zu,\"count\":%zu,\"bytes\":%zu}", i ? "," : "", deltas[i].size, deltas[i].count, deltas[i].bytes);
    printf("]");
}
static const talk_allocator counting = {.alloc = count_alloc, .free = count_free};
static bool count_allocations;
static talk_group *load(talk_core *core, const char *source, talk_script **script) {
    static unsigned serial;
    char name[64];
    snprintf(name, sizeof name, "load%u", ++serial);
    talk_group *group;
    talk_group_options go = {.name = "bench", .name_len = 5};
    if (count_allocations) go.allocator = &counting;
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
    count_allocations = getenv("NORTHTALK_BENCH_ALLOCATIONS") != NULL;
    talk_core *core = talk_new();
    if (!core) return 1;
    talk_script *script;
    talk_group *group = load(core, source, &script);
    alloc_snapshot before_run = snapshot_allocations();
    accounting checked = run(group, script, n, slice, argv[3]);
    printf("{\"fuel\":%" PRId64 ",\"logicalAlloc\":%" PRId64, checked.fuel, checked.alloc);
    if (count_allocations) print_allocations(&before_run, group);
    printf(",\"run\":[");
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
