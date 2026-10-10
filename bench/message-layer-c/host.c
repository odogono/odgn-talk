#define _POSIX_C_SOURCE 200809L
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wasi.h>
#include <wasmtime.h>
#include "cJSON.h"
#ifdef __APPLE__
#include <mach/mach.h>
#else
#include <unistd.h>
#endif

typedef struct {
  wasmtime_store_t *store;
  wasmtime_context_t *ctx;
  wasmtime_instance_t instance;
  wasmtime_func_t buffer, send;
  wasmtime_memory_t memory;
  int ref;
} host;

static void fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static void check(wasmtime_error_t *error, wasm_trap_t *trap) {
  if (!error && !trap) return;
  wasm_byte_vec_t message;
  if (error) {
    wasmtime_error_message(error, &message);
    wasmtime_error_delete(error);
  } else {
    wasm_trap_message(trap, &message);
    wasm_trap_delete(trap);
  }
  fprintf(stderr, "Wasmtime error/trap: %.*s\n", (int)message.size, message.data);
  wasm_byte_vec_delete(&message);
  exit(1);
}

static double seconds(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) fail("clock_gettime failed");
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

static uint64_t rss(void) {
#ifdef __APPLE__
  struct mach_task_basic_info info;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info,
                &count) != KERN_SUCCESS) fail("task_info failed");
  return info.resident_size;
#else
  FILE *f = fopen("/proc/self/statm", "r");
  unsigned long total, resident;
  if (!f || fscanf(f, "%lu %lu", &total, &resident) != 2)
    fail("RSS measurement requires macOS or Linux /proc");
  fclose(f);
  long page = sysconf(_SC_PAGESIZE);
  if (page <= 0) fail("invalid page size");
  return (uint64_t)resident * (uint64_t)page;
#endif
}

static wasmtime_extern_t exported(host *h, const char *name,
                                 wasmtime_extern_kind_t kind) {
  wasmtime_extern_t e;
  if (!wasmtime_instance_export_get(h->ctx, &h->instance, name, strlen(name), &e))
    fail("required reactor export missing (requires #551)");
  if (e.kind != kind) fail("wrong reactor export type");
  return e;
}

static wasmtime_val_t invoke(host *h, wasmtime_func_t *f, uint32_t n,
                             wasmtime_valkind_t kind) {
  wasmtime_val_t arg = {.kind = WASMTIME_I32, .of.i32 = (int32_t)n}, result;
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *error = wasmtime_func_call(h->ctx, f, &arg, 1, &result, 1, &trap);
  check(error, trap);
  if (result.kind != kind) fail("wrong reactor result type");
  return result;
}

static host open_host(wasm_engine_t *engine, wasmtime_linker_t *linker,
                      wasmtime_module_t *module) {
  host h = {0};
  h.store = wasmtime_store_new(engine, NULL, NULL);
  if (!h.store) fail("store allocation failed");
  h.ctx = wasmtime_store_context(h.store);
  // A backstop, distinct from Script budgets. Hitting it may trap Go's runtime.
  wasmtime_store_limiter(h.store, 256 * 1024 * 1024, -1, 1, -1, 1);
  wasi_config_t *wasi = wasi_config_new();
  if (!wasi) fail("WASI allocation failed");
  wasi_config_inherit_stderr(wasi);
  check(wasmtime_context_set_wasi(h.ctx, wasi), NULL);
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *error = wasmtime_linker_instantiate(linker, h.ctx, module,
                                                       &h.instance, &trap);
  check(error, trap);
  wasmtime_extern_t e = exported(&h, "_initialize", WASMTIME_EXTERN_FUNC);
  error = wasmtime_func_call(h.ctx, &e.of.func, NULL, 0, NULL, 0, &trap);
  check(error, trap);
  e = exported(&h, "talk_buffer", WASMTIME_EXTERN_FUNC);
  h.buffer = e.of.func;
  e = exported(&h, "talk_send", WASMTIME_EXTERN_FUNC);
  h.send = e.of.func;
  e = exported(&h, "memory", WASMTIME_EXTERN_MEMORY);
  h.memory = e.of.memory;
  return h;
}

static cJSON *field(cJSON *object, const char *name) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(object, name);
  if (!value) fail("required JSON field missing");
  return value;
}

static int is(cJSON *value, const char *text) {
  return cJSON_IsString(value) && strcmp(value->valuestring, text) == 0;
}

// Refresh the memory pointer after each export: either call can grow memory.
// Parse the reply while it is valid, before the next talk_send overwrites it.
static cJSON *frame(host *h, const char *data, size_t n) {
  if (!n || n > INT32_MAX) fail("invalid frame length");
  uint32_t ptr = (uint32_t)invoke(h, &h->buffer, (uint32_t)n, WASMTIME_I32).of.i32;
  size_t size = wasmtime_memory_data_size(h->ctx, &h->memory);
  if (!ptr || ptr > size || n > size - ptr) fail("input outside linear memory");
  memcpy(wasmtime_memory_data(h->ctx, &h->memory) + ptr, data, n);
  uint64_t packed = (uint64_t)invoke(h, &h->send, (uint32_t)n, WASMTIME_I64).of.i64;
  ptr = (uint32_t)(packed >> 32);
  uint32_t len = (uint32_t)packed;
  size = wasmtime_memory_data_size(h->ctx, &h->memory);
  if (!len || ptr > size || len > size - ptr) fail("reply outside linear memory");
  const char *reply = (const char *)wasmtime_memory_data(h->ctx, &h->memory) + ptr;
  cJSON *json = cJSON_ParseWithLength(reply, len);
  if (!json || !cJSON_IsObject(json)) fail("invalid JSON reply");
  return json;
}

static cJSON *request(host *h, const char *m) {
  cJSON *req = cJSON_CreateObject();
  cJSON_AddStringToObject(req, "m", m);
  cJSON_AddNumberToObject(req, "ref", ++h->ref);
  return req;
}

// Takes ownership of req. Final and interim replies both echo the Host ref.
static cJSON *send_request(host *h, cJSON *req) {
  int ref = field(req, "ref")->valueint;
  char *text = cJSON_PrintUnformatted(req);
  if (!text) fail("JSON serialization failed");
  cJSON *reply = frame(h, text, strlen(text));
  free(text);
  cJSON_Delete(req);
  if (!cJSON_IsNumber(field(reply, "ref")) || field(reply, "ref")->valuedouble != ref)
    fail("reply ref mismatch");
  return reply;
}

static void require_ok(cJSON *reply) {
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(reply, "ok"))) {
    char *text = cJSON_PrintUnformatted(reply);
    fprintf(stderr, "expected ok, got %s\n", text ? text : "null");
    free(text);
    exit(1);
  }
}

static void ok(host *h, cJSON *req) {
  cJSON *reply = send_request(h, req);
  require_ok(reply);
  cJSON_Delete(reply);
}

static void hello(host *h) {
  cJSON *req = request(h, "hello");
  cJSON_AddNumberToObject(req, "protocol", 1);
  ok(h, req);
}

static cJSON *group_request(host *h, const char *m) {
  cJSON *req = request(h, m);
  cJSON_AddStringToObject(req, "group", "g");
  return req;
}

static void load(host *h, const char *name, const char *source, int grant) {
  cJSON *req = group_request(h, "load");
  cJSON_AddStringToObject(req, "name", name);
  cJSON_AddStringToObject(req, "source", source);
  cJSON *limits = cJSON_AddObjectToObject(req, "limits");
  cJSON_AddNumberToObject(limits, "fuelPerRun", strcmp(name, "faults") == 0 ? 5000 : 1000000);
  if (grant) cJSON_AddNumberToObject(cJSON_AddObjectToObject(req, "grants"), "api", grant);
  ok(h, req);
}

static void setup(host *h) {
  hello(h);
  cJSON *req = request(h, "define-capability");
  cJSON_AddStringToObject(req, "name", "api");
  cJSON_AddItemToObject(req, "ops", cJSON_Parse(
    "[{\"name\":\"echo\",\"mode\":\"immediate\",\"args\":[\"value\"],\"result\":\"value\"}]"));
  ok(h, req);
  req = request(h, "grant");
  cJSON_AddStringToObject(req, "capability", "api");
  cJSON_AddStringToObject(req, "ops", "all");
  cJSON *reply = send_request(h, req);
  require_ok(reply);
  int grant = field(field(reply, "ok"), "grant")->valueint;
  cJSON_Delete(reply);
  req = group_request(h, "new-group");
  cJSON_AddStringToObject(req, "name", "g");
  ok(h, req);
  load(h, "s", "on echo n, payload\n  repeat n times\n    ask api to echo payload\n"
       "  end repeat\n  return it\nend echo\non empty\nend empty\n"
       "on healthy\n  return 42\nend healthy", grant);
  load(h, "faults", "function down n\n  return down(n + 1) + 1\nend down\n"
       "on spin\n  repeat forever\n  end repeat\nend spin\non boom\n"
       "  throw \"deliberate\"\nend boom\non dive\n  return down(0)\nend dive", 0);
}

static void deliver(host *h, const char *script, const char *name, cJSON *args) {
  cJSON *req = group_request(h, "deliver");
  cJSON_AddStringToObject(cJSON_AddObjectToObject(req, "to"), "script", script);
  cJSON *message = cJSON_AddObjectToObject(req, "message");
  cJSON_AddStringToObject(message, "name", name);
  if (args) cJSON_AddItemToObject(message, "args", args);
  ok(h, req);
}

static cJSON *pump(host *h, int *calls) {
  cJSON *req = group_request(h, "pump");
  cJSON_AddStringToObject(req, "now", "2026-10-10T12:00:00Z");
  cJSON *reply = send_request(h, req), *need;
  while ((need = cJSON_GetObjectItemCaseSensitive(reply, "need"))) {
    if (!is(field(need, "m"), "op") || !is(field(need, "operation"), "echo"))
      fail("unexpected interim request");
    cJSON *args = field(need, "args");
    if (!cJSON_IsArray(args) || cJSON_GetArraySize(args) != 1) fail("wrong echo args");
    req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "m", "op-result");
    cJSON_AddNumberToObject(req, "ref", field(reply, "ref")->valueint);
    cJSON_AddNumberToObject(req, "charged", 0);
    // Decode with cJSON, then encode anew, preserving Value Encoding tags.
    cJSON_AddItemToObject(req, "result", cJSON_Duplicate(cJSON_GetArrayItem(args, 0), 1));
    cJSON_Delete(reply);
    reply = send_request(h, req);
    ++*calls;
  }
  require_ok(reply);
  return reply;
}

static cJSON *run_end(cJSON *reply, const char *outcome) {
  cJSON *reports = field(field(reply, "ok"), "reports"), *r, *end = NULL;
  cJSON_ArrayForEach(r, reports) {
    if (is(field(r, "kind"), "run end")) {
      if (end) fail("multiple run end reports");
      end = r;
    }
  }
  if (!end || !is(field(end, "outcome"), outcome)) fail("wrong Run outcome");
  return end;
}

static void healthy(host *h) {
  hello(h);
  deliver(h, "s", "healthy", NULL);
  int calls = 0;
  cJSON *reply = pump(h, &calls);
  if (field(run_end(reply, "completed"), "result")->valuedouble != 42 || calls)
    fail("instance did not recover");
  cJSON_Delete(reply);
}

static void faults(host *h, cJSON *result) {
  const char *names[] = {"spin", "boom", "dive"};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 10; ++j) {
      deliver(h, "faults", names[i], NULL);
      int calls = 0;
      cJSON *reply = pump(h, &calls);
      cJSON *end = run_end(reply, i == 1 ? "errored" : "limit fault");
      if (i != 1 && !is(field(end, "limit"), i == 0 ? "fuel" : "depth"))
        fail("wrong Limit Fault");
      if (i == 1 && !is(field(field(end, "error"), "code"), "deliberate"))
        fail("wrong throw error");
      if (j == 0) cJSON_AddItemToObject(result, names[i], cJSON_Duplicate(end, 1));
      cJSON_Delete(reply);
      healthy(h);
    }
  }
  const char *bad[] = {"{", "{\"m\":\"unknown\",\"ref\":0}",
    "{\"m\":\"add\",\"ref\":0,\"a\":{\"$bytes\":\"!\"},\"b\":1}",
    "{\"m\":\"load\",\"ref\":0,\"group\":\"g\",\"name\":\"bad\",\"source\":\"on go\\n  return nope\\nend go\"}"};
  const char *kinds[] = {"protocol error", "protocol error", "host error", "load error"};
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
    cJSON *reply = frame(h, bad[i], strlen(bad[i]));
    if (!is(field(field(reply, "err"), "kind"), kinds[i]))
      fail("wrong hostile input error");
    cJSON_Delete(reply);
    healthy(h);
  }
  cJSON_AddNumberToObject(result, "script_faults_checked", 30);
  cJSON_AddNumberToObject(result, "hostile_frames_checked", 4);
  cJSON_AddBoolToObject(result, "same_instance_healthy_after_each", 1);
}

static int positive(const char *text, int max) {
  char *end;
  long n = strtol(text, &end, 10);
  if (!*text || *end || n < 1 || n > max) fail("invalid positive count");
  return (int)n;
}

int main(int argc, char **argv) {
  if (argc != 5) fail("usage: host reactor.wasm samples iterations instances");
  int samples = positive(argv[2], 1000), iterations = positive(argv[3], 10000);
  int instances = positive(argv[4], 128);
  FILE *f = fopen(argv[1], "rb");
  if (!f || fseek(f, 0, SEEK_END)) fail("cannot read reactor");
  long length = ftell(f);
  if (length <= 0 || fseek(f, 0, SEEK_SET)) fail("invalid reactor size");
  uint8_t *bytes = malloc((size_t)length);
  if (!bytes || fread(bytes, 1, (size_t)length, f) != (size_t)length) fail("short reactor read");
  fclose(f);
  wasm_engine_t *engine = wasm_engine_new();
  wasmtime_linker_t *linker = wasmtime_linker_new(engine);
  check(wasmtime_linker_define_wasi(linker), NULL);
  wasmtime_module_t *module = NULL;
  double start = seconds();
  check(wasmtime_module_new(engine, bytes, (size_t)length, &module), NULL);
  double compile_ms = (seconds() - start) * 1000;
  free(bytes);
  cJSON *out = cJSON_CreateObject();
  cJSON_AddStringToObject(out, "wasmtime", WASMTIME_VERSION);
  cJSON_AddNumberToObject(out, "compile_ms", compile_ms);
  cJSON *startup = cJSON_AddArrayToObject(out, "instantiate_initialize_hello_ms");
  // Warm one instance before taking RSS: compiled code and shared runtime are
  // excluded from the incremental resident-memory observation.
  host warm = open_host(engine, linker, module);
  hello(&warm);
  wasmtime_store_delete(warm.store);
  uint64_t before = rss();
  host *hosts = calloc((size_t)instances, sizeof(host));
  if (!hosts) fail("host allocation failed");
  uint64_t linear = 0;
  for (int i = 0; i < instances; ++i) {
    start = seconds();
    hosts[i] = open_host(engine, linker, module);
    hello(&hosts[i]);
    cJSON_AddItemToArray(startup, cJSON_CreateNumber((seconds() - start) * 1000));
    linear += wasmtime_memory_data_size(hosts[i].ctx, &hosts[i].memory);
  }
  uint64_t after = rss();
  cJSON_AddNumberToObject(out, "instances", instances);
  cJSON_AddNumberToObject(out, "rss_before_bytes", (double)before);
  cJSON_AddNumberToObject(out, "rss_with_instances_bytes", (double)after);
  cJSON_AddNumberToObject(out, "rss_delta_per_instance_bytes", ((double)after - before) / instances);
  cJSON_AddNumberToObject(out, "linear_memory_per_instance_bytes", (double)linear / instances);
  host *h = &hosts[0];
  setup(h);
  cJSON *versions = request(h, "hello");
  cJSON_AddNumberToObject(versions, "protocol", 1);
  cJSON *reply = send_request(h, versions);
  require_ok(reply);
  cJSON_AddItemToObject(out, "core_versions", cJSON_Duplicate(field(reply, "ok"), 1));
  cJSON_Delete(reply);
  cJSON *idle = cJSON_AddArrayToObject(out, "idle_pump_us");
  int calls = 0;
  for (int i = 0; i < 100; ++i) cJSON_Delete(pump(h, &calls));
  for (int s = 0; s < samples; ++s) {
    start = seconds();
    for (int i = 0; i < iterations; ++i) cJSON_Delete(pump(h, &calls));
    cJSON_AddItemToArray(idle, cJSON_CreateNumber((seconds() - start) * 1e6 / iterations));
  }
  if (calls) fail("idle Pump made a Capability call");
  cJSON *active = cJSON_AddArrayToObject(out, "empty_handler_pump_us");
  for (int s = -1; s < samples; ++s) {
    double elapsed = 0;
    for (int i = 0; i < iterations; ++i) {
      deliver(h, "s", "empty", NULL);
      start = seconds();
      reply = pump(h, &calls);
      elapsed += seconds() - start;
      run_end(reply, "completed");
      cJSON_Delete(reply);
    }
    if (s >= 0) cJSON_AddItemToArray(active, cJSON_CreateNumber(elapsed * 1e6 / iterations));
  }
  const char *values[] = {"37", "{\"items\":[37,\"hello\",true,null],\"decimal\":{\"$dec\":\"12345678901234567890.1200\"},\"money\":{\"$quantity\":[\"2.50\",\"GBP\"]},\"blob\":{\"$bytes\":\"AAEC\"}}"};
  const char *labels[] = {"number", "nested_value"};
  cJSON_AddNumberToObject(out, "calls_per_pump", iterations);
  for (int v = 0; v < 2; ++v) {
    cJSON *value = cJSON_Parse(values[v]);
    cJSON *timings = cJSON_AddArrayToObject(out, labels[v]);
    // First run warms the workload; delivery and request construction are
    // outside the interval, Pump and every op-result exchange are inside.
    for (int s = -1; s < samples; ++s) {
      cJSON *args = cJSON_CreateArray();
      cJSON_AddItemToArray(args, cJSON_CreateNumber(iterations));
      cJSON_AddItemToArray(args, cJSON_Duplicate(value, 1));
      deliver(h, "s", "echo", args);
      calls = 0;
      start = seconds();
      reply = pump(h, &calls);
      double us = (seconds() - start) * 1e6 / iterations;
      char *actual = cJSON_PrintUnformatted(field(run_end(reply, "completed"), "result"));
      char *expected = cJSON_PrintUnformatted(value);
      if (calls != iterations || !actual || !expected || strcmp(actual, expected) != 0)
        fail("Capability count or Value Encoding round trip differs");
      free(actual);
      free(expected);
      if (s >= 0) cJSON_AddItemToArray(timings, cJSON_CreateNumber(us));
      cJSON_Delete(reply);
    }
    cJSON_Delete(value);
  }
  faults(h, cJSON_AddObjectToObject(out, "fault_checks"));
  cJSON_AddNumberToObject(out, "linear_memory_after_workloads_bytes", (double)wasmtime_memory_data_size(h->ctx, &h->memory));
  char *text = cJSON_Print(out);
  if (!text) fail("output serialization failed");
  puts(text);
  free(text);
  cJSON_Delete(out);
  for (int i = 0; i < instances; ++i) wasmtime_store_delete(hosts[i].store);
  free(hosts);
  wasmtime_module_delete(module);
  wasmtime_linker_delete(linker);
  wasm_engine_delete(engine);
  return 0;
}
