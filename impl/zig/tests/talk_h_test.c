/* talk.h's value API, called as a C Host calls it. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <time.h>

#include "talk.h"

static int failures = 0;

static void expect(int ok, const char *what) {
    if (!ok) {
        fprintf(stderr, "talk.h: %s\n", what);
        failures++;
    }
}

static void expect_text_n(const char *in, size_t len, const char *want, size_t want_len) {
    talk_value *v = NULL;
    const char *s = NULL;
    size_t n = 0;
    expect(talk_text(in, len, &v) == TALK_OK, "valid UTF-8 is accepted");
    expect(v != NULL && talk_value_kind(v) == TALK_KIND_TEXT, "the value is text");
    expect(v != NULL && talk_value_as_text(v, &s, &n), "text reads back");
    expect(n == want_len && memcmp(s, want, n) == 0, want);
    talk_value_release(v);
}

static void expect_text(const char *in, size_t len, const char *want) {
    expect_text_n(in, len, want, strlen(want));
}

static void expect_refused(const char *in, size_t len, const char *what) {
    talk_value *v = (talk_value *)&failures;
    expect(talk_text(in, len, &v) == TALK_INVALID_VALUE, what);
    expect(v == NULL, "a refusal builds no value");
}

static void expect_pending_nothing(talk_pending *pending, const char *what) {
    expect(talk_pending_done(pending), what);
    talk_value *value = NULL;
    expect(talk_pending_result(pending, &value) == TALK_OK && talk_value_kind(value) == TALK_KIND_NOTHING, what);
    talk_value_release(value);
}

/* Collects the Trace's lines, one per call. */
static char trace[4096];
static size_t trace_len = 0;
static void record(void *context, const char *line, size_t len) {
    (void)context;
    if (trace_len + len + 1 < sizeof trace) {
        memcpy(trace + trace_len, line, len);
        trace_len += len;
        trace[trace_len++] = '\n';
    }
}

/* A Host's whole life with one Script: a Request, a Pump and its result. */
static int group_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable total = 0\non bump n\n  add n to total\n  return total & \"!\"\nend bump\n";
    talk_load_options load = {"adder", 5, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    if (talk_load(group, &load, &script) != TALK_OK) return 1;
    int bad = 0;
    talk_value *n = NULL;
    talk_int(41, &n);
    talk_value *args[] = {n};
    talk_message message = {"bump", 4, args, 1, NULL};
    talk_pending *pending = NULL;
    talk_owned_bytes id = {0};
    bad |= talk_script_request(script, &message, &id, &pending) != TALK_OK;
    bad |= id.len != 2 || memcmp(id.data, "d1", 2) != 0;
    bad |= talk_pending_done(pending);
    const char *named = NULL;
    size_t named_len = 0;
    talk_name(group, &named, &named_len);
    bad |= named_len != 1 || memcmp(named, "g", 1) != 0;
    talk_script_name(script, &named, &named_len);
    bad |= named_len != 5 || memcmp(named, "adder", 5) != 0;
    talk_owned_bytes_release(&id);
    talk_value_release(n);
    talk_pump_result pumped = {0};
    bad |= talk_pump(group, 1790000000, 0, NULL, &pumped) != TALK_OK;
    bad |= pumped.state != TALK_IDLE || pumped.fuel_used <= 0 || pumped.has_next_deadline;
    /* The Run starts, ends with its result, then the accounting tail: its
     * Fuel and its root's work. */
    const talk_report *reports = NULL;
    bad |= talk_reports_items(pumped.reports, &reports) != 4;
    if (!bad) {
        bad |= reports[0].kind != TALK_REPORT_RUN_STARTED || reports[2].kind != TALK_REPORT_RUN_ACCOUNTING || reports[3].kind != TALK_REPORT_CAUSAL_WORK;
        const talk_run_end *end = &reports[1].as.run_end;
        const char *shown = NULL;
        size_t shown_len = 0;
        bad |= reports[1].kind != TALK_REPORT_RUN_END || end->outcome != TALK_COMPLETED;
        bad |= end->run_len != 8 || memcmp(end->run, "adder/r1", 8) != 0 || end->delivery_len != 2 || memcmp(end->delivery, "d1", 2) != 0;
        bad |= !talk_value_as_text(end->result, &shown, &shown_len) || shown_len != 3 || memcmp(shown, "41!", 3) != 0;
    }
    talk_reports_release(pumped.reports);
    talk_value *result = NULL;
    const char *text = NULL;
    size_t len = 0;
    bad |= !talk_pending_done(pending);
    bad |= talk_pending_result(pending, &result) != TALK_OK;
    bad |= !talk_value_as_text(result, &text, &len) || len != 3 || memcmp(text, "41!", 3) != 0;
    talk_value_release(result);
    talk_inspect(group, NULL);
    bad |= strstr(trace, "vars adder total=41\n") == NULL;
    talk_load_options broken = {"broken", 6, "on t\n  put 1 into 3\nend t\n", 26, NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *refused = NULL;
    bad |= talk_load(group, &broken, &refused) != TALK_LOAD_REFUSED || refused != NULL;
    bad |= strstr(trace, "diag broken code=\"not a container\" pos=2:14\n") == NULL;
    /* Public Loads always check their Grant environment, even when empty. */
    const char *ungranted_source = "on go\n ask api to read \"x\"\nend go\n";
    talk_load_options ungranted = {"ungranted", 9, ungranted_source, strlen(ungranted_source), NULL, 0, false, NULL, NULL, 0, NULL};
    bad |= talk_load(group, &ungranted, &refused) != TALK_LOAD_REFUSED || refused != NULL;
    bad |= strstr(trace, "diag ungranted code=\"unknown operation\"") == NULL;
    talk_pending_release(pending);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Combined calls keep their worker until final Trace observation. */
struct combined_observer {
    talk_group *group;
    talk_script *script;
    int probe, ready;
};

static void combined_record(void *context, const char *line, size_t len) {
    struct combined_observer *observer = context;
    record(NULL, line, len);
    if (!observer->probe) return;
    observer->probe = 0;
    talk_message ping = {"ping", 4, NULL, 0, NULL};
    talk_owned_bytes id = {0};
    talk_pending *pending = NULL;
    talk_pump_result result = {0};
    expect(talk_script_request_pump(observer->script, &ping, 10, 0, NULL, &id, &pending, &result) == TALK_REENTRANT_CALL,
           "final Trace still holds the combined worker");
    expect(id.data == NULL && pending == NULL && result.reports == NULL,
           "competing combined worker admits nothing");
}

static void combined_ready(void *context) {
    struct combined_observer *observer = context;
    observer->ready++;
    uint8_t fingerprint[32];
    expect(talk_fingerprint(observer->group, fingerprint) == TALK_OK,
           "Pump refusal publishes readiness after worker release");
}

static void combined_number(talk_pending *pending, int64_t want) {
    talk_value *value = NULL;
    const talk_decimal *decimal = NULL;
    int64_t number = 0;
    expect(talk_pending_done(pending) && talk_pending_result(pending, &value) == TALK_OK &&
           talk_value_as_dec(value, &decimal) && talk_decimal_int64(decimal, &number) == TALK_OK && number == want,
           "combined Pending has its ordinary result");
    talk_value_release(value);
}

static int combined_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    struct combined_observer observer = {0};
    talk_group_options options = {"combined", 8, combined_record, &observer, NULL, 0, 0};
    if (talk_new_group(core, &options, &observer.group) != TALK_OK) return 1;
    talk_group *group = observer.group;
    talk_group_on_ready(group, combined_ready, &observer);
    talk_object_kind_def kind_def = {"item", 4, NULL, 0, NULL, NULL, 0, NULL};
    talk_object_kind *kind = NULL;
    expect(talk_define_object_kind(core, &kind_def, &kind) == TALK_OK, "combined Object kind");
    talk_object *owner = NULL, *child = NULL;
    expect(talk_group_object(group, kind, "owner", 5, NULL, &owner) == TALK_OK, "combined owner");
    expect(talk_group_object(group, kind, "child", 5, NULL, &child) == TALK_OK, "combined child");
    expect(talk_set_parent(group, child, owner) == TALK_OK, "combined path");
    const char *source =
        "script variable total = 0\n"
        "function sum a, b = 5\n return a + b\nend sum\n"
        "on exported\n return sum\nend exported\n"
        "on ping\n add 1 to total\n return total\nend ping\n"
        "on slow\n repeat 100 times\n end repeat\n return 42\nend slow\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, owner, NULL, 0, NULL};
    expect(talk_load(group, &load, &observer.script) == TALK_OK, "load combined Script");
    talk_script *script = observer.script;
    talk_message ping = {"ping", 4, NULL, 0, NULL};
    talk_pending *earlier = NULL, *pending = NULL;
    expect(talk_script_request(script, &ping, NULL, &earlier) == TALK_OK, "earlier Request");
    talk_owned_bytes id = {0};
    talk_pump_result result = {0};
    observer.probe = 1;
    expect(talk_script_request_pump(script, &ping, 10, 0, NULL, &id, &pending, &result) == TALK_OK, "combined Script Request");
    expect(id.len == 2 && memcmp(id.data, "d2", 2) == 0 && result.reports != NULL && !observer.probe, "combined id, Reports and final callback");
    combined_number(earlier, 1);
    combined_number(pending, 2);
    expect(observer.ready == 0, "combined initial admission omits OnReady");
    talk_pending_release(earlier);
    talk_pending_release(pending);
    talk_reports_release(result.reports);
    talk_owned_bytes_release(&id);
    expect(talk_request_pump(group, child, &ping, 10, 0, NULL, NULL, &pending, NULL) == TALK_OK, "combined Object Request climbs");
    combined_number(pending, 3);
    talk_pending_release(pending);
    talk_message invalid = {"ping:", 5, NULL, 0, NULL};
    expect(talk_script_request(script, &ping, NULL, &earlier) == TALK_OK, "work before refused admission");
    expect(talk_script_request_pump(script, &invalid, 10, 0, NULL, &id, &pending, &result) == TALK_INVALID_VALUE &&
           id.data == NULL && pending == NULL && result.reports == NULL && !talk_pending_done(earlier), "admission refusal does not Pump");
    talk_pending_release(earlier);
    talk_pump_options invalid_options = {-1, 0};
    for (int i = 0; i < 3; i++) {
        expect(talk_script_request_pump(script, &ping, i == 0 ? 9 : 10, i == 2 ? -1 : 0,
               i == 1 ? &invalid_options : NULL, &id, &pending, &result) == (i == 0 ? TALK_CLOCK_BACKWARDS : TALK_INVALID_VALUE), "combined Pump refusal");
        expect(id.len != 0 && pending != NULL && result.reports == NULL && !talk_pending_done(pending), "Pump refusal retains admission");
        expect(observer.ready == i + 1, "Pump refusal notifies once");
        expect(talk_pump(group, 10, 0, NULL, NULL) == TALK_OK && talk_pending_done(pending), "later Pump executes retained input");
        talk_pending_release(pending);
        talk_owned_bytes_release(&id);
    }
    talk_message slow = {"slow", 4, NULL, 0, NULL};
    talk_pump_options slice = {1, 0};
    expect(talk_script_request_pump(script, &slow, 10, 0, &slice, &id, &pending, &result) == TALK_OK &&
           result.state == TALK_SLICED && !talk_pending_done(pending), "combined call performs only one Pump");
    talk_reports_release(result.reports);
    expect(talk_cancel_delivery(group, (const char *)id.data, id.len) == TALK_OK && talk_pump(group, 10, 0, NULL, NULL) == TALK_OK,
           "combined Pending cancellation uses ordinary delivery id");
    expect_pending_nothing(pending, "cancelled combined Request settles");
    talk_pending_release(pending);
    talk_owned_bytes_release(&id);
    talk_message exported = {"exported", 8, NULL, 0, NULL};
    expect(talk_script_request_pump(script, &exported, 10, 0, NULL, NULL, &pending, NULL) == TALK_OK, "export Function with combined Request");
    talk_value *fn = NULL, *two = NULL;
    expect(talk_pending_result(pending, &fn) == TALK_OK, "read Function");
    talk_pending_release(pending);
    talk_int(2, &two);
    talk_value *args[] = {two};
    expect(talk_call_pump(group, fn, args, 1, NULL, 10, 0, NULL, NULL, &pending, NULL) == TALK_OK, "combined Function call retains defaults");
    combined_number(pending, 7);
    talk_pending_release(pending);
    expect(talk_call_pump(group, fn, NULL, 0, NULL, 10, 0, NULL, &id, &pending, &result) == TALK_OK && pending != NULL && id.len != 0,
           "wrong arity is admitted");
    const talk_report *reports = NULL;
    size_t count = talk_reports_items(result.reports, &reports);
    int wrong_arity = 0;
    for (size_t i = 0; i < count; i++) if (reports[i].kind == TALK_REPORT_RUN_END) {
        const talk_run_end *end = &reports[i].as.run_end;
        if (end->outcome == TALK_ERRORED && end->error != NULL && end->error->code_len == 11 && memcmp(end->error->code, "wrong arity", 11) == 0) wrong_arity = 1;
    }
    expect(wrong_arity, "wrong arity fails during execution");
    talk_reports_release(result.reports);
    talk_pending_release(pending);
    talk_owned_bytes_release(&id);
    const char *replacement = "on ping\nend ping\n";
    expect(talk_script_reload(script, replacement, strlen(replacement), TALK_RESET_VARIABLES, NULL, NULL) == TALK_OK, "stale combined Function");
    expect(talk_call_pump(group, fn, NULL, 0, NULL, 10, 0, NULL, &id, &pending, NULL) == TALK_OK && pending != NULL && id.len != 0,
           "stale Function admitted before drain");
    expect_pending_nothing(pending, "stale Function settles unsuccessfully at drain");
    talk_pending_release(pending);
    talk_owned_bytes_release(&id);
    talk_value_release(two);
    talk_value_release(fn);
    talk_group_release(group);
    talk_core_release(core);
    return 0;
}

/* Failed Requests and Function calls still end their direct C Pending. */
static int pending_failure_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source =
        "script variable errors = 0\n"
        "function fail\n  throw {code: \"mine\"}\nend fail\n"
        "on exported\n  return fail\nend exported\n"
        "on go\n  throw {code: \"mine\"}\nend go\n"
        "on error e\n  add 1 to errors\nend error\n"
        "on countErrors\n  return errors\nend countErrors\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    if (talk_load(group, &load, &script) != TALK_OK) return 1;
    talk_message exported = {"exported", 8, NULL, 0, NULL};
    talk_pending *made = NULL;
    expect(talk_script_request(script, &exported, NULL, &made) == TALK_OK, "request a Function Value");
    expect(talk_pump(group, 1790000000, 0, NULL, NULL) == TALK_OK, "pump the Function Value export");
    talk_value *fn = NULL;
    expect(talk_pending_result(made, &fn) == TALK_OK && talk_value_kind(fn) == TALK_KIND_FUNCTION, "export returns a Function Value");
    for (int call = 0; call < 2; ++call) {
        talk_pending *pending = NULL;
        talk_message message = {"go", 2, NULL, 0, NULL};
        expect((call ? talk_group_call(group, fn, NULL, 0, NULL, NULL, &pending)
                     : talk_script_request(script, &message, NULL, &pending)) == TALK_OK, "admit the failing Request or Function call");
        expect(!talk_pending_done(pending), "the failing Pending starts open");
        talk_pump_result pumped = {0};
        expect(talk_pump(group, 1790000000, 0, NULL, &pumped) == TALK_OK && pumped.state == TALK_IDLE, "pump the failing Run to idle");
        const talk_report *reports = NULL;
        size_t count = talk_reports_items(pumped.reports, &reports);
        int errored = 0;
        for (size_t i = 0; i < count; ++i) {
            if (reports[i].kind == TALK_REPORT_RUN_END && reports[i].as.run_end.outcome == TALK_ERRORED) {
                const talk_script_error *error = reports[i].as.run_end.error;
                expect(error != NULL && error->code_len == 4 && memcmp(error->code, "mine", 4) == 0, "the typed Report preserves the thrown error");
                errored++;
            }
        }
        expect(errored == 1, "the failing Run still reports errored");
        talk_reports_release(pumped.reports);
        expect_pending_nothing(pending, call ? "a failed Function call settles its Pending" : "a failed message Request settles its Pending");
        talk_pending_release(pending);
    }
    talk_message count_errors = {"countErrors", 11, NULL, 0, NULL};
    talk_pending *counted = NULL;
    expect(talk_script_request(script, &count_errors, NULL, &counted) == TALK_OK, "request the error Handler count");
    expect(talk_pump(group, 1790000000, 0, NULL, NULL) == TALK_OK, "pump after the failed Requests");
    talk_value *count = NULL;
    const talk_decimal *decimal = NULL;
    int64_t integer = 0;
    expect(talk_pending_result(counted, &count) == TALK_OK && talk_value_as_dec(count, &decimal) && talk_decimal_int64(decimal, &integer) == TALK_OK && integer == 2, "both failed Runs still send their error message");
    talk_value_release(count);
    talk_pending_release(counted);
    const char *replacement = "on go\nend go\n";
    expect(talk_script_reload(script, replacement, strlen(replacement), TALK_RESET_VARIABLES, NULL, NULL) == TALK_OK, "reload makes the Function Value stale");
    talk_pending *stale = NULL;
    expect(talk_group_call(group, fn, NULL, 0, NULL, NULL, &stale) == TALK_OK, "admit a stale Function call");
    expect(!talk_pending_done(stale), "the stale call waits for a Pump");
    expect(talk_pump(group, 1790000000, 0, NULL, NULL) == TALK_OK, "pump the stale Function call without a Run");
    expect_pending_nothing(stale, "a stale Function call settles without starting a Run");
    talk_pending_release(stale);
    talk_value_release(fn);
    talk_pending_release(made);
    talk_group_release(group);
    talk_core_release(core);
    return 0;
}

/* A released handle takes its result with it, settled or not, so a
 * long-lived Group's memory doesn't grow with each Request (#1103). */
static int pending_release_test(void) {
    talk_core *core = talk_new();
    talk_group *group = NULL;
    talk_group_options options = {"released", 8, NULL, NULL, NULL, 0, 0};
    expect(talk_new_group(core, &options, &group) == TALK_OK, "make a Group for released Requests");
    const char *source = "on ping n\n return n + 1\nend ping\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    expect(talk_load(group, &load, &script) == TALK_OK, "load the ping Script");
    talk_value *n = NULL;
    expect(talk_int(41, &n) == TALK_OK, "make the argument");
    talk_value *args[1] = {n};
    talk_message ping = {"ping", 4, args, 1, NULL};
    size_t before = 0;
    for (int i = 0; i < 400; i++) {
        talk_pending *pending = NULL;
        expect(talk_script_request(script, &ping, NULL, &pending) == TALK_OK, "request ping");
        /* Odd Requests end their handle before they settle. */
        if (i % 2) talk_pending_release(pending);
        talk_pump_result pumped = {0};
        expect(talk_pump(group, 1790000000, 0, NULL, &pumped) == TALK_OK, "pump the ping");
        talk_reports_release(pumped.reports);
        if (i % 2 == 0) {
            talk_value *result = NULL;
            expect(talk_pending_result(pending, &result) == TALK_OK && result != NULL, "read the ping result");
            talk_value_release(result);
            talk_pending_release(pending);
        }
        /* Halfway, the Group's tables have reached their size. */
        if (i == 199) {
            talk_memory memory;
            talk_group_memory(group, &memory);
            before = memory.used;
        }
    }
    talk_memory after;
    talk_group_memory(group, &after);
    expect(after.used <= before, "released Requests leave no results behind");
    talk_value_release(n);
    talk_group_release(group);
    talk_core_release(core);
    return 0;
}

/* Settlement follows the Delivery's final outcome, including lifecycle
 * discards without run end. Kept mailboxes and Rewind retain the Request. */
static int pending_terminal_test(void) {
    enum action { NONE, DROP, CANCEL_QUEUED, CANCEL_LIVE, STOP_QUEUED, STOP_LIVE, RELOAD_QUEUED, RELOAD_LIVE, KEEP_QUEUED, REWIND, REWIND_DROP };
    const char *waiting = "on go\n wait 1 s\nend go\n";
    const char *returning = "on go\nend go\n";
    const struct {
        const char *name;
        const char *source;
        enum action action;
        int outcome;
    } cases[] = {
        {"successful Nothing settles", returning, NONE, TALK_COMPLETED},
        {"a Limit Fault settles", "on go\n repeat forever\n end repeat\nend go\n", NONE, TALK_LIMIT_FAULT},
        {"an unhandled Request settles", "on other\nend other\n", NONE, TALK_UNHANDLED_OUTCOME},
        {"a dropped Request settles", "on go, dropping\n wait 1 s\nend go\n", DROP, TALK_DROPPED},
        {"mailbox cancellation settles", waiting, CANCEL_QUEUED, TALK_CANCELLED},
        {"live cancellation settles", waiting, CANCEL_LIVE, TALK_CANCELLED},
        {"Stop drops and settles a queued Request", waiting, STOP_QUEUED, -1},
        {"Stop discards and settles a live Request", waiting, STOP_LIVE, -1},
        {"Reload preserves an undrained Request", waiting, RELOAD_QUEUED, TALK_COMPLETED},
        {"Reload discards and settles a live Request", waiting, RELOAD_LIVE, -1},
        {"a kept Request settles after dispatch", waiting, KEEP_QUEUED, TALK_COMPLETED},
        {"a rewound Request settles after redispatch", "on go\n repeat forever\n end repeat\nend go\n", REWIND, TALK_COMPLETED},
        {"Reload drops and settles a rewound mailbox Request", "on go\n repeat forever\n end repeat\nend go\n", REWIND_DROP, -1},
    };
    for (size_t c = 0; c < sizeof cases / sizeof cases[0]; ++c) {
        talk_core *core = talk_new();
        if (core == NULL) return 1;
        talk_group *group = NULL;
        talk_group_options options = {"g", 1, NULL, NULL, NULL, 0, 0};
        if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
        talk_limits limits = {0};
        limits.fuel_per_run = 1000;
        talk_load_options load = {"s", 1, cases[c].source, strlen(cases[c].source), NULL, 0, false, NULL, NULL, 0, &limits};
        talk_script *script = NULL;
        if (talk_load(group, &load, &script) != TALK_OK) return 1;
        talk_message message = {"go", 2, NULL, 0, NULL};
        enum action action = cases[c].action;
        if (action == DROP) expect(talk_script_deliver(script, &message, NULL) == TALK_OK, "occupy the dropping clause");
        talk_pending *pending = NULL;
        talk_owned_bytes id = {0};
        expect(talk_script_request(script, &message, &id, &pending) == TALK_OK, "admit a terminal-outcome Request");
        expect(!talk_pending_done(pending), "a queued Request is open");
        if (action == CANCEL_LIVE || action == STOP_LIVE || action == RELOAD_LIVE || action == REWIND || action == REWIND_DROP) {
            talk_pump_options slice = {20, 0};
            expect(talk_pump(group, 1790000000, 0, &slice, NULL) == TALK_OK, "start a live Request");
            expect(!talk_pending_done(pending), "a suspended or preempted Request stays open");
        }
        if (action == CANCEL_QUEUED || action == CANCEL_LIVE) expect(talk_cancel_delivery(group, (const char *)id.data, id.len) == TALK_OK, "cancel the Request");
        if (action == STOP_QUEUED || action == STOP_LIVE) expect(talk_script_stop(script, "done", 4) == TALK_OK, "stop the Request's Script");
        if (action == REWIND || action == REWIND_DROP) {
            expect(talk_script_rewind_run(script, "s/r1", 4) == TALK_OK, "rewind the preempted Run");
            talk_pump_result rewound = {0};
            expect(talk_pump(group, 1790000000, 0, NULL, &rewound) == TALK_OK && rewound.state == TALK_REWOUND, "the Pump returns rewound");
            talk_reports_release(rewound.reports);
            expect(!talk_pending_done(pending), "Rewind keeps the original Request open");
        }
        if (action == RELOAD_QUEUED || action == RELOAD_LIVE || action == KEEP_QUEUED || action == REWIND || action == REWIND_DROP) {
            talk_reload_options reload = {action == KEEP_QUEUED || action == REWIND};
            expect(talk_script_reload(script, returning, strlen(returning), TALK_RESET_VARIABLES, &reload, NULL) == TALK_OK, "reload the Request's Script");
            expect(talk_pending_done(pending) == (action == RELOAD_LIVE || action == REWIND_DROP), "Reload settles discards and retains kept mailbox or undrained Requests");
        }
        talk_pump_result pumped = {0};
        expect(talk_pump(group, 1790000000, 0, NULL, &pumped) == TALK_OK, "pump the terminal outcome");
        const talk_report *reports = NULL;
        size_t count = talk_reports_items(pumped.reports, &reports);
        int found = 0;
        for (size_t i = 0; i < count; ++i) {
            if (reports[i].kind != TALK_REPORT_RUN_END) continue;
            const talk_run_end *end = &reports[i].as.run_end;
            if (end->delivery_len == id.len && memcmp(end->delivery, id.data, id.len) == 0) {
                expect((int)end->outcome == cases[c].outcome, "the Request keeps its typed terminal outcome");
                found++;
            }
        }
        expect(found == (cases[c].outcome < 0 ? 0 : 1), "terminal Reports are neither lost nor duplicated");
        talk_reports_release(pumped.reports);
        expect_pending_nothing(pending, cases[c].name);
        expect(talk_pump(group, 1790000000, 0, NULL, NULL) == TALK_OK && talk_pending_done(pending), "settlement survives another Pump");
        talk_owned_bytes_release(&id);
        talk_pending_release(pending);
        talk_group_release(group);
        talk_core_release(core);
    }
    return 0;
}

/* An immediate Operation's Do: the text, doubled, or a Script error for "". */
static talk_call_end twice(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context;
    const char *s = NULL, *grant = NULL;
    size_t n = 0, grant_len = 0;
    talk_call_grant_name(call, &grant, &grant_len);
    if (len != 1 || !talk_value_as_text(args[0], &s, &n) || grant_len != 4 || memcmp(grant, "echo", 4) != 0) return TALK_CALL_BROKEN;
    if (n == 0) {
        *error = (talk_script_error){"empty", 5, "nothing to echo", 15, NULL};
        return TALK_CALL_FAILED;
    }
    if (talk_call_charge(call, 3) != TALK_OK) return TALK_CALL_LIMITED;
    char doubled[64];
    memcpy(doubled, s, n);
    memcpy(doubled + n, s, n);
    return talk_text(doubled, 2 * n, result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_BROKEN;
}

/* A Capability defined, granted and called through talk.h alone. */
static int capability_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "echo", 4, ops, 1, NULL, 0, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    bad |= talk_grant_capability(grant) != def;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const char *source = "script variable said\non go s\n  try\n    ask echo to twice s\n    put it into said\n  catch e\n    put e's code into said\n  end try\nend go\n";
    talk_load_options load = {"caller", 6, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    const char *inputs[] = {"ab", ""};
    for (int i = 0; i < 2; i++) {
        talk_value *text = NULL;
        talk_text(inputs[i], strlen(inputs[i]), &text);
        talk_value *message_args[] = {text};
        talk_message message = {"go", 2, message_args, 1, NULL};
        bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
        talk_value_release(text);
        bad |= talk_pump(group, 1790000000 + i, 0, NULL, NULL) != TALK_OK;
        talk_inspect(group, NULL);
    }
    bad |= strstr(trace, "call caller/r1.c1 op=echo.twice args=[\"ab\"] result=\"abab\" charged=3\n") == NULL;
    bad |= strstr(trace, "vars caller said=\"abab\"\n") == NULL;
    bad |= strstr(trace, "call caller/r2.c1 op=echo.twice args=[\"\"] error={code: \"empty\", message: \"nothing to echo\"}\n") == NULL;
    bad |= strstr(trace, "vars caller said=\"empty\"\n") == NULL;
    const char *wrong_source = "on go\n  ask echo to twice 5\nend go\n";
    talk_load_options wrong = {"wrong", 5, wrong_source, strlen(wrong_source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *refused = NULL;
    bad |= talk_load(group, &wrong, &refused) != TALK_LOAD_REFUSED;
    bad |= strstr(trace, "diag wrong code=\"wrong argument\" pos=2:21\n") == NULL;
    /* A Library is checked against declarations, not a Grant: here those
     * the definition gives, and a hand-written pair. */
    talk_operation_check checks[2];
    bad |= talk_capability_def_checks(def, NULL, 0) != 1 || talk_capability_def_checks(def, checks, 2) != 1;
    bad |= checks[0].name_len != 5 || memcmp(checks[0].name, "twice", 5) != 0 || checks[0].mode != TALK_IMMEDIATE || checks[0].args_len != 1;
    const talk_shape *number_args[] = {talk_number_shape()};
    talk_operation_check by_hand[] = {{"twice", 5, TALK_IMMEDIATE, number_args, 1, false}};
    talk_grant_decls from_def[] = {{"echo", 4, checks, 1}};
    talk_grant_decls handwritten[] = {{"echo", 4, by_hand, 1}};
    const char *lib_text = "function shout s\n  ask echo to twice \"a\"\n  return it\nend shout\n";
    talk_library_source lib_src = {"shouts", 6, "1", 1, lib_text, strlen(lib_text)};
    talk_library *lib = NULL;
    bad |= talk_compile_library(core, &lib_src, NULL, 0, from_def, 1, &lib, NULL) != TALK_OK;
    lib_src.name = "numbers";
    lib_src.name_len = 7;
    bad |= talk_compile_library(core, &lib_src, NULL, 0, handwritten, 1, &lib, NULL) != TALK_LOAD_REFUSED;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Whether bytes hold a text. */
static bool holds(const talk_owned_bytes *b, const char *text) {
    size_t n = strlen(text);
    for (size_t i = 0; b->data != NULL && i + n <= b->len; i++) {
        if (memcmp(b->data + i, text, n) == 0) return true;
    }
    return false;
}

/* A Host Command (ADR 0094): an Operation declared `command`, called by its
 * name alone as the `ask` it stands for. A Reserved Word can't be one. The
 * flag reaches a Library's checks and the Host Manifest. */
static int host_command_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    talk_operation reserved[] = {{"if", 2, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, true}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "bad", 3, reserved, 1, NULL, 0, &def) != TALK_INVALID_VALUE;
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, true}};
    bad |= talk_define_capability(core, "echo", 4, ops, 1, NULL, 0, &def) != TALK_OK;
    if (bad) return bad;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const char *source = "script variable said\non go s\n  twice s\n  put it into said\nend go\n";
    talk_load_options load = {"caller", 6, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_value *text = NULL;
    talk_text("ab", 2, &text);
    talk_value *message_args[] = {text};
    talk_message message = {"go", 2, message_args, 1, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    talk_value_release(text);
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "call caller/r1.c1 op=echo.twice args=[\"ab\"] result=\"abab\" charged=3\n") == NULL;
    bad |= strstr(trace, "vars caller said=\"abab\"\n") == NULL;
    /* Checked at load as the `ask` it stands for. */
    const char *wrong_source = "on go\n  twice 5\nend go\n";
    talk_load_options wrong = {"wrong", 5, wrong_source, strlen(wrong_source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *refused = NULL;
    bad |= talk_load(group, &wrong, &refused) != TALK_LOAD_REFUSED;
    bad |= strstr(trace, "diag wrong code=\"wrong argument\" pos=2:9\n") == NULL;
    /* A Library resolves it against its declarations, and needs it. */
    talk_operation_check checks[1];
    bad |= talk_capability_def_checks(def, checks, 1) != 1 || !checks[0].command;
    talk_grant_decls from_def[] = {{"echo", 4, checks, 1}};
    const char *lib_text = "function shout s\n  twice \"a\"\n  return it\nend shout\n";
    talk_library_source lib_src = {"shouts", 6, "1", 1, lib_text, strlen(lib_text)};
    talk_library *lib = NULL;
    bad |= talk_compile_library(core, &lib_src, NULL, 0, from_def, 1, &lib, NULL) != TALK_OK;
    talk_manifest_spec spec = {"demo", 4, "1", 1, grants, 1, &lib, 1, NULL, 0, NULL, 0, NULL, 0};
    talk_owned_bytes written = {0};
    bad |= talk_export_manifest(&spec, &written) != TALK_OK;
    const char *flagged = "\"cost\":{\"fuel\":7,\"alloc\":0},\"command\":true}";
    const char *needs = "\"needs\":[{\"capability\":\"echo\",\"operation\":\"twice\"}]";
    bad |= !holds(&written, flagged) || !holds(&written, needs);
    if (bad) fprintf(stderr, "%s\n%.*s\n", trace, (int)written.len, written.data);
    talk_owned_bytes_release(&written);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A release hook: counts its calls and keeps what the last one was told. */
static int released = 0;
static int lifecycle_reentry_bad = 0;
static int lifecycle_reentry_seen = 0;

/* Worker calls are refused before touching output or the outer Trace,
 * including while Reload performs lifecycle work outside a Pump. */
static void check_lifecycle_reentry(talk_group *group) {
    talk_owned_bytes saved = {0};
    unsigned char fingerprint[32];
    lifecycle_reentry_seen++;
    lifecycle_reentry_bad |= talk_pump(group, 0, 0, NULL, NULL) != TALK_REENTRANT_CALL;
    lifecycle_reentry_bad |= talk_save(group, &saved) != TALK_REENTRANT_CALL;
    lifecycle_reentry_bad |= saved.data != NULL || saved.len != 0;
    lifecycle_reentry_bad |= talk_fingerprint(group, fingerprint) != TALK_REENTRANT_CALL;
    lifecycle_reentry_bad |= talk_inspect(group, NULL) != TALK_REENTRANT_CALL;
}
static talk_release_reason released_reason = TALK_RELEASE_STOP;
static char released_grant[16];
static void release(void *context, const talk_grant_context *g) {
    (void)context;
    check_lifecycle_reentry(g->group);
    released++;
    released_reason = g->reason;
    snprintf(released_grant, sizeof released_grant, "%.*s", (int)g->grant_name_len, g->grant_name);
}

/* revoke releases a Grant once, and later calls through it raise
 * capability revoked before reaching the Host. */
static int revoke_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    talk_capability_def *def = NULL;
    /* One release hook, given with the definition. */
    talk_capability_option none[] = {talk_with_release_hook(NULL, NULL)};
    talk_capability_option twice_over[] = {talk_with_release_hook(release, NULL), talk_with_release_hook(release, NULL)};
    talk_capability_option hooked[] = {talk_with_release_hook(release, NULL)};
    int bad = talk_define_capability(core, "echo", 4, ops, 1, none, 1, &def) != TALK_INVALID_VALUE;
    bad |= talk_define_capability(core, "echo", 4, ops, 1, twice_over, 2, &def) != TALK_INVALID_VALUE;
    bad |= talk_define_capability(core, "echo", 4, ops, 1, hooked, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const char *source = "script variable said\non go\n  try\n    ask echo to twice \"ab\"\n  catch e\n    put e's code into said\n  end try\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    /* A revoked Grant is still kept until a Reload removes it. */
    for (int revoked = 0; revoked < 2; revoked++) {
        const talk_script_grant *kept = NULL;
        bad |= talk_script_grants(script, &kept) != 1;
        if (!bad) bad |= kept[0].name_len != 4 || memcmp(kept[0].name, "echo", 4) != 0 || kept[0].operations_len != 1 || kept[0].operations[0].len != 5 || memcmp(kept[0].operations[0].data, "twice", 5) != 0;
        if (!revoked) bad |= talk_script_revoke(script, "echo", 4) != TALK_OK;
    }
    released = 0;
    bad |= talk_script_revoke(script, "echo", 4) != TALK_OK;
    bad |= talk_script_revoke(script, "other", 5) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= released != 1 || released_reason != TALK_RELEASE_REVOKE || strcmp(released_grant, "echo") != 0 || lifecycle_reentry_bad;
    bad |= strstr(trace, "> revoke s grant=echo\n> revoke s grant=echo\n> revoke s grant=other\n") == NULL;
    bad |= strstr(trace, "call s/r1.c1") != NULL;
    bad |= strstr(trace, "vars s said=\"capability revoked\"\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A lifecycle Operation's Do: what each call saw, as "<scope> <run>
 * <segment> <automatic>" lines. */
static char lifecycle_seen[512];
static talk_call_end lifecycle(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)args; (void)len; (void)error;
    check_lifecycle_reentry(talk_call_group(call));
    const char *scope = NULL, *run = NULL, *segment = NULL;
    size_t scope_len = 0, run_len = 0, segment_len = 0;
    talk_call_scope_name(call, &scope, &scope_len);
    talk_call_run_id(call, &run, &run_len);
    talk_call_segment_id(call, &segment, &segment_len);
    size_t at = strlen(lifecycle_seen);
    snprintf(lifecycle_seen + at, sizeof lifecycle_seen - at, "%.*s %.*s %.*s %s\n", (int)scope_len, scope, (int)run_len, run, (int)segment_len, segment, talk_call_automatic(call) ? "yes" : "no");
    if (talk_call_automatic(call) && talk_call_charge(call, 1) == TALK_OK) return TALK_CALL_BROKEN;
    return talk_nothing(result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_BROKEN;
}

/* A Capability Scope: refused declarations and Grants, the call's
 * ownership context, and abandonment as its Run ends. */
static int scope_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    lifecycle_seen[0] = 0;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_scope_decl opens = {"file", 4, "close", 5, NULL, 0};
    talk_scope_decl closes = {NULL, 0, NULL, 0, "file", 4};
    talk_scope_decl opens_lock = {"file", 4, "unlock", 6, NULL, 0};
    const talk_shape *one[] = {talk_text_shape()};
    talk_capability_def *def = NULL;
    int bad = 0;
    /* An opener whose abandonment Operation is missing, takes arguments,
     * closes another scope or disagrees with another opener's. */
    talk_operation missing[] = {{"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    bad |= talk_define_capability(core, "a", 1, missing, 1, NULL, 0, &def) != TALK_INVALID_VALUE;
    talk_operation with_args[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
        {"close", 5, one, 1, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
    };
    bad |= talk_define_capability(core, "b", 1, with_args, 2, NULL, 0, &def) != TALK_INVALID_VALUE;
    talk_operation disagreeing[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
        {"reopen", 6, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens_lock, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
        {"close", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
        {"unlock", 6, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
    };
    bad |= talk_define_capability(core, "c", 1, disagreeing, 4, NULL, 0, &def) != TALK_INVALID_VALUE;
    /* A suspending lifecycle Operation, and a Segment-bound one with no
     * Segment Coordinator. */
    talk_operation suspending[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_SUSPENDING, 0, NULL, 0, lifecycle, NULL, &opens, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
        {"close", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
    };
    bad |= talk_define_capability(core, "d", 1, suspending, 2, NULL, 0, &def) != TALK_INVALID_VALUE;
    talk_operation bound[] = {{"change", 6, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, NULL, true, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    bad |= talk_define_capability(core, "e", 1, bound, 1, NULL, 0, &def) != TALK_INVALID_VALUE;

    talk_operation ops[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
        {"close", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false, NULL, 0, NULL, 0, NULL, NULL, 0, false},
    };
    bad |= talk_define_capability(core, "files", 5, ops, 2, NULL, 0, &def) != TALK_OK;
    /* A Grant keeps an opener's abandonment Operation. */
    talk_grant *grant = NULL;
    const char *names[] = {"open"};
    size_t lens[] = {4};
    bad |= talk_capability_def_grant(def, names, lens, 1, NULL, &grant) != TALK_INVALID_VALUE;
    const char *both[] = {"open", "close"};
    size_t both_lens[] = {4, 5};
    bad |= talk_capability_def_grant(def, both, both_lens, 2, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"out", 3, grant}};
    const char *source = "on go\n  ask out to open\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    /* The opener, then the Core's abandonment, which can't charge. */
    bad |= strcmp(lifecycle_seen, "file s/r1 s/r1.s1 no\nfile s/r1 s/r1.s1 yes\n") != 0;
    bad |= strstr(trace, "scope s/r1.c1 grant=out name=file action=opened\n") == NULL;
    bad |= strstr(trace, "call s/r1.c2 op=out.close args=[] error={} automatic=yes\nscope s/r1.c2 grant=out name=file action=failed\neffect-failure s/r1 grant=out segment=s/r1.s1 phase=abandon status=unknown scope=file\n") == NULL;
    bad |= lifecycle_reentry_bad;
    if (bad) fprintf(stderr, "%s%s", trace, lifecycle_seen);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A Segment Coordinator's hooks: what each saw, as "<phase> <first grant>
 * <segment> <enrolled>" lines, and the status commit reports. */
static char effects_seen[512];
static talk_effect_status commit_status = TALK_EFFECT_OK;
static talk_effect_result saw(const char *phase, const talk_segment_context *s) {
    check_lifecycle_reentry(s->group);
    size_t at = strlen(effects_seen);
    snprintf(effects_seen + at, sizeof effects_seen - at, "%s %.*s %.*s %zu\n", phase, (int)s->grant_name_len, s->grant_name, (int)s->segment_id_len, s->segment_id, s->grants_len);
    return (talk_effect_result){TALK_EFFECT_OK, NULL, 0};
}
static talk_effect_result begin_hook(void *context, const talk_segment_context *s) { (void)context; return saw("begin", s); }
static talk_effect_result commit_hook(void *context, const talk_segment_context *s) {
    (void)context;
    talk_effect_result r = saw("commit", s);
    r.status = commit_status;
    return r;
}
static talk_effect_result rollback_hook(void *context, const talk_segment_context *s) { (void)context; return saw("rollback", s); }
static const talk_segment_lifecycle shared_lifecycle = {begin_hook, commit_hook, rollback_hook, NULL};

/* Maps a binding of "shared" to the shared coordinator, and refuses any
 * other. */
static const talk_segment_lifecycle *coordinator_of(void *context, void *binding) {
    (void)context;
    return binding != NULL && strcmp(binding, "shared") == 0 ? &shared_lifecycle : NULL;
}

/* Segment-bound Operations: Grants sharing a coordinator join one
 * participant, which commits as the Segment ends, and a failed commit
 * restores the Script Variables. */
static int segment_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    effects_seen[0] = 0;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_operation ops[] = {{"write", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, NULL, true, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    talk_capability_def *def = NULL;
    int bad = 0;
    /* A coordinator without all three hooks, and a suspending Segment-bound
     * Operation. */
    talk_segment_lifecycle partial = {begin_hook, commit_hook, NULL, NULL};
    bad |= talk_define_segment_capability(core, "a", 1, ops, 1, &partial, NULL, 0, &def) != TALK_INVALID_VALUE;
    talk_operation suspending[] = {{"write", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_SUSPENDING, 0, NULL, 0, lifecycle, NULL, NULL, true, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    bad |= talk_define_segment_capability(core, "b", 1, suspending, 1, &shared_lifecycle, NULL, 0, &def) != TALK_INVALID_VALUE;
    bad |= talk_define_coordinated_capability(core, "db", 2, ops, 1, coordinator_of, NULL, NULL, 0, &def) != TALK_OK;
    talk_grant *refused = NULL, *one = NULL, *two = NULL;
    bad |= talk_capability_def_grant_all(def, "other", &refused) != TALK_INVALID_VALUE;
    bad |= talk_capability_def_grant_all(def, "shared", &one) != TALK_OK;
    bad |= talk_capability_def_grant_all(def, "shared", &two) != TALK_OK;
    talk_load_grant grants[] = {{"a", 1, one}, {"b", 1, two}};
    const char *source = "script variable n = 0\non go\n  ask a to write\n  ask b to write\n  add 1 to n\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 2, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    /* One begin for the first Grant; the commit sees both. */
    bad |= strcmp(effects_seen, "begin a s/r1.s1 1\ncommit a s/r1.s1 2\n") != 0;
    commit_status = TALK_EFFECT_FAILED;
    talk_pending *failed_commit = NULL;
    bad |= talk_script_request(script, &message, NULL, &failed_commit) != TALK_OK;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    expect_pending_nothing(failed_commit, "an effect-failed Request settles");
    talk_pending_release(failed_commit);
    commit_status = TALK_EFFECT_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "run s/r2 outcome=effect-failed delivery=d2 handler=go effect={grant: \"a\", segment: \"s/r2.s1\", phase: \"commit\", status: \"failed\"}") == NULL;
    bad |= strstr(effects_seen, "commit a s/r2.s1 2\nrollback a s/r2.s1 2\n") == NULL;
    /* The second Run's add was rolled back. */
    bad |= strstr(trace, "vars s n=1\n") == NULL;
    /* Outside a Pump, a preempted Segment's rollback also refuses reentry. */
    const char *spinning = "on spin\n ask a to write\n repeat forever\n end repeat\nend spin\n";
    bad |= talk_script_reload(script, spinning, strlen(spinning), TALK_RESET_VARIABLES, NULL, NULL) != TALK_OK;
    talk_message spin = {"spin", 4, NULL, 0, NULL};
    talk_pump_options slice = {40, 0};
    bad |= talk_script_deliver(script, &spin, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000002, 0, &slice, NULL) != TALK_OK;
    int before_reload = lifecycle_reentry_seen;
    bad |= talk_script_reload(script, source, strlen(source), TALK_RESET_VARIABLES, NULL, NULL) != TALK_OK;
    bad |= lifecycle_reentry_bad || lifecycle_reentry_seen <= before_reload;
    if (bad) fprintf(stderr, "%s%s", trace, effects_seen);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Broadcast admission and recipient selection share both transport paths. */
static int broadcast_selection_test(void) {
    int bad = 0;
    for (int by_delivery = 0; by_delivery < 2; by_delivery++) {
        for (int handler = 0; handler < 2; handler++) {
            talk_core *core = talk_new();
            talk_group *group = NULL;
            talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
            trace_len = 0;
            memset(trace, 0, sizeof trace);
            bad |= talk_new_group(core, &options, &group) != TALK_OK;
            const char *source = handler ? "on watch\n wait for hello\n return\nend watch\non hello\n return\nend hello\n" : "on watch\n wait for hello\n return\nend watch\n";
            talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
            talk_script *script = NULL;
            bad |= talk_load(group, &load, &script) != TALK_OK;
            talk_message watch = {"watch", 5, NULL, 0, NULL};
            bad |= talk_script_deliver(script, &watch, NULL) != TALK_OK;
            bad |= talk_pump(group, 0, 0, NULL, NULL) != TALK_OK;
            bad |= (by_delivery ? talk_cancel_delivery(group, "d1", 2) : talk_script_cancel_run(script, "s/r1", 4)) != TALK_OK;
            talk_message hello = {"hello", 5, NULL, 0, NULL};
            talk_limits defaults;
            talk_default_limits(&defaults);
            talk_limit_override loose = {0};
            loose.fuel_per_run = defaults.fuel_per_run + 1;
            hello.limits = &loose;
            bad |= talk_broadcast(group, &hello, NULL) != TALK_INVALID_VALUE;
            talk_deciding *decision = NULL;
            bad |= talk_decide_broadcast(group, &hello, NULL, &decision) != TALK_INVALID_VALUE || decision != NULL;
            hello.limits = NULL;
            talk_owned_bytes id = {0};
            bad |= talk_broadcast(group, &hello, &id) != TALK_OK;
            bad |= id.len != 2 || memcmp(id.data, "b1", 2) != 0;
            talk_owned_bytes_release(&id);
            bad |= talk_pump(group, 0, 0, NULL, NULL) != TALK_OK;
            talk_counters counters;
            talk_script_counters(script, &counters);
            bad |= counters.runs != (int64_t)(handler ? 2 : 1);
            bad |= strstr(trace, "end=unhandled") != NULL;
            if (bad) fprintf(stderr, "%s", trace);
            talk_group_release(group);
            talk_core_release(core);
        }
    }
    return bad;
}

/* Decisions: a `, deciding` clause vetoes or allows, and a Selector that
 * isn't one is refused at the call. */
static int decision_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "on move n, deciding\n  if n is 1 then veto \"blocked\"\nend move\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_deciding *vetoed = NULL, *allowed = NULL, *refused = NULL;
    for (int i = 1; i <= 2; i++) {
        talk_value *n = NULL;
        talk_int(i, &n);
        talk_value *args[] = {n};
        talk_message m = {"move", 4, args, 1, NULL};
        bad |= talk_script_decide(script, &m, NULL, i == 1 ? &vetoed : &allowed) != TALK_OK;
        talk_value_release(n);
    }
    bad |= talk_deciding_done(vetoed) || talk_deciding_decided(vetoed) != NULL;
    talk_message selector = {"move:with:", 10, NULL, 0, NULL};
    bad |= talk_script_decide(script, &selector, NULL, &refused) != TALK_INVALID_VALUE || refused != NULL;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    const talk_decided *no = talk_deciding_decided(vetoed);
    const char *reason = NULL;
    size_t reason_len = 0;
    bad |= no == NULL || no->verdict != TALK_VETOED || no->vetoes_len != 1 || no->vetoes[0].run_len != 4 || memcmp(no->vetoes[0].run, "s/r1", 4) != 0;
    bad |= no == NULL || no->vetoes_len != 1 || !talk_value_as_text(no->vetoes[0].reason, &reason, &reason_len) || reason_len != 7 || memcmp(reason, "blocked", 7) != 0;
    const talk_decided *yes = talk_deciding_decided(allowed);
    bad |= !talk_deciding_done(allowed) || yes == NULL || yes->verdict != TALK_ALLOWED || yes->delivery_len != 2 || memcmp(yes->delivery, "d2", 2) != 0;
    bad |= strstr(trace, "> decide to=s message=move:with:\nrefused code=\"invalid value\"\n") == NULL;
    bad |= strstr(trace, "decided d1 verdict=vetoed vetoes=[{script: \"s\", run: \"s/r1\", reason: \"blocked\"}]\n") == NULL;
    /* A Broadcast Decision reaches the Script that wants it, and one that
     * nothing wants is allowed at once. */
    talk_deciding *everyone = NULL, *nobody = NULL;
    talk_owned_bytes broadcast_id = {0};
    talk_value *one = NULL;
    talk_int(1, &one);
    talk_value *one_args[] = {one};
    talk_message move = {"move", 4, one_args, 1, NULL};
    bad |= talk_decide_broadcast(group, &move, &broadcast_id, &everyone) != TALK_OK;
    bad |= broadcast_id.len != 2 || memcmp(broadcast_id.data, "b1", 2) != 0;
    talk_owned_bytes_release(&broadcast_id);
    talk_value_release(one);
    talk_message absent = {"absent", 6, NULL, 0, NULL};
    bad |= talk_decide_broadcast(group, &absent, NULL, &nobody) != TALK_OK;
    bad |= talk_broadcast(group, &absent, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    const talk_decided *all = talk_deciding_decided(everyone);
    bad |= all == NULL || all->verdict != TALK_VETOED || all->broadcast_len != 2 || memcmp(all->broadcast, "b1", 2) != 0 || all->delivery_len != 0 || all->vetoes_len != 1;
    const talk_decided *none = talk_deciding_decided(nobody);
    bad |= none == NULL || none->verdict != TALK_ALLOWED;
    bad |= strstr(trace, "> decide-broadcast b1 message=move args=[1] recipients=[s:d3]\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

static talk_call_end unused(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error);

/* store's get: the key and the resolved default, which it gives back. */
static talk_call_end store_get(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)call; (void)error;
    if (len != 2) return TALK_CALL_BROKEN;
    talk_value_retain(args[1]);
    *result = args[1];
    return TALK_CALL_ANSWERED;
}

/* store: a factory without its coordinator's hooks is refused, and get
 * hears its omitted default as Nothing. */
static int store_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_named_cost entries[] = {{"get", 3, {1, 0}}, {"set", 3, {1, 0}}, {"delete", 6, {1, 0}}, {"keys", 4, {1, 0}}, {"increment", 9, {1, 0}}, {"swap", 4, {1, 0}}, {"watch", 5, {1, 0}}, {"unwatch", 7, {1, 0}}};
    talk_costs costs = {entries, 8};
    talk_store_impl impl = {NULL, store_get, unused, unused, unused, unused, unused, unused, unused, {NULL, NULL, NULL, NULL}, NULL};
    talk_capability_def *def = NULL;
    int bad = talk_store_capability(core, &impl, &costs, &def) != TALK_INVALID_VALUE;
    bad |= talk_store_coordinator(core, &impl) != NULL;
    impl.coordinator = (talk_segment_lifecycle){begin_hook, commit_hook, rollback_hook, NULL};
    /* The coordinator a sqlite impl may share: the Core's copy, the same
     * one before and after the definition. */
    const talk_segment_lifecycle *shared = talk_store_coordinator(core, &impl);
    bad |= talk_store_capability(core, &impl, &costs, &def) != TALK_OK;
    bad |= shared == NULL || shared == &impl.coordinator || shared != talk_store_coordinator(core, &impl);
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, "scores", &grant) != TALK_OK;
    talk_load_grant grants[] = {{"st", 2, grant}};
    const char *source = "on go\n  ask st to get \"k\"\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= strstr(trace, "call s/r1.c1 op=st.get args=[\"k\"] result=nothing\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* sqlite's query: one row, {n: <the number of parameters>}, and the max it
 * was given. */
static int64_t sql_max = -1;
static int sql_scenario;
static int sql_steps;
static const char *n_column[] = {"n"};
static const size_t n_len[] = {1};
static talk_sql_value one_row[1];
static talk_call_end sql_query(void *context, talk_call *call, const char *sql, size_t sql_len, const talk_sql_params *params, int64_t max, talk_before_step_fn before_step, void *step_context, talk_sql_rows *rows, talk_script_error *error) {
    (void)context; (void)call; (void)sql; (void)sql_len;
    sql_max = max;
    if (before_step(step_context) != TALK_OK) return TALK_CALL_LIMITED;
    sql_steps++;
    if (sql_scenario == 1 || sql_scenario == 4) {
        *rows = (talk_sql_rows){n_column, n_len, 1, NULL, 0, sql_scenario == 4 ? 1 : 0};
        return TALK_CALL_ANSWERED;
    }
    if (sql_scenario == 2) {
        talk_value *reason = NULL, *data = NULL;
        if (talk_text("SQL step failed", 15, &reason) != TALK_OK) return TALK_CALL_BROKEN;
        talk_pair pair = {"reason", 6, reason};
        int bad = talk_map(&pair, 1, &data) != TALK_OK;
        talk_value_release(reason);
        if (bad) return TALK_CALL_BROKEN;
        *error = (talk_script_error){"sql", 3, NULL, 0, data};
        return TALK_CALL_FAILED;
    }
    if (max > 0) {
        /* A normal completion, or the overflow probe, is also a step. */
        if (before_step(step_context) != TALK_OK) return TALK_CALL_LIMITED;
        sql_steps++;
    }
    if (max == 0 || sql_scenario == 3) {
        talk_value *maximum = NULL, *data = NULL;
        if (talk_int(max, &maximum) != TALK_OK) return TALK_CALL_BROKEN;
        talk_pair pair = {"max", 3, maximum};
        int bad = talk_map(&pair, 1, &data) != TALK_OK;
        talk_value_release(maximum);
        if (bad) return TALK_CALL_BROKEN;
        *error = (talk_script_error){"too many rows", 13, NULL, 0, data};
        return TALK_CALL_FAILED;
    }
    one_row[0] = (talk_sql_value){TALK_SQL_INTEGER, (int64_t)params->len, 0, NULL, 0};
    *rows = (talk_sql_rows){n_column, n_len, 1, one_row, 1, 0};
    return TALK_CALL_ANSWERED;
}

static const talk_segment_lifecycle *database_coordinator(void *context, const char *database, size_t len) {
    (void)context; (void)database; (void)len;
    return &shared_lifecycle;
}

/* sqlite: a malformed binding refuses the Grant, max defaults to the row
 * cap and is charged per step, and rows come back as maps. */
static int sqlite_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_named_cost entries[] = {{"query", 5, {1, 0}}, {"change", 6, {1, 0}}, {"begin", 5, {1, 0}}, {"commit", 6, {1, 0}}, {"rollback", 8, {1, 0}}};
    talk_costs costs = {entries, 5};
    talk_sqlite_impl impl = {NULL, database_coordinator, sql_query, sql_query, unused, unused, unused, NULL};
    talk_capability_def *def = NULL;
    int bad = talk_sqlite_capability(core, &impl, &costs, -1, &def) != TALK_INVALID_VALUE;
    bad |= talk_sqlite_capability(core, &impl, &costs, 2, &def) != TALK_OK;
    talk_sqlite_binding too_many = {"app", 3, NULL, NULL, 0, false, -1};
    talk_sqlite_binding app = {"app", 3, NULL, NULL, 0, false, 4};
    talk_grant *refused = NULL, *grant = NULL;
    bad |= talk_capability_def_grant_all(def, &too_many, &refused) != TALK_INVALID_VALUE;
    bad |= talk_capability_def_grant_all(def, &app, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"db", 2, grant}};
    const char *source = "on go\n  ask db to query \"SELECT ?\", [1, true]\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= sql_max != 4;
    bad |= strstr(trace, "result=[{n: 2}] charged=4\n") == NULL;
    bad |= sql_steps != 2;
    for (int scenario = 1; scenario <= 4; scenario++) {
        sql_scenario = scenario;
        sql_steps = 0;
        const char *names[] = {"unused", "empty", "sqlerr", "overflow", "write"};
        const char *name = names[scenario];
        const char *next_source = scenario == 4 ? "on go\n ask db to change \"UPDATE\", []\nend go\n" : "on go\n ask db to query \"SELECT\", [], 0\nend go\n";
        load.name = name; load.name_len = strlen(name); load.source = next_source; load.source_len = strlen(next_source);
        bad |= talk_load(group, &load, &script) != TALK_OK;
        trace_len = 0; memset(trace, 0, sizeof trace);
        bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
        bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
        bad |= sql_steps != 1;
        bad |= strstr(trace, "charged=2") == NULL;
        if (scenario == 1) bad |= strstr(trace, "result=[] charged=2") == NULL;
        if (scenario == 2) bad |= strstr(trace, "code: \"sql\"") == NULL;
        if (scenario == 3) bad |= strstr(trace, "code: \"too many rows\"") == NULL;
        if (scenario < 4) bad |= strstr(trace, "phase=begin") != NULL;
        bad |= talk_script_stop(script, "done", 4) != TALK_OK;
    }
    /* A refused completion/probe never steps and retains the paid prefix;
     * a write-side refusal rolls back the Segment participant. */
    talk_group_release(group);
    talk_core_release(core);
    core = talk_new(); group = NULL;
    if (core == NULL || talk_new_group(core, &options, &group) != TALK_OK) return 1;
    bad |= talk_sqlite_capability(core, &impl, &costs, 600, &def) != TALK_OK;
    bad |= talk_capability_def_grant_all(def, &app, &grant) != TALK_OK;
    grants[0].grant = grant;
    talk_limits limits = {0}; limits.fuel_per_run = 1000;
    load.limits = &limits;
    const char *writing = "on go\n ask db to change \"UPDATE\", []\nend go\n";
    load.name = "limited"; load.name_len = 7; load.source = writing; load.source_len = strlen(writing);
    bad |= talk_load(group, &load, &script) != TALK_OK;
    sql_scenario = 3; sql_steps = 0;
    trace_len = 0; memset(trace, 0, sizeof trace);
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= sql_steps != 1;
    bad |= strstr(trace, "charged=600 charge-refused=yes") == NULL;
    bad |= strstr(trace, "phase=rollback status=ok") == NULL;
    bad |= strstr(trace, "too many rows") != NULL;
    talk_limit_override small = {TALK_OVERRIDE_FUEL_PER_RUN, 200, 0, 0, 0};
    go.limits = &small;
    trace_len = 0; memset(trace, 0, sizeof trace); sql_steps = 0;
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= sql_steps != 0;
    bad |= strstr(trace, "charge-refused=yes") == NULL;
    bad |= strstr(trace, "charged=") != NULL;
    sql_scenario = 0;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* console's write: counts what it is shown. */
static int shown = 0;
static talk_call_end show(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)call; (void)args; (void)error;
    shown += (int)len;
    return talk_nothing(result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_BROKEN;
}

static talk_call_end unused(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)call; (void)args; (void)len; (void)result; (void)error;
    return TALK_CALL_BROKEN;
}

/* clock's now from the Pump's Clock, and say through console's write. */
/* The Notification router, over a store Grant whose watch and unwatch
 * forward to it. The Store is "scores"; its revision is a counter. */
static talk_router *router_under_test;
static int store_revision;
static char revision_text[16];
static int64_t watch_cap;

static talk_watch_limits router_limits(void *context, const char *store, size_t len) {
    (void)context; (void)store; (void)len;
    talk_watch_limits l = {watch_cap, 65536, 1000, 1048576};
    return l;
}
static void router_revision(void *context, const char *store, size_t len, const char **out, size_t *out_len) {
    (void)context; (void)store; (void)len;
    *out_len = (size_t)snprintf(revision_text, sizeof revision_text, "%d", store_revision);
    *out = revision_text;
}
static bool router_store_of(void *context, void *binding, const char **out, size_t *out_len) {
    (void)context;
    if (binding == NULL) return false;
    *out = (const char *)binding;
    *out_len = strlen((const char *)binding);
    return true;
}
static talk_call_end router_watch(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context;
    if (len != 3) return TALK_CALL_BROKEN;
    const char *name, *prefix, *message;
    size_t name_len, prefix_len, message_len;
    if (!talk_value_as_text(args[0], &name, &name_len) || !talk_value_as_text(args[1], &prefix, &prefix_len) || !talk_value_as_text(args[2], &message, &message_len)) return TALK_CALL_BROKEN;
    if (!talk_router_watch(router_under_test, call, name, name_len, prefix, prefix_len, message, message_len, error)) return TALK_CALL_FAILED;
    talk_nothing(result);
    return TALK_CALL_ANSWERED;
}
static talk_grant *rebound_grant;
static talk_grant *rebind(void *context, const char *script, size_t script_len, const char *name, size_t name_len) {
    (void)context; (void)script; (void)script_len; (void)name; (void)name_len;
    return rebound_grant;
}

/* A commit is routed to a matching watch; a full mailbox holds the next
 * Notification until the retry after a Pump; a checkpoint restored after
 * the Store changed resyncs the watch with a marker. */
static int router_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_router_options ro = {NULL, NULL, router_limits, router_revision, router_store_of};
    router_under_test = talk_router_new(&ro);
    store_revision = 0;
    watch_cap = 100;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_named_cost entries[] = {{"get", 3, {0, 0}}, {"set", 3, {0, 0}}, {"delete", 6, {0, 0}}, {"keys", 4, {0, 0}}, {"increment", 9, {0, 0}}, {"swap", 4, {0, 0}}, {"watch", 5, {0, 0}}, {"unwatch", 7, {0, 0}}};
    talk_costs costs = {entries, 8};
    talk_store_impl impl = {NULL, unused, unused, unused, unused, unused, unused, router_watch, unused, {begin_hook, commit_hook, rollback_hook, NULL}, NULL};
    talk_capability_def *def = NULL;
    int bad = talk_store_capability(core, &impl, &costs, &def) != TALK_OK;
    if (bad) return 1;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, "scores", &grant) != TALK_OK;
    rebound_grant = grant;
    talk_load_grant grants[] = {{"st", 2, grant}};
    const char *source = "script variable seen = []\non start\n  ask st to watch \"w\", \"a/\", \"changed\"\nend start\non changed c, queued\n  put [the \"keys\" of c, the \"resync\" of c] after seen\nend changed\non more\n  try\n    ask st to watch \"v\", \"\", \"changed\"\n  catch {code: \"watch limit\", limit: l}\n    put l after seen\n  end try\nend more\n";
    talk_limits limits = {0};
    limits.mailbox_depth = 1;
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, &limits};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message start = {"start", 5, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &start, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    /* Two commits before a Pump: the first is admitted, the second finds the
     * mailbox full and waits. b/2 matches no watch. */
    talk_id first[] = {{"a/1", 3}, {"b/2", 3}};
    talk_id second[] = {{"a/2", 3}};
    bad |= talk_router_commit(router_under_test, "scores", 6, first, 2) != TALK_OK;
    bad |= talk_router_commit(router_under_test, "scores", 6, second, 1) != TALK_OK;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    bad |= talk_router_pumped(router_under_test, group);
    bad |= talk_pump(group, 1790000002, 0, NULL, NULL) != TALK_OK;
    bad |= talk_router_pumped(router_under_test, group);
    /* A second watch passes the Store's watches limit. */
    watch_cap = 1;
    talk_message more = {"more", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &more, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000002, 0, NULL, NULL) != TALK_OK;
    watch_cap = 100;
    /* A checkpoint, a change to the Store, and the restore's marker. */
    talk_owned_bytes checkpoint = {0};
    bad |= talk_router_save(router_under_test, group, &checkpoint) != TALK_OK;
    store_revision = 1;
    talk_restore_options restore = {"g", 1, record, NULL, NULL, 0, rebind, NULL, NULL, NULL, TALK_REJECT_MISMATCH, NULL, 0};
    talk_group *restored = NULL;
    talk_restore_result *result = NULL;
    talk_routing_result *routing = NULL;
    bad |= talk_router_restore(router_under_test, core, checkpoint.data, checkpoint.len, &restore, &restored, &result, &routing) != TALK_OK;
    bad |= routing == NULL || routing->restored_len != 1 || routing->resynced_len != 1 || routing->dropped_len != 0;
    if (!bad) bad |= routing->resynced[0].len != 6 || memcmp(routing->resynced[0].data, "s.st.w", 6) != 0;
    talk_routing_result_release(routing);
    talk_restore_result_release(result);
    bad |= talk_pump(restored, 1790000003, 0, NULL, NULL) != TALK_OK;
    talk_inspect(restored, NULL);
    bad |= strstr(trace, "vars s seen=[[[\"a/1\"], false], [[\"a/2\"], false], \"watches\", [[], true]]") == NULL;
    /* A truncated checkpoint is refused. */
    talk_group *refused = NULL;
    bad |= talk_router_restore(router_under_test, core, checkpoint.data, checkpoint.len - 1, &restore, &refused, &result, &routing) != TALK_INVALID_CHECKPOINT || refused != NULL;
    talk_owned_bytes_release(&checkpoint);
    if (bad) fprintf(stderr, "%s", trace);
    talk_router_detach(router_under_test, restored);
    talk_router_detach(router_under_test, group);
    talk_router_free(router_under_test);
    talk_group_release(restored);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

static int standard_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_named_cost clock_costs[] = {{"now", 3, {5, 0}}};
    talk_costs costs = {clock_costs, 1};
    talk_capability_def *clock = NULL, *console = NULL;
    int bad = talk_clock_capability(core, &costs, &clock) != TALK_OK;
    talk_costs missing = {NULL, 0};
    talk_console_impl impl = {NULL, show, unused};
    bad |= talk_console_capability(core, &impl, &missing, &console) != TALK_INVALID_VALUE;
    talk_named_cost console_costs[] = {{"write", 5, {1, 0}}, {"read", 4, {1, 0}}};
    talk_costs console_all = {console_costs, 2};
    bad |= talk_console_capability(core, &impl, &console_all, &console) != TALK_OK;
    talk_grant *clock_grant = NULL, *console_grant = NULL;
    bad |= talk_capability_def_grant_all(clock, NULL, &clock_grant) != TALK_OK;
    bad |= talk_capability_def_grant_all(console, NULL, &console_grant) != TALK_OK;
    talk_load_grant grants[] = {{"clock", 5, clock_grant}, {"console", 7, console_grant}};
    const char *source = "script variable at\non go\n  ask clock to now\n  put it into at\n  say at\nend go\n";
    talk_load_options load = {"timed", 5, source, strlen(source), grants, 2, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= strstr(trace, "call timed/r1.c1 op=clock.now args=[] result=2026-09-21T14:13:20Z\n") == NULL;
    bad |= shown != 1;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Limits: the default profile, a Script's Fuel per Run faulting a loop and
 * rolling it back, an override that loosens refused, and a full mailbox
 * refusing a Host Delivery. */
static int limits_test(void) {
    talk_limits defaults;
    talk_default_limits(&defaults);
    int bad = defaults.fuel_per_run != 10000000 || defaults.mailbox_depth != 1000 || defaults.max_wait_ms != 30000;
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_limits negative = {0};
    negative.fuel_per_run = -1;
    const char *source = "script variable n = 0\non spin\n  repeat forever\n    add 1 to n\n  end repeat\nend spin\n";
    talk_load_options refused = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, &negative};
    talk_script *script = NULL;
    bad |= talk_load(group, &refused, &script) != TALK_INVALID_VALUE;
    bad |= strstr(trace, "> load s identity=") == NULL;
    bad |= strstr(trace, "\nrefused code=\"invalid value\"\n") == NULL;
    talk_limits limits = {0};
    limits.fuel_per_run = 100;
    limits.mailbox_depth = 1;
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, &limits};
    bad |= talk_load(group, &load, &script) != TALK_OK;
    size_t before_duplicate = trace_len;
    talk_script *duplicate = NULL;
    bad |= talk_load(group, &load, &duplicate) != TALK_NAME_REUSED || duplicate != NULL;
    bad |= strstr(trace + before_duplicate, "> load s identity=") == NULL;
    bad |= strstr(trace + before_duplicate, "\nrefused code=\"name reused\"\n") == NULL;
    talk_limit_override looser = {TALK_OVERRIDE_FUEL_PER_RUN, 200, 0, 0, 0};
    talk_message loose = {"spin", 4, NULL, 0, &looser};
    bad |= talk_script_deliver(script, &loose, NULL) != TALK_INVALID_VALUE;
    talk_message spin = {"spin", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &spin, NULL) != TALK_OK;
    bad |= talk_script_deliver(script, &spin, NULL) != TALK_ERR_MAILBOX_FULL;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "refused code=\"invalid value\"\n") == NULL || strstr(trace, "refused code=\"mailbox full\"\n") == NULL;
    bad |= strstr(trace, "fault s/r1 limit=fuel ") == NULL || strstr(trace, " rollback=[n]\n") == NULL;
    bad |= strstr(trace, "run s/r1 outcome=limit-fault delivery=d1 handler=spin limit=fuel fuel=") == NULL;
    bad |= strstr(trace, "vars s n=0\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Fuel Slices: a Run preempted by its slice continues in a later Pump, and
 * its overrun is carried as debt. */
static int slice_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable n = 0\non count\n  repeat 5 times\n    add 1 to n\n  end repeat\nend count\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_message count = {"count", 5, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &count, NULL) != TALK_OK;
    talk_pump_options negative = {-1, 0};
    bad |= talk_pump(group, 1790000000, 0, &negative, NULL) != TALK_INVALID_VALUE;
    talk_pump_options sliced = {20, 0};
    talk_pump_result result = {0};
    bad |= talk_pump(group, 1790000000, 0, &sliced, &result) != TALK_OK;
    bad |= result.state != TALK_SLICED || result.fuel_used < 20;
    bad |= strstr(trace, "> pump clock=2026-09-21T14:13:20Z fuel-slice=20\n") == NULL;
    bad |= strstr(trace, "preempt s/r1 start delivery=d1 handler=count clause=1 by=slice fuel=") == NULL;
    bad |= strstr(trace, "pumped state=sliced fuel=") == NULL;
    talk_reports_release(result.reports);
    bad |= talk_pump(group, 1790000000, 0, NULL, &result) != TALK_OK;
    bad |= result.state != TALK_IDLE;
    talk_reports_release(result.reports);
    talk_inspect(group, NULL);
    bad |= strstr(trace, "seg s/r1 continue fuel=") == NULL || strstr(trace, "vars s n=5\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Cancelling: a waiting Run's finally runs on its Cleanup Budget and it ends
 * cancelled; a Request still in the mailbox is removed. */
static int cancel_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable n = 0\non hold\n  try\n    wait 1 s\n  finally\n    put 9 into n\n  end try\nend hold\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_message hold = {"hold", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &hold, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= talk_cancel_delivery(group, "x1", 2) != TALK_INVALID_VALUE;
    bad |= talk_script_cancel_run(script, "s/r1", 4) != TALK_OK;
    talk_pending *pending = NULL;
    bad |= talk_script_request(script, &hold, NULL, &pending) != TALK_OK;
    bad |= talk_cancel_delivery(group, "d2", 2) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "> cancel-run s/r1\n") == NULL || strstr(trace, "> cancel-delivery d2\n") == NULL;
    bad |= strstr(trace, "run s/r1 outcome=cancelled delivery=d1 handler=hold") == NULL;
    bad |= strstr(trace, "vars s n=9\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Cancelling a Decision by its delivery or broadcast id: an unsealed
 * recipient is cancelled, one that sealed its part carries on, and a
 * cancellation drained after the whole Decision sealed leaves no record. */
static int decision_cancel_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *quick_source = "on enter, deciding\n  wait 1 s\nend enter\n";
    const char *slow_source = "on enter, deciding\n  repeat forever\n  end repeat\nend enter\n";
    talk_load_options quick_load = {"quick", 5, quick_source, strlen(quick_source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_load_options slow_load = {"slow", 4, slow_source, strlen(slow_source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *quick = NULL, *slow = NULL;
    int bad = talk_load(group, &quick_load, &quick) != TALK_OK;
    bad |= talk_load(group, &slow_load, &slow) != TALK_OK;
    talk_message enter = {"enter", 5, NULL, 0, NULL};
    talk_deciding *everyone = NULL, *single = NULL;
    bad |= talk_decide_broadcast(group, &enter, NULL, &everyone) != TALK_OK;
    talk_pump_options sliced = {20, 0};
    bad |= talk_pump(group, 1790000000, 0, &sliced, NULL) != TALK_OK;
    bad |= talk_deciding_done(everyone);
    bad |= talk_cancel_delivery(group, "b1", 2) != TALK_OK;
    bad |= talk_cancel_delivery(group, "b0", 2) != TALK_INVALID_VALUE;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    const talk_decided *all = talk_deciding_decided(everyone);
    bad |= all == NULL || all->verdict != TALK_UNDECIDED || all->undecided_len != 1;
    bad |= strstr(trace, "> cancel-delivery b1\n") == NULL;
    bad |= strstr(trace, "run slow/r1 outcome=cancelled delivery=d2 broadcast=b1 handler=enter") == NULL;
    bad |= strstr(trace, "decided b1 verdict=undecided undecided=[{script: \"slow\", run: \"slow/r1\", outcome: \"cancelled\"}]\n") == NULL;
    /* After the seal, cancelling either id does nothing. */
    bad |= talk_script_decide(quick, &enter, NULL, &single) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= !talk_deciding_done(single);
    size_t before = trace_len;
    bad |= talk_cancel_delivery(group, "b1", 2) != TALK_OK;
    bad |= talk_cancel_delivery(group, "d3", 2) != TALK_OK;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    bad |= strstr(trace + before, "> cancel-delivery") != NULL;
    bad |= strstr(trace + before, "run quick/r1 outcome=completed delivery=d1 broadcast=b1 handler=enter") == NULL;
    bad |= strstr(trace + before, "run quick/r2 outcome=completed delivery=d3 handler=enter") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A negative override no Delivery can hold is refused with its input and
 * `refused` records, as other refusals are, and consumes no id. */
static int negative_override_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "on enter\nend enter\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_limit_override negative = {TALK_OVERRIDE_FUEL_PER_RUN, -1, 0, 0, 0};
    talk_message m = {"enter", 5, NULL, 0, &negative};
    talk_pending *pending = NULL;
    talk_deciding *deciding = NULL;
    talk_owned_bytes id = {0};
    bad |= talk_script_deliver(script, &m, NULL) != TALK_INVALID_VALUE;
    bad |= talk_script_request(script, &m, NULL, &pending) != TALK_INVALID_VALUE || pending != NULL;
    bad |= talk_script_decide(script, &m, NULL, &deciding) != TALK_INVALID_VALUE || deciding != NULL;
    m.limits = NULL;
    bad |= talk_script_deliver(script, &m, &id) != TALK_OK || id.len != 2 || memcmp(id.data, "d1", 2) != 0;
    talk_owned_bytes_release(&id);
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= strstr(trace, "> deliver to=s message=enter limits={fuelPerRun: -1}\nrefused code=\"invalid value\"\n") == NULL;
    bad |= strstr(trace, "> request to=s message=enter limits={fuelPerRun: -1}\nrefused code=\"invalid value\"\n") == NULL;
    bad |= strstr(trace, "> decide to=s message=enter limits={fuelPerRun: -1}\nrefused code=\"invalid value\"\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

static int dear_gets = 0;
static talk_call_end get_dear(void *context, talk_object *o, talk_value **result, talk_script_error *error) {
    (void)context; (void)o; (void)error;
    dear_gets++;
    return talk_int(1, result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_FAILED;
}

/* Host Object rules talk.go and talk.ts share (#1017): a property's declared
 * cost is paid before its Get runs; a Load refuses an owner that already owns
 * a Script, with its records; a climb into a full mailbox ends with a note and
 * `unhandled`; and a send to a stopped Script fails its waiting sender. */
static int object_path_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_prop props[] = {{"dear", 4, talk_any_shape(), get_dear, NULL, NULL, {1000, 0}, {0, 0}}};
    talk_object_kind_def gauge_def = {"gauge", 5, props, 1, NULL, NULL, 0, NULL};
    talk_object_kind_def room_def = {"room", 4, NULL, 0, NULL, NULL, 0, NULL};
    talk_object_kind *gauge = NULL, *room = NULL;
    int bad = talk_define_object_kind(core, &gauge_def, &gauge) != TALK_OK;
    bad |= talk_define_object_kind(core, &room_def, &room) != TALK_OK;
    talk_object *meter = NULL, *a = NULL, *b = NULL, *owner = NULL;
    bad |= talk_group_object(group, gauge, "m", 1, NULL, &meter) != TALK_OK;
    bad |= talk_group_object(group, room, "a", 1, NULL, &a) != TALK_OK;
    bad |= talk_group_object(group, room, "b", 1, NULL, &b) != TALK_OK;
    bad |= talk_group_object(group, room, "owner", 5, NULL, &owner) != TALK_OK;
    talk_load_object bound[] = {{"meter", 5, meter}};
    const char *reader_source = "on read\n  return the dear of meter\nend read\n";
    talk_load_options reader_load = {"reader", 6, reader_source, strlen(reader_source), NULL, 0, false, NULL, bound, 1, NULL};
    talk_script *reader = NULL;
    bad |= talk_load(group, &reader_load, &reader) != TALK_OK;
    talk_limit_override small = {TALK_OVERRIDE_FUEL_PER_RUN, 50, 0, 0, 0};
    talk_message read = {"read", 4, NULL, 0, &small};
    bad |= talk_script_deliver(reader, &read, NULL) != TALK_OK;
    const char *child_source = "on ping\n  pass ping\nend ping\n";
    const char *parent_source = "on ping\n  return 1\nend ping\n";
    talk_limits shallow = {0};
    shallow.mailbox_depth = 1;
    talk_load_options child_load = {"child", 5, child_source, strlen(child_source), NULL, 0, false, a, NULL, 0, NULL};
    talk_load_options parent_load = {"parent", 6, parent_source, strlen(parent_source), NULL, 0, false, b, NULL, 0, &shallow};
    talk_load_options again_load = {"again", 5, parent_source, strlen(parent_source), NULL, 0, false, a, NULL, 0, NULL};
    talk_script *child = NULL, *parent = NULL, *again = NULL;
    bad |= talk_load(group, &child_load, &child) != TALK_OK;
    bad |= talk_load(group, &parent_load, &parent) != TALK_OK;
    bad |= talk_load(group, &again_load, &again) != TALK_INVALID_VALUE || again != NULL;
    bad |= talk_set_parent(group, a, b) != TALK_OK;
    talk_message ping = {"ping", 4, NULL, 0, NULL};
    talk_pending *climbing = NULL; /* fails: read from the unhandled report */
    bad |= talk_script_request(child, &ping, NULL, &climbing) != TALK_OK;
    bad |= talk_script_deliver(parent, &ping, NULL) != TALK_OK;
    const char *receiver_source = "on ping\n  return 42\nend ping\n";
    const char *sender_source = "on go\n  send ping to receiver and wait\nend go\n";
    talk_load_options receiver_load = {"receiver", 8, receiver_source, strlen(receiver_source), NULL, 0, false, owner, NULL, 0, NULL};
    talk_load_options sender_load = {"sender", 6, sender_source, strlen(sender_source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *receiver = NULL, *sender = NULL;
    bad |= talk_load(group, &receiver_load, &receiver) != TALK_OK;
    bad |= talk_load(group, &sender_load, &sender) != TALK_OK;
    bad |= talk_dispose(group, owner) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(sender, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= dear_gets != 0;
    bad |= strstr(trace, "> load again identity=") == NULL || strstr(trace, "refused code=\"invalid value\"") == NULL;
    bad |= strstr(trace, "fault reader/r1 limit=fuel") == NULL || strstr(trace, "prop reader/r1") != NULL;
    bad |= strstr(trace, "note child/r1 kind=climb-full\nunhandled d2 message=ping target=<object room \"a\">\n") == NULL;
    bad |= strstr(trace, "raise sender/r1 code=\"send failed\"") == NULL;
    expect_pending_nothing(climbing, "a climb into a full mailbox settles at the end of its path");
    talk_pending_release(climbing);
    /* A child's completed pass must not settle a Request while its parent
     * is still running it. Exercise the object-targeted Request API too. */
    const char *waiting_parent = "on ping\n wait 1 s\n return 42\nend ping\n";
    bad |= talk_script_reload(parent, waiting_parent, strlen(waiting_parent), TALK_RESET_VARIABLES, NULL, NULL) != TALK_OK;
    talk_pending *forwarded = NULL;
    bad |= talk_request(group, a, &ping, NULL, &forwarded) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    expect(!talk_pending_done(forwarded), "a forwarded Request stays open while its parent waits");
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    expect(talk_pending_done(forwarded), "the forwarded Request settles when its parent returns");
    talk_value *forwarded_result = NULL;
    const talk_decimal *decimal = NULL;
    int64_t integer = 0;
    expect(talk_pending_result(forwarded, &forwarded_result) == TALK_OK && talk_value_as_dec(forwarded_result, &decimal) && talk_decimal_int64(decimal, &integer) == TALK_OK && integer == 42, "forwarding preserves the successful result");
    talk_value_release(forwarded_result);
    talk_pending_release(forwarded);
    talk_pending *ownerless = NULL;
    bad |= talk_request(group, meter, &ping, NULL, &ownerless) != TALK_OK;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    expect_pending_nothing(ownerless, "an ownerless object Request settles without a Run");
    talk_pending_release(ownerless);
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

static talk_object *element_member = NULL;
static int64_t element_index = 0;
static char element_name[16];
static talk_call_end element_count(void *context, talk_object *o, talk_value **result, talk_script_error *error) {
    (void)context; (void)o; (void)error;
    return talk_int(1, result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_BROKEN;
}
static talk_call_end element_at(void *context, talk_object *o, int64_t index, talk_value **result, talk_script_error *error) {
    (void)context; (void)o; (void)error;
    element_index = index;
    return talk_object_value(element_member, result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_BROKEN;
}
/* A malformed answer: no result at all. */
static talk_call_end element_find(void *context, talk_object *o, const char *name, size_t name_len, talk_value **result, talk_script_error *error) {
    (void)context; (void)o; (void)result; (void)error;
    if (name_len < sizeof element_name) memcpy(element_name, name, name_len);
    return TALK_CALL_ANSWERED;
}

/* An Object Collection (#1143): its declaration is checked and copied at
 * registration; `at` gets the signed index, `find` the borrowed name, and an
 * answer without a result is host error. */
static int object_elements_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_object_kind_def tile_def = {"tile", 4, NULL, 0, NULL, NULL, 0, NULL};
    talk_object_kind *tile = NULL, *board = NULL, *bad_kind = NULL;
    int bad = talk_define_object_kind(core, &tile_def, &tile) != TALK_OK;
    talk_shape *tile_shape = NULL;
    bad |= talk_object_shape(tile, &tile_shape) != TALK_OK;
    talk_object_elements wrong = {talk_number_shape(), element_count, element_at, element_find, NULL, {1, 0}, {1, 0}, {1, 0}};
    talk_object_kind_def wrong_def = {"wrong", 5, NULL, 0, NULL, NULL, 0, &wrong};
    bad |= talk_define_object_kind(core, &wrong_def, &bad_kind) != TALK_INVALID_VALUE;
    talk_object_elements missing = {tile_shape, element_count, NULL, element_find, NULL, {1, 0}, {1, 0}, {1, 0}};
    wrong_def.elements = &missing;
    bad |= talk_define_object_kind(core, &wrong_def, &bad_kind) != TALK_INVALID_VALUE;
    talk_object_elements negative = {tile_shape, element_count, element_at, element_find, NULL, {1, 0}, {-1, 0}, {1, 0}};
    wrong_def.elements = &negative;
    bad |= talk_define_object_kind(core, &wrong_def, &bad_kind) != TALK_INVALID_VALUE;
    talk_object_elements elements = {tile_shape, element_count, element_at, element_find, NULL, {1, 0}, {2, 0}, {3, 0}};
    talk_object_kind_def board_def = {"board", 5, NULL, 0, NULL, NULL, 0, &elements};
    bad |= talk_define_object_kind(core, &board_def, &board) != TALK_OK;
    /* Copied: a later change to the declaration changes nothing. */
    elements.at = NULL;
    talk_shape_release(tile_shape);
    talk_object *b = NULL;
    bad |= talk_group_object(group, board, "b", 1, NULL, &b) != TALK_OK;
    bad |= talk_group_object(group, tile, "t", 1, NULL, &element_member) != TALK_OK;
    talk_load_object bound[] = {{"thisBoard", 9, b}};
    const char *source = "on go\n  put the number of elements of thisBoard into n\n  put the last element of thisBoard into t\n  try\n    put element \"cell\" of thisBoard into x\n  catch e\n    return [n, t, e's operation]\n  end try\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, bound, 1, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= element_index != -1 || strcmp(element_name, "cell") != 0;
    bad |= strstr(trace, "name=elements op=count value=1") == NULL;
    bad |= strstr(trace, "name=elements op=at selector=-1 value=<object tile \"t\">") == NULL;
    bad |= strstr(trace, "name=elements op=find selector=\"cell\" error={}") == NULL;
    bad |= strstr(trace, "raise s/r1 code=\"host error\"") == NULL;
    bad |= strstr(trace, "outcome=completed") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* The C Host receives the actual Function Value in error metadata. */
static int function_error_during_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable caught\non exported captured\n return given x\n  throw {code: \"mine\", value: captured + x}\n end given\nend exported\non error e, during msg\n put msg into caught\nend error\non read\n return caught\nend read\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_value *n = NULL;
    bad |= talk_int(7, &n) != TALK_OK;
    talk_value *args[] = {n};
    talk_message exported = {"exported", 8, args, 1, NULL};
    talk_pending *made = NULL, *failed = NULL, *read = NULL;
    bad |= talk_script_request(script, &exported, NULL, &made) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_value *fn = NULL, *caught = NULL, *retained = NULL, *received_args = NULL;
    bad |= talk_pending_result(made, &fn) != TALK_OK || fn == NULL;
    bad |= talk_group_call(group, fn, args, 1, NULL, NULL, &failed) != TALK_OK;
    talk_pump_result pumped = {0};
    bad |= talk_pump(group, 1790000000, 0, NULL, &pumped) != TALK_OK;
    const talk_report *reports = NULL;
    size_t count = talk_reports_items(pumped.reports, &reports);
    bool errored = false;
    for (size_t i = 0; i < count; i++) {
        if (reports[i].kind == TALK_REPORT_RUN_END && reports[i].as.run_end.outcome == TALK_ERRORED) errored = true;
    }
    bad |= !errored;
    talk_reports_release(pumped.reports);
    talk_message message = {"read", 4, NULL, 0, NULL};
    bad |= talk_script_request(script, &message, NULL, &read) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= talk_pending_result(read, &caught) != TALK_OK || caught == NULL;
    bad |= talk_value_get(caught, "fn", 2, &retained) != TALK_OK;
    bool equal = false;
    bad |= talk_value_equal(fn, retained, &equal) != TALK_OK || !equal;
    bad |= talk_value_get(caught, "args", 4, &received_args) != TALK_OK;
    talk_value *expected_args = NULL;
    bad |= talk_list(args, 1, &expected_args) != TALK_OK;
    bad |= talk_value_equal(received_args, expected_args, &equal) != TALK_OK || !equal;
    talk_value_release(expected_args);
    talk_value_release(received_args);
    talk_value_release(retained);
    talk_value_release(caught);
    talk_value_release(fn);
    talk_value_release(n);
    talk_pending_release(read);
    talk_pending_release(failed);
    talk_pending_release(made);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Function Value calls follow talk.go and talk.ts (#1028): a Host call is
 * refused, with its records, for an override that loosens the Home Script's
 * limits or a full Home mailbox; a Script's call to a full Home raises
 * `mailbox full`, and one to a stopped Home `function gone`. */
static int function_call_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *home_source = "on exported\n  return given: 5\nend exported\non ping\nend ping\n";
    const char *caller_source = "on go callback\n  try\n    callback() and wait\n  catch e\n    return the code of e\n  end try\nend go\n";
    talk_limits shallow = {0};
    shallow.mailbox_depth = 1;
    shallow.fuel_per_run = 60;
    talk_load_options home_load = {"home", 4, home_source, strlen(home_source), NULL, 0, false, NULL, NULL, 0, &shallow};
    talk_load_options caller_load = {"caller", 6, caller_source, strlen(caller_source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *home = NULL, *caller = NULL;
    int bad = talk_load(group, &caller_load, &caller) != TALK_OK;
    bad |= talk_load(group, &home_load, &home) != TALK_OK;
    talk_message exported = {"exported", 8, NULL, 0, NULL};
    talk_pending *made = NULL;
    bad |= talk_script_request(home, &exported, NULL, &made) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_value *fn = NULL;
    bad |= talk_pending_result(made, &fn) != TALK_OK || fn == NULL;
    talk_limit_override loose = {TALK_OVERRIDE_FUEL_PER_RUN, 61, 0, 0, 0};
    talk_limit_override negative = {TALK_OVERRIDE_FUEL_PER_RUN, -1, 0, 0, 0};
    talk_pending *refused = NULL;
    bad |= talk_group_call(group, fn, NULL, 0, &loose, NULL, &refused) != TALK_INVALID_VALUE || refused != NULL;
    bad |= talk_group_call(group, fn, NULL, 0, &negative, NULL, &refused) != TALK_INVALID_VALUE || refused != NULL;
    talk_message ping = {"ping", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(home, &ping, NULL) != TALK_OK;
    bad |= talk_group_call(group, fn, NULL, 0, NULL, NULL, &refused) != TALK_ERR_MAILBOX_FULL || refused != NULL;
    talk_value *args[] = {fn};
    talk_message go = {"go", 2, args, 1, NULL};
    bad |= talk_script_deliver(caller, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= talk_script_stop(home, "closed", 6) != TALK_OK;
    bad |= talk_script_deliver(caller, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_value_release(fn);
    bad |= strstr(trace, "> call-value fn=<function home:2:10> limits={fuelPerRun: 61}\nrefused code=\"invalid value\"\n") == NULL;
    bad |= strstr(trace, "> call-value fn=<function home:2:10> limits={fuelPerRun: -1}\nrefused code=\"invalid value\"\n") == NULL;
    bad |= strstr(trace, "> call-value fn=<function home:2:10>\nrefused code=\"mailbox full\"\n") == NULL;
    bad |= strstr(trace, "raise caller/r1 code=\"mailbox full\"") == NULL;
    bad |= strstr(trace, "raise caller/r2 code=\"function gone\"") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Library checks talk.go and talk.ts share (#1033): a Join is not in a
 * Library, NULL declarations declare no Grants, and an unknown import binds
 * nothing, so its uses are unknown names. */
static int library_check_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    const char *join_source = "on hold\n  wait for all\n    ask io to pause and wait\n  end wait\nend hold\n";
    const char *ask_source = "function read\n  ask db to read\n  return it\nend read\n";
    const char *missing_source = "use bump from maths\nfunction f\n  return bump(1)\nend f\n";
    const char *sources[] = {join_source, ask_source, missing_source};
    const char *codes[][2] = {{"not in a library", NULL}, {"unknown operation", NULL}, {"unknown import", "unknown name"}};
    int bad = 0;
    for (size_t i = 0; i < 3; i++) {
        talk_library_source src = {"lib", 3, "1", 1, sources[i], strlen(sources[i])};
        talk_library *lib = NULL;
        talk_load_error *refused = NULL;
        bad |= talk_compile_library(core, &src, NULL, 0, NULL, 0, &lib, &refused) != TALK_LOAD_REFUSED || refused == NULL;
        if (refused == NULL) continue;
        for (size_t j = 0; j < 2; j++) {
            if (codes[i][j] == NULL) continue;
            bool found = false;
            for (size_t k = 0; k < refused->diagnostics_len; k++) {
                const talk_diagnostic *d = &refused->diagnostics[k];
                found |= d->code_len == strlen(codes[i][j]) && memcmp(d->code, codes[i][j], d->code_len) == 0;
            }
            bad |= !found;
        }
        talk_load_error_release(refused);
    }
    talk_core_release(core);
    return bad;
}

/* Stop Script: a waiting Run is discarded with no finally, a later Delivery
 * is dropped, and a Group whose Scripts are all stopped pumps as stopped. */
static int stop_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable n = 0\non hold\n  try\n    wait 1 s\n  finally\n    put 9 into n\n  end try\nend hold\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_message hold = {"hold", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &hold, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    /* Inspect shows the Run waiting until its deadline, and n. */
    talk_inspection *inspection = NULL;
    bad |= talk_inspect(group, &inspection) != TALK_OK || inspection == NULL || inspection->scripts_len != 1;
    if (!bad) {
        const talk_script_view *view = &inspection->scripts[0];
        bad |= view->vars_len != 1 || view->vars[0].key_len != 1 || view->vars[0].key[0] != 'n' || view->runs_len != 1 || view->mailbox_len != 0;
        if (!bad) {
            const talk_run_view *run = &view->runs[0];
            bad |= run->status != TALK_SUSPENDED || run->wait_len != 4 || memcmp(run->wait, "wait", 4) != 0;
            bad |= !run->has_until || run->until_seconds != 1790000001 || run->calls_len != 0;
            bad |= run->handler_len != 4 || memcmp(run->handler, "hold", 4) != 0;
        }
    }
    talk_inspection_release(inspection);
    bad |= talk_script_stop(script, "done", 4) != TALK_OK;
    talk_pump_result result = {0};
    bad |= talk_pump(group, 1790000000, 0, NULL, &result) != TALK_OK;
    bad |= result.state != TALK_STOPPED;
    /* The Run's discard, the Stop, then the accounting tail. */
    const talk_report *reports = NULL;
    bad |= talk_reports_items(result.reports, &reports) != 4;
    if (!bad) {
        const talk_run_discarded *discarded = &reports[0].as.run_discarded;
        bad |= reports[0].kind != TALK_REPORT_RUN_DISCARDED || discarded->reason_len != 4 || memcmp(discarded->reason, "stop", 4) != 0;
        const talk_stop *stop = &reports[1].as.stop;
        bad |= reports[1].kind != TALK_REPORT_STOP || stop->reason_len != 4 || memcmp(stop->reason, "done", 4) != 0;
        bad |= stop->discarded_runs_len != 1 || stop->discarded_runs[0].len != 4 || memcmp(stop->discarded_runs[0].data, "s/r1", 4) != 0;
        const talk_run_accounting *accounting = &reports[2].as.run_accounting;
        bad |= reports[2].kind != TALK_REPORT_RUN_ACCOUNTING || accounting->state_len != 9 || memcmp(accounting->state, "discarded", 9) != 0 || accounting->fuel != 15;
        const talk_causal_work *work = &reports[3].as.causal_work;
        bad |= reports[3].kind != TALK_REPORT_CAUSAL_WORK || work->live_runs != 0 || work->queued_messages != 0;
    }
    talk_reports_release(result.reports);
    bad |= talk_script_deliver(script, &hold, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "> stop s reason=\"done\"\n") == NULL;
    bad |= strstr(trace, "stopped s reason=\"done\" discarded=[s/r1]\n") == NULL;
    bad |= strstr(trace, "stopped s reason=\"done\" dropped=[d2]\n") == NULL;
    bad |= strstr(trace, "vars s n=0\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Reload and extend Script: an Entry adds a Handler, a reused name is
 * refused, a Reload carries Script Variables by name, a refused one changes
 * nothing, and replacing a Library rebuilds the Script that imports it. */
static int reload_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable n = 1\non bump\n  add 1 to n\nend bump\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    const char *entry = "on twice\n  add 2 to n\nend twice\n";
    bad |= talk_script_extend(script, entry, strlen(entry)) != TALK_OK;
    const char *reused = "on bump\nend bump\n";
    bad |= talk_script_extend(script, reused, strlen(reused)) != TALK_NAME_REUSED;
    talk_message bump = {"bump", 4, NULL, 0, NULL}, twice = {"twice", 5, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &bump, NULL) != TALK_OK;
    bad |= talk_script_deliver(script, &twice, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    const char *next = "script variable n = 0\nscript variable m = 5\n";
    bad |= talk_script_reload(script, next, strlen(next), TALK_CARRY_VARIABLES, NULL, NULL) != TALK_OK;
    bad |= talk_script_reload(script, "on", 2, TALK_RESET_VARIABLES, NULL, NULL) != TALK_LOAD_REFUSED;
    talk_library_source lib_src = {"lib", 3, "1", 1, "constant k = 1\n", 15};
    talk_library *lib = NULL, *replaced = NULL;
    bad |= talk_compile_library(core, &lib_src, NULL, 0, NULL, 0, &lib, NULL) != TALK_OK;
    bad |= talk_add_library(group, lib) != TALK_OK;
    const char *user = "use k from lib\nscript variable v = k\n";
    talk_load_options user_load = {"t", 1, user, strlen(user), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *t = NULL;
    bad |= talk_load(group, &user_load, &t) != TALK_OK;
    talk_library_source next_src = {"lib", 3, "2", 1, "constant k = 2\n", 15};
    bad |= talk_compile_library(core, &next_src, NULL, 0, NULL, 0, &replaced, NULL) != TALK_OK;
    bad |= talk_replace_library(group, replaced, TALK_RESET_VARIABLES, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "refused code=\"name reused\"\n") == NULL;
    bad |= strstr(trace, "stopped s reason=\"reload\"\n") == NULL;
    bad |= strstr(trace, "diag s code=\"unexpected token\"") == NULL;
    bad |= strstr(trace, "stopped t reason=\"reload\"\n") == NULL;
    bad |= strstr(trace, "vars s n=4 m=5\n") == NULL;
    bad |= strstr(trace, "vars t v=2\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Save and restore: a Run in its wait restores and wakes on time, a
 * corrupt save is refused, the first Pump can't go back in time, and a call
 * that isn't pending can't be settled. */
static int save_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable n = 0\non nap\n  wait 5 s\n  add 1 to n\nend nap\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_message nap = {"nap", 3, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &nap, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_owned_bytes saved = {0};
    bad |= talk_save(group, &saved) != TALK_OK;
    talk_restore_options ro = {"g", 1, record, NULL, NULL, 0, NULL, NULL, NULL, NULL, TALK_REJECT_MISMATCH, NULL, 0};
    talk_group *restored = NULL;
    talk_restore_result *result = NULL;
    bad |= talk_restore(core, saved.data, saved.len, &ro, &restored, &result) != TALK_OK;
    const talk_pending_call *pending = NULL;
    bad |= talk_restore_result_pending(result, &pending) != 0;
    bad |= talk_restore_result_variables_only(result);
    talk_restore_result_release(result);
    bad |= talk_group_script(restored, "s", 1) == NULL;
    talk_settlement adopt = {NULL, NULL, false, true};
    bad |= talk_settle(restored, "s/r1.c1", 7, &adopt, NULL) != TALK_UNKNOWN_CALL;
    bad |= talk_pump(restored, 1789999999, 0, NULL, NULL) != TALK_CLOCK_BACKWARDS;
    bad |= talk_pump(restored, 1790000006, 0, NULL, NULL) != TALK_OK;
    talk_inspect(restored, NULL);
    saved.data[saved.len / 2] ^= 1;
    talk_group *corrupt = NULL;
    bad |= talk_restore(core, saved.data, saved.len, &ro, &corrupt, &result) != TALK_INVALID_SAVE || corrupt != NULL;
    talk_owned_bytes_release(&saved);
    bad |= strstr(trace, "> save s1\n") == NULL;
    bad |= strstr(trace, "> restore from=s1 fingerprint=") == NULL;
    bad |= strstr(trace, "refused code=\"unknown call\"\n") == NULL;
    bad |= strstr(trace, "refused code=\"clock backwards\"\n") == NULL;
    bad |= strstr(trace, "vars s n=1\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(restored);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* The Message Layer measurements' three runaway Scripts (docs/research/
 * message-layer-measurements.md): a growing List and a doubling text end in
 * their Allocation Limit Fault, and a growing Script Variable in its
 * Persistent State Limit Fault, in a Group capped at 128 MiB. The Group
 * never refuses, and a Script beside them keeps its state and goes on
 * working. They run under the default Allocation and Persistent State
 * limits; growing the List must reach its fault in under a second. */
static int load_limited(talk_group *group, const char *name, const char *source, const talk_limits *limits, talk_script **out) {
    talk_load_options load = {name, strlen(name), source, strlen(source), NULL, 0, false, NULL, NULL, 0, limits};
    return talk_load(group, &load, out) != TALK_OK;
}

static int timed_pump(talk_group *group, const char *name) {
    struct timespec before = {0}, after = {0};
    int bad = timespec_get(&before, TIME_UTC) != TIME_UTC;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= timespec_get(&after, TIME_UTC) != TIME_UTC;
    double elapsed = (double)(after.tv_sec - before.tv_sec) + (double)(after.tv_nsec - before.tv_nsec) / 1e9;
    if (elapsed >= 1.0) {
        fprintf(stderr, "talk.h: %s took %.3f s (expected under 1 s)\n", name, elapsed);
        bad = 1;
    }
    return bad;
}

static int runaway_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 128u << 20, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    /* The measurements run the allocation cases with Fuel to spare, so the
     * Allocation Budget is what ends them. */
    talk_limits fuel = {0};
    fuel.fuel_per_run = 1000000000;
    talk_script *hog = NULL, *dbl = NULL, *hoard = NULL, *calm = NULL;
    int bad = load_limited(group, "hog", "on hog\n  put [] into xs\n  repeat forever\n    put \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" after xs\n  end repeat\nend hog\n", &fuel, &hog);
    bad |= load_limited(group, "double", "on double\n  put \"x\" into s\n  repeat forever\n    put s & s into s\n  end repeat\nend double\n", &fuel, &dbl);
    bad |= load_limited(group, "hoard", "script variable hoard = []\non stash n\n  repeat for each i in 1..n\n    put \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" after hoard\n  end repeat\nend stash\n", NULL, &hoard);
    bad |= load_limited(group, "calm", "script variable n = 0\non bump\n  add 1 to n\nend bump\n", NULL, &calm);
    if (bad) return 1;
    talk_message bump = {"bump", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(calm, &bump, NULL) != TALK_OK;
    talk_message hog_go = {"hog", 3, NULL, 0, NULL};
    talk_message double_go = {"double", 6, NULL, 0, NULL};
    talk_value *many = NULL;
    talk_int(20000, &many);
    talk_value *stash_args[] = {many};
    talk_message stash = {"stash", 5, stash_args, 1, NULL};
    bad |= talk_script_deliver(hog, &hog_go, NULL) != TALK_OK;
    bad |= talk_script_deliver(dbl, &double_go, NULL) != TALK_OK;
    bad |= talk_script_deliver(hoard, &stash, NULL) != TALK_OK;
    bad |= talk_script_deliver(calm, &bump, NULL) != TALK_OK;
    talk_value_release(many);
    bad |= timed_pump(group, "runaway Scripts");
    /* Each runaway is healthy afterwards: it takes its next Delivery. */
    talk_value *few = NULL;
    talk_int(3, &few);
    talk_value *few_args[] = {few};
    talk_message small = {"stash", 5, few_args, 1, NULL};
    bad |= talk_script_deliver(hoard, &small, NULL) != TALK_OK;
    bad |= talk_script_deliver(calm, &bump, NULL) != TALK_OK;
    talk_value_release(few);
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    talk_memory memory;
    talk_group_memory(group, &memory);
    bad |= memory.refused || memory.peak > memory.cap;
    bad |= strstr(trace, "fault hog/r1 limit=alloc at=hog:8 pos=4:5\n") == NULL;
    bad |= strstr(trace, "run hog/r1 outcome=limit-fault delivery=d2 handler=hog limit=alloc fuel=1715861 alloc=16777216\n") == NULL;
    bad |= strstr(trace, "run double/r1 outcome=limit-fault delivery=d3 handler=double limit=alloc ") == NULL;
    bad |= strstr(trace, "run hoard/r1 outcome=limit-fault delivery=d4 handler=stash limit=persistent ") == NULL;
    bad |= strstr(trace, "run hoard/r2 outcome=completed delivery=d6 handler=stash ") == NULL;
    bad |= strstr(trace, "vars calm n=3\n") == NULL;
    talk_counters counted;
    talk_script_counters(hoard, &counted);
    bad |= counted.faults != 1 || counted.runs != 2;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A suspending Operation's Start: it keeps the call, to answer later. */
static talk_call *started = NULL;
static talk_call_end start(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)args; (void)len; (void)result; (void)error;
    started = call;
    return TALK_CALL_STARTED;
}

/* Stop cancels Calls before the first release hook, retaining their ids. */
typedef struct stop_calls {
    talk_call *calls[2];
    size_t count;
    int releases;
    int bad;
    bool consumed;
} stop_calls;

static talk_call_end stop_start(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)args; (void)len; (void)result; (void)error;
    stop_calls *state = context;
    if (state->count >= 2) return TALK_CALL_BROKEN;
    state->calls[state->count++] = call;
    return TALK_CALL_STARTED;
}

static void stop_release(void *context, const talk_grant_context *grant) {
    stop_calls *state = context;
    state->releases++;
    state->bad |= grant->reason != TALK_RELEASE_STOP;
    for (size_t i = 0; i < state->count; i++) {
        const char *id = NULL;
        size_t len = 0;
        talk_call_id(state->calls[i], &id, &len);
        const char *want = i == 0 ? "s/r1.c1" : "s/r1.c2";
        state->bad |= len != strlen(want) || memcmp(id, want, len) != 0;
        if (talk_call_context(state->calls[i]) != !state->consumed) {
            fprintf(stderr, "talk.h: release %d saw wrong cancellation flag for %s\n", state->releases, want);
            state->bad = 1;
        }
    }
}

static int stop_call_cancellation_test(bool join, bool settled, bool consumed, const char *abandoned) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    stop_calls state = {0};
    state.consumed = consumed;
    talk_operation op = {0};
    op.name = "touch"; op.name_len = 5;
    op.result = talk_nothing_shape(); op.mode = TALK_SUSPENDING;
    op.context = &state; op.fn = stop_start;
    talk_capability_option hook[] = {talk_with_release_hook(stop_release, &state)};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "resource", 8, &op, 1, hook, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_group *group = NULL;
    trace_len = 0; memset(trace, 0, sizeof trace);
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    bad |= talk_new_group(core, &options, &group) != TALK_OK;
    talk_script *blocker = NULL;
    if (settled && !consumed) {
        bad |= load_limited(group, "blocker", "on busy\n return 1\nend busy", NULL, &blocker);
    }
    talk_load_grant grants[] = {{"api", 3, grant}, {"z", 1, grant}};
    const char *source = join
        ? "on go\n wait for all\n  ask api to touch and wait\n  ask api to touch and wait\n end wait\nend go\n"
        : "on go\n ask api to touch and wait\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 2, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= state.count != (join ? 2u : 1u);
    if (settled && state.count > 0) {
        talk_value *answer = NULL;
        bad |= talk_nothing(&answer) != TALK_OK;
        bad |= talk_call_answer(state.calls[0], answer) != TALK_OK;
        talk_value_release(answer);
        if (blocker != NULL) {
            talk_message busy = {"busy", 4, NULL, 0, NULL};
            bad |= talk_script_deliver(blocker, &busy, NULL) != TALK_OK;
        }
        talk_pump_options cap = {0, 1};
        bad |= talk_pump(group, 1790000000, 0, consumed ? NULL : &cap, NULL) != TALK_OK;
        bad |= talk_call_context(state.calls[0]);
    }
    bad |= talk_script_stop(script, "test", 4) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= state.bad || state.releases != 2;
    bad |= abandoned ? strstr(trace, abandoned) == NULL : strstr(trace, " abandoned=[") != NULL;
    bad |= strstr(trace, "\nabandon ") != NULL;
    bad |= talk_script_stop(script, "again", 5) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= state.releases != 2;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* timer's schedule: counts the arguments it receives. */
static size_t scheduled = 0;
static talk_call_end schedule(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)call; (void)args; (void)error;
    scheduled = len;
    return talk_nothing(result) == TALK_OK ? TALK_CALL_ANSWERED : TALK_CALL_BROKEN;
}

/* user's choose: starts the call when it hears the items, the given prompt
 * and multiple's default, false. */
static talk_call_end choose(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)result; (void)error;
    const char *prompt = NULL;
    size_t prompt_len = 0;
    bool multiple = true;
    if (len != 3 || !talk_value_as_text(args[1], &prompt, &prompt_len) || !talk_value_as_bool(args[2], &multiple)) return TALK_CALL_BROKEN;
    if (prompt_len != 4 || memcmp(prompt, "Pick", 4) != 0 || multiple) return TALK_CALL_BROKEN;
    started = call;
    return TALK_CALL_STARTED;
}

/* timer forwards schedule's four arguments, and user's choose hears its
 * options resolved and fails an answer that isn't one of the items. */
static int user_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_named_cost timer_costs[] = {{"schedule", 8, {1, 0}}, {"cancel", 6, {1, 0}}};
    talk_costs timer_all = {timer_costs, 2};
    talk_timer_impl timer_impl = {NULL, schedule, unused};
    talk_named_cost user_costs[] = {{"confirm", 7, {1, 0}}, {"choose", 6, {1, 0}}, {"enter", 5, {1, 0}}, {"notify", 6, {1, 0}}};
    talk_costs user_all = {user_costs, 4};
    talk_user_impl user_impl = {NULL, unused, choose, unused, unused};
    talk_capability_def *timer = NULL, *user = NULL;
    int bad = talk_timer_capability(core, &timer_impl, &timer_all, &timer) != TALK_OK;
    bad |= talk_user_capability(core, &user_impl, &user_all, &user) != TALK_OK;
    talk_grant *timer_grant = NULL, *user_grant = NULL;
    bad |= talk_capability_def_grant_all(timer, NULL, &timer_grant) != TALK_OK;
    bad |= talk_capability_def_grant_all(user, NULL, &user_grant) != TALK_OK;
    talk_load_grant grants[] = {{"timer", 5, timer_grant}, {"user", 4, user_grant}};
    const char *source = "script variable got\non go\n  tell timer to schedule \"t\", \"2026-10-02T10:00:00Z\" as instant, \"tick\", [1]\n"
                         "  try\n    ask user to choose [\"S\", \"M\"], {prompt: \"Pick\"} and wait\n  catch {code: code}\n    put code into got\n  end try\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 2, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    started = NULL;
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= scheduled != 4 || started == NULL;
    talk_value *answer = NULL;
    talk_text("X", 1, &answer);
    bad |= started == NULL || talk_call_answer(started, answer) != TALK_OK;
    talk_value_release(answer);
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "call-failed s/r1.c2 op=user.choose\n") == NULL;
    bad |= strstr(trace, "vars s got=\"host error\"\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Stop cancels a suspending Call before the first synchronous release hook. */
static int release_saw_cancelled;
static void release_observe_call(void *context, const talk_grant_context *gc) {
    (void)context;
    (void)gc;
    release_saw_cancelled = started != NULL && talk_call_context(started);
}
static int release_cancellation_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, NULL, NULL, NULL, 0, 0};
    int bad = talk_new_group(core, &options, &group) != TALK_OK;
    talk_operation ops[] = {{"fetch", 5, NULL, 0, talk_number_shape(), {20, 0}, TALK_SUSPENDING, 1000, NULL, 0, start, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    talk_capability_option hooks[] = {talk_with_release_hook(release_observe_call, NULL)};
    talk_capability_def *def = NULL;
    bad |= talk_define_capability(core, "feed", 4, ops, 1, hooks, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"feed", 4, grant}};
    const char *source = "on go\n ask feed to fetch and wait\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
    started = NULL;
    release_saw_cancelled = 0;
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= started == NULL || talk_call_context(started);
    bad |= talk_script_stop(script, "done", 4) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= !release_saw_cancelled;
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A Run suspends at ask … and wait, and resumes with the Host's answer. */
static int suspension_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_operation ops[] = {{"fetch", 5, NULL, 0, talk_number_shape(), {20, 0}, TALK_SUSPENDING, 1000, NULL, 0, start, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "feed", 4, ops, 1, NULL, 0, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"feed", 4, grant}};
    const char *source = "script variable got\non go\n  ask feed to fetch and wait\n  put it into got\nend go\n";
    talk_load_options load = {"waiter", 6, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= started == NULL;
    bad |= strstr(trace, "end=ask-wait\n") == NULL;
    bad |= strstr(trace, "pumped state=idle fuel=") == NULL || strstr(trace, " next=") == NULL;
    /* The suspended Run's work counts; reading charges nothing. */
    talk_counters counted;
    talk_script_counters(script, &counted);
    bad |= counted.runs != 1 || counted.faults != 0 || counted.mailbox_len != 0 || counted.fuel_total <= 0 || counted.persistent_state <= 0;
    char record[128];
    snprintf(record, sizeof record, "> counters waiter\ncounters waiter fuel=%lld alloc=%lld runs=1 faults=0 state=%lld mailbox=0\n", (long long)counted.fuel_total, (long long)counted.alloc_total, (long long)counted.persistent_state);
    bad |= strstr(trace, record) == NULL;
    talk_value *answer = NULL;
    talk_int(42, &answer);
    bad |= started == NULL || talk_call_answer_with_cost(started, answer, 3) != TALK_OK;
    talk_value_release(answer);
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "> answer waiter/r1.c1 value=42 fuel=3\n") == NULL;
    bad |= strstr(trace, "vars waiter got=42\n") == NULL;
    /* An answered call was never abandoned; one that times out is. */
    bad |= started == NULL || talk_call_context(started);
    started = NULL;
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000010, 0, NULL, NULL) != TALK_OK;
    talk_call *timing_out = started;
    bad |= timing_out == NULL || talk_call_context(timing_out);
    bad |= talk_pump(group, 1790000012, 0, NULL, NULL) != TALK_OK;
    bad |= timing_out == NULL || !talk_call_context(timing_out);
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

static talk_value *lamp_state = NULL;
static talk_call_end get_state(void *context, talk_object *o, talk_value **result, talk_script_error *error) {
    (void)context; (void)o; (void)error;
    talk_value_retain(lamp_state);
    *result = lamp_state;
    return TALK_CALL_ANSWERED;
}
static talk_call_end set_state(void *context, talk_object *o, const talk_value *v, talk_script_error *error) {
    (void)context; (void)o; (void)error;
    talk_value_release(lamp_state);
    talk_value_retain((talk_value *)v);
    lamp_state = (talk_value *)v;
    return TALK_CALL_ANSWERED;
}

static int object_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_text("off", 3, &lamp_state);
    talk_prop props[] = {{"state", 5, talk_text_shape(), get_state, set_state, NULL, {2, 0}, {5, 0}}};
    talk_object_kind_def lamp_def = {"lamp", 4, props, 1, NULL, NULL, 0, NULL};
    talk_object_kind_def room_def = {"room", 4, NULL, 0, NULL, NULL, 0, NULL};
    talk_object_kind *lamp = NULL, *room = NULL;
    int bad = talk_define_object_kind(core, &lamp_def, &lamp) != TALK_OK;
    bad |= talk_define_object_kind(core, &room_def, &room) != TALK_OK;
    /* An Operation that takes a lamp refuses a number at load. */
    talk_shape *lamp_shape = NULL;
    bad |= talk_object_shape(lamp, &lamp_shape) != TALK_OK;
    const talk_shape *see_args[] = {lamp_shape};
    talk_operation see_ops[] = {{"see", 3, see_args, 1, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, unused, NULL, NULL, false, NULL, 0, NULL, 0, NULL, NULL, 0, false}};
    talk_capability_def *probe = NULL;
    bad |= talk_define_capability(core, "probe", 5, see_ops, 1, NULL, 0, &probe) != TALK_OK;
    talk_shape_release(lamp_shape);
    talk_grant *probe_grant = NULL;
    bad |= talk_capability_def_grant_all(probe, NULL, &probe_grant) != TALK_OK;
    talk_load_grant probe_grants[] = {{"probe", 5, probe_grant}};
    const char *peek_source = "on go\n  ask probe to see 5\nend go\n";
    talk_load_options peek = {"peek", 4, peek_source, strlen(peek_source), probe_grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *peeking = NULL;
    bad |= talk_load(group, &peek, &peeking) != TALK_LOAD_REFUSED;
    bad |= strstr(trace, "diag peek code=\"wrong argument\"") == NULL;
    talk_object *light = NULL, *hall = NULL, *again = NULL, *found = NULL;
    bad |= talk_group_object(group, lamp, "l1", 2, NULL, &light) != TALK_OK;
    bad |= talk_group_object(group, room, "hall", 4, NULL, &hall) != TALK_OK;
    bad |= talk_group_object(group, lamp, "l1", 2, NULL, &again) != TALK_DUPLICATE_OBJECT_ID;
    bad |= !talk_object_by_id(group, "room", 4, "hall", 4, &found) || found != hall;
    talk_value *shown = NULL;
    bad |= talk_object_value(light, &shown) != TALK_OK || !talk_value_as_object(group, shown, &found) || found != light;
    talk_value_release(shown);
    /* The light's messages climb to the hall's Owning Script. */
    bad |= talk_set_parent(group, light, hall) != TALK_OK;
    const char *source = "on toggle\n  set the state of light to \"on\"\n  return [the id of the target, the state of light]\nend toggle\n";
    talk_load_object bound[] = {{"light", 5, light}};
    talk_load_options load = {"hall", 4, source, strlen(source), NULL, 0, false, hall, bound, 1, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"toggle", 6, NULL, 0, NULL};
    talk_pending *pending = NULL;
    bad |= talk_request(group, light, &message, NULL, &pending) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_value *answer = NULL;
    talk_owned_bytes text = {0};
    bad |= talk_pending_result(pending, &answer) != TALK_OK || talk_value_string(answer, &text) != TALK_OK;
    const char *want = "[\"l1\", \"on\"]";
    bad |= text.len != strlen(want) || memcmp(text.data, want, text.len) != 0;
    talk_owned_bytes_release(&text);
    talk_value_release(answer);
    bad |= strstr(trace, "prop hall/r1 object=<object lamp \"l1\"> name=state op=set value=\"on\"\n") == NULL;
    /* With the light's parent drained, the reverse is a cycle at the call. */
    bad |= talk_set_parent(group, hall, light) != TALK_PARENT_CYCLE;
    bad |= strstr(trace, "refused code=\"parent cycle\"\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    talk_value_release(lamp_state);
    return bad;
}

/* The Host Manifest: the same definitions give these bytes, in name order,
 * with each Operation's documentation and no binding. */
static int manifest_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    const char *examples[] = {"ask echo to twice \"ab\""};
    const size_t examples_lens[] = {22};
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false, NULL, 0, "Doubles a text.", 15, examples, examples_lens, 1, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "echo", 4, ops, 1, NULL, 0, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, (void *)1, &grant) != TALK_OK;
    /* `say` is console's write, which a Library must be told about. */
    const talk_shape *write_args[] = {talk_value_shape()};
    talk_operation_check write_check[] = {{"write", 5, TALK_IMMEDIATE, write_args, 1, false}};
    talk_grant_decls console_decls[] = {{"console", 7, write_check, 1}};
    const char *says_source = "function shout\n  say \"a\"\nend shout\n";
    talk_library_source says_src = {"says", 4, "1", 1, says_source, strlen(says_source)};
    talk_library *says = NULL;
    bad |= talk_compile_library(core, &says_src, NULL, 0, console_decls, 1, &says, NULL) != TALK_OK;
    talk_prop props[] = {{"state", 5, talk_text_shape(), get_state, NULL, NULL, {2, 0}, {0, 0}}};
    const char *parents[] = {"room"};
    const size_t parents_lens[] = {4};
    talk_object_kind_def lamp_def = {"lamp", 4, props, 1, parents, parents_lens, 1, NULL};
    talk_object_kind *lamp = NULL;
    bad |= talk_define_object_kind(core, &lamp_def, &lamp) != TALK_OK;
    if (bad) return bad;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const talk_shape *move_args[] = {talk_number_shape(), talk_text_shape()};
    const talk_object_kind *receivers[] = {lamp};
    const char *ping_examples[] = {"send ping to desk"};
    const size_t ping_examples_lens[] = {17};
    talk_message_decl messages[] = {{"ping", 4, NULL, 0, NULL, 0, "Checks the lamp.", 16, ping_examples, ping_examples_lens, 1}, {"move:to:", 8, move_args, 2, receivers, 1, NULL, 0, NULL, NULL, 0}};
    const talk_object_kind *kinds[] = {lamp};
    talk_manifest_object objects[] = {{"desk", 4, lamp}};
    talk_manifest_spec spec = {"demo", 4, "1", 1, grants, 1, &says, 1, messages, 2, kinds, 1, objects, 1};
    talk_owned_bytes written = {0};
    bad |= talk_export_manifest(&spec, &written) != TALK_OK;
    talk_versions versions;
    talk_core_versions(&versions);
    char expected[2048];
    int n = snprintf(expected, sizeof expected,
        "{\"kind\":\"demo\",\"version\":\"1\",\"language\":\"%.*s\","
        "\"grants\":[{\"name\":\"echo\",\"capability\":\"echo\",\"operations\":[{\"name\":\"twice\",\"mode\":\"immediate\",\"args\":[\"text\"],\"result\":\"text\",\"cost\":{\"fuel\":7,\"alloc\":0},\"description\":\"Doubles a text.\",\"examples\":[\"ask echo to twice \\\"ab\\\"\"]}]}],"
        "\"libraries\":[{\"name\":\"says\",\"version\":\"1\",\"source\":\"function shout\\u000a  say \\\"a\\\"\\u000aend shout\\u000a\",\"needs\":[{\"capability\":\"console\",\"operation\":\"write\"}]}],"
        "\"messages\":[{\"name\":\"move:to:\",\"args\":[\"number\",\"text\"],\"receivers\":[\"lamp\"]},{\"name\":\"ping\",\"args\":[],\"receivers\":[],\"description\":\"Checks the lamp.\",\"examples\":[\"send ping to desk\"]}],"
        "\"objectKinds\":[{\"name\":\"lamp\",\"props\":[{\"name\":\"state\",\"shape\":\"text\",\"readOnly\":true,\"getCost\":{\"fuel\":2,\"alloc\":0},\"setCost\":{\"fuel\":0,\"alloc\":0}}],\"parentKinds\":[\"room\"]}],"
        "\"objects\":[{\"name\":\"desk\",\"kind\":\"lamp\"}]}",
        (int)versions.language_len, versions.language);
    if (written.len != (size_t)n || memcmp(written.data, expected, written.len) != 0) {
        fprintf(stderr, "manifest:\n%.*s\nexpected:\n%s\n", (int)written.len, written.data, expected);
        bad = 1;
    }
    /* The same definitions give the same bytes, whatever order they come in. */
    talk_message_decl reordered[] = {messages[1], messages[0]};
    spec.messages = reordered;
    talk_owned_bytes again = {0};
    bad |= talk_export_manifest(&spec, &again) != TALK_OK || again.len != written.len || memcmp(again.data, written.data, again.len) != 0;
    talk_owned_bytes_release(&again);
    talk_owned_bytes_release(&written);
    talk_message_decl twice_named[] = {messages[0], messages[0]};
    spec.messages = twice_named;
    bad |= talk_export_manifest(&spec, &again) != TALK_INVALID_VALUE;
    talk_message_decl short_selector[] = {{"move:to:", 8, move_args, 1, NULL, 0, NULL, 0, NULL, NULL, 0}};
    spec.messages = short_selector;
    spec.messages_len = 1;
    bad |= talk_export_manifest(&spec, &again) != TALK_INVALID_VALUE;
    talk_core_release(core);
    return bad;
}

/* A compiled Library is reusable across Groups and callers. Its nested
 * Function Values, including defaults, acquire each calling Script's Home. */
static int library_constant_functions_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    const char *lib_source = "constant box = {f: given x: x + 1}\nfunction apply x, callbacks = box\n put the f of callbacks into f\n return f(x)\nend apply\n";
    talk_library_source lib_src = {"helper", 6, "1", 1, lib_source, strlen(lib_source)};
    talk_library *lib = NULL;
    int bad = talk_compile_library(core, &lib_src, NULL, 0, NULL, 0, &lib, NULL) != TALK_OK;
    for (int i = 0; i < 2 && !bad; i++) {
        trace_len = 0;
        memset(trace, 0, sizeof trace);
        talk_group *group = NULL;
        talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
        bad |= talk_new_group(core, &options, &group) != TALK_OK;
        bad |= talk_add_library(group, lib) != TALK_OK;
        const char *source = "use box, apply from helper\nscript variable got\non go\n put the f of box into f\n put [f(2), apply(4)] into got\nend go\n";
        const char *names[] = {"a", "b"};
        for (size_t j = 0; j < 2 && !bad; j++) {
            talk_load_options load = {names[j], 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
            talk_script *script = NULL;
            bad |= talk_load(group, &load, &script) != TALK_OK;
            talk_message message = {"go", 2, NULL, 0, NULL};
            bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
        }
        bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
        talk_inspect(group, NULL);
        bad |= strstr(trace, "vars a got=[3, 5]\n") == NULL;
        bad |= strstr(trace, "vars b got=[3, 5]\n") == NULL;
        if (bad) fprintf(stderr, "%s", trace);
        talk_group_release(group);
    }
    talk_core_release(core);
    return bad;
}

static int library_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *base_source = "constant step = 10\nfunction bump n, by = step\n  return n + by\nend bump\n";
    talk_library_source base_src = {"base", 4, "1", 1, base_source, strlen(base_source)};
    talk_library *base = NULL, *top = NULL, *clash = NULL, *broken = NULL;
    int bad = talk_compile_library(core, &base_src, NULL, 0, NULL, 0, &base, NULL) != TALK_OK;
    /* A Library may import the stdlib's, which every Group holds. */
    const char *top_source = "use bump from base\nuse padLeft from text\nfunction label n\n  return padLeft(bump(n) & \"\", 4, \"0\")\nend label\n";
    talk_library_source top_src = {"top", 3, "1", 1, top_source, strlen(top_source)};
    bad |= talk_compile_library(core, &top_src, &base, 1, NULL, 0, &top, NULL) != TALK_OK;
    talk_library_source clash_src = {"text", 4, "1", 1, base_source, strlen(base_source)};
    bad |= talk_compile_library(core, &clash_src, NULL, 0, NULL, 0, &clash, NULL) != TALK_OK;
    talk_library_source broken_src = {"broken", 6, "1", 1, "function f\n  put 1 into 3\nend f\n", 30};
    /* Its diagnostics come back as a talk_load_error, in its own lines. */
    talk_load_error *refused = NULL;
    bad |= talk_compile_library(core, &broken_src, NULL, 0, NULL, 0, &broken, &refused) != TALK_LOAD_REFUSED;
    bad |= refused == NULL || refused->diagnostics_len != 1;
    if (!bad) {
        const talk_diagnostic *d = &refused->diagnostics[0];
        bad |= d->unit_len != 6 || memcmp(d->unit, "broken", 6) != 0 || d->line != 2 || d->code_len == 0;
        talk_owned_bytes said = {0};
        bad |= talk_load_error_error(refused, &said) != TALK_OK || said.len < 9 || memcmp(said.data, "broken:2:", 9) != 0;
        talk_owned_bytes_release(&said);
    }
    talk_load_error_release(refused);
    /* A Constant whose initialiser raises refuses the Library too. */
    talk_library_source failing_src = {"failing", 7, "1", 1, "constant x = 1 / 0\n", 19};
    bad |= talk_compile_library(core, &failing_src, NULL, 0, NULL, 0, &broken, NULL) != TALK_LOAD_REFUSED;
    /* Imports first, one per name, and never a stdlib name. */
    bad |= talk_add_library(group, top) != TALK_LIBRARY_MISMATCH;
    bad |= talk_add_library(group, base) != TALK_OK;
    bad |= talk_add_library(group, base) != TALK_NAME_REUSED;
    bad |= talk_add_library(group, clash) != TALK_RESERVED_NAME;
    bad |= talk_add_library(group, top) != TALK_OK;
    uint8_t id[32];
    talk_library_identity(top, id);
    const char *name = NULL;
    size_t len = 0;
    talk_library_name(top, &name, &len);
    bad |= len != 3 || memcmp(name, "top", 3) != 0;
    talk_library *const *imports = NULL;
    size_t imported = talk_library_imports(top, &imports);
    bad |= imported != 2 || imports[0] != base;
    if (!bad) {
        talk_library_name(imports[1], &name, &len);
        bad |= len != 4 || memcmp(name, "text", 4) != 0;
    }
    /* `needs` is each Operation once, sorted, through imports too, and say
     * is console's write. */
    /* `say` is console's write, which a Library must be told about. */
    const talk_shape *write_args[] = {talk_value_shape()};
    talk_operation_check write_check[] = {{"write", 5, TALK_IMMEDIATE, write_args, 1, false}};
    talk_grant_decls console_decls[] = {{"console", 7, write_check, 1}};
    const char *says_source = "function shout\n  say \"a\"\n  say \"b\"\nend shout\n";
    talk_library_source says_src = {"says", 4, "1", 1, says_source, strlen(says_source)};
    talk_library *says = NULL, *loud = NULL;
    bad |= talk_compile_library(core, &says_src, NULL, 0, console_decls, 1, &says, NULL) != TALK_OK;
    const char *loud_source = "use shout from says\nfunction twice\n  shout()\n  shout()\nend twice\n";
    talk_library_source loud_src = {"loud", 4, "1", 1, loud_source, strlen(loud_source)};
    bad |= talk_compile_library(core, &loud_src, &says, 1, NULL, 0, &loud, NULL) != TALK_OK;
    const talk_operation_ref *needs = NULL;
    bad |= talk_library_needs(base, &needs) != 0;
    bad |= loud == NULL || talk_library_needs(loud, &needs) != 1;
    if (!bad) bad |= needs[0].capability_len != 7 || memcmp(needs[0].capability, "console", 7) != 0 || needs[0].operation_len != 5 || memcmp(needs[0].operation, "write", 5) != 0;
    bad |= talk_add_library(group, says) != TALK_OK;
    bad |= talk_add_library(group, loud) != TALK_OK;
    const char *ungranted_source = "use twice from loud\non go\n twice()\nend go\n";
    talk_load_options ungranted = {"ungranted", 9, ungranted_source, strlen(ungranted_source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *ungranted_script = NULL;
    bad |= talk_load(group, &ungranted, &ungranted_script) != TALK_LOAD_REFUSED || ungranted_script != NULL;
    bad |= strstr(trace, "diag ungranted code=\"missing grant\"") == NULL;
    const char *source = "use label from top\nscript variable got\non go\n  put label(5) into got\nend go\n";
    talk_load_options load = {"user", 4, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group, NULL);
    bad |= strstr(trace, "refused code=\"library mismatch\"\n") == NULL;
    bad |= strstr(trace, "refused code=\"reserved name\"\n") == NULL;
    bad |= strstr(trace, "vars user got=\"0015\"\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A Host allocator that counts what it hands out, so a test can see that a
 * Group gives back every byte, even after a refusal. */
static size_t host_live = 0;
static void *host_alloc(void *context, size_t size, size_t alignment) {
    (void)context;
    if (alignment < sizeof(void *)) alignment = sizeof(void *);
    /* C11's aligned_alloc wants a size that is a multiple of the alignment. */
    size_t rounded = (size + alignment - 1) / alignment * alignment;
    void *p = aligned_alloc(alignment, rounded == 0 ? alignment : rounded);
    if (p == NULL) return NULL;
    host_live += size;
    return p;
}
static void host_free(void *context, void *ptr, size_t size, size_t alignment) {
    (void)context;
    (void)alignment;
    host_live -= size;
    free(ptr);
}

static int host_list_memory_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_allocator host = {NULL, host_alloc, host_free};
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, NULL, NULL, &host, 64 * 1024, 0};
    int bad = talk_new_group(core, &options, &group) != TALK_OK;
    /* Both arguments are Host values. Reusing the same child isolates the
     * growing List's allocations: its backing must come from the Group. */
    const char *source = "on grow xs, child\n  repeat 10000 times\n    put child after xs\n  end repeat\nend grow\n";
    talk_load_options load = {"hog", 3, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_value *list = NULL, *child = NULL;
    bad |= talk_list(NULL, 0, &list) != TALK_OK;
    bad |= talk_int(1, &child) != TALK_OK;
    talk_value *args[] = {list, child};
    talk_message message = {"grow", 4, args, 2, NULL};
    if (!bad) {
        bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
        talk_host_error_code pumped = talk_pump(group, 1790000000, 0, NULL, NULL);
        talk_memory memory;
        talk_group_memory(group, &memory);
        if (pumped != TALK_OUT_OF_MEMORY || !memory.refused) {
            fprintf(stderr, "Host List growth: Pump=%d refused=%d peak=%zu cap=%zu\n", pumped, memory.refused, memory.peak, memory.cap);
            bad = 1;
        }
        bad |= memory.peak > memory.cap;
        bad |= talk_value_len(list) != 0;
    }
    talk_value_release(list);
    talk_value_release(child);
    talk_group_release(group);
    bad |= host_live != 0;
    talk_core_release(core);
    return bad;
}

/* Collecting retains each version supplied by the body. Item writes and
 * self-insertion must preserve those versions and the Host's original. */
static int collecting_versions_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {.name = "g", .name_len = 1};
    int bad = talk_new_group(core, &options, &group) != TALK_OK;
    const char *source = "on probe values\n  put values into original\n  repeat for each i in 1..3 collecting values into snapshots\n    put i into item 1 of values\n  end repeat\n  put snapshots into earlier\n  put snapshots into item 1 of snapshots\n  return [original, earlier, values, item 1 of snapshots]\nend probe\n";
    talk_load_options load = {.name = "probe", .name_len = 5, .source = source, .source_len = strlen(source)};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_value *one = NULL, *two = NULL, *list = NULL, *result = NULL;
    bad |= talk_int(1, &one) != TALK_OK;
    bad |= talk_int(2, &two) != TALK_OK;
    talk_value *items[] = {one, two};
    bad |= talk_list(items, 2, &list) != TALK_OK;
    talk_message message = {.name = "probe", .name_len = 5, .args = &list, .args_len = 1};
    talk_pending *pending = NULL;
    if (!bad) {
        bad |= talk_script_request(script, &message, NULL, &pending) != TALK_OK;
        bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
        bad |= talk_pending_result(pending, &result) != TALK_OK;
        if (result != NULL) {
            talk_owned_bytes shown = {0};
            bad |= talk_value_string(result, &shown) != TALK_OK;
            const char *expected = "[[1, 2], [[1, 2], [2, 2], [3, 2]], [3, 2], [[1, 2], [2, 2], [3, 2]]]";
            bad |= shown.len != strlen(expected) || memcmp(shown.data, expected, shown.len) != 0;
            talk_owned_bytes_release(&shown);
        }
        talk_owned_bytes original = {0};
        bad |= talk_value_string(list, &original) != TALK_OK;
        bad |= original.len != 6 || memcmp(original.data, "[1, 2]", original.len) != 0;
        talk_owned_bytes_release(&original);
    }
    talk_value_release(result);
    talk_pending_release(pending);
    talk_value_release(list);
    talk_value_release(one);
    talk_value_release(two);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* Every root visibly stays [nothing]. Older slices must not make appending
 * these constant-size snapshots walk an ever-growing hidden ownership graph. */
static int snapshot_growth_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, NULL, NULL, NULL, 0, 0};
    int bad = talk_new_group(core, &options, &group) != TALK_OK;
    const char *source = "on probe n\n  put [] into root\n  put nothing after root\n  put [] into result\n  repeat n times\n    put [] into prefix\n    put nothing after prefix\n    put prefix into snapshot\n    put root after prefix\n    put snapshot into root\n    put root after result\n  end repeat\n  return result\nend probe\n";
    talk_limits limits = {0};
    limits.fuel_per_run = 1000000000;
    talk_load_options load = {"probe", 5, source, strlen(source), NULL, 0, false, NULL, NULL, 0, &limits};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_value *count = NULL;
    bad |= talk_int(8000, &count) != TALK_OK;
    talk_value *args[] = {count};
    talk_message message = {"probe", 5, args, 1, NULL};
    talk_pending *pending = NULL;
    talk_value *result = NULL, *first = NULL, *child = NULL;
    if (!bad) {
        bad |= talk_script_request(script, &message, NULL, &pending) != TALK_OK;
        bad |= timed_pump(group, "snapshot growth");
        bad |= talk_pending_result(pending, &result) != TALK_OK;
        if (result != NULL) {
            bad |= talk_value_len(result) != 8000;
            bad |= talk_value_index(result, 1, &first) != TALK_OK;
            bad |= talk_value_len(first) != 1;
            bad |= talk_value_index(first, 1, &child) != TALK_OK;
            bad |= talk_value_kind(child) != TALK_KIND_NOTHING;
        }
        talk_counters counters;
        talk_script_counters(script, &counters);
        bad |= counters.fuel_total != 280027 || counters.alloc_total != 896072 || counters.faults != 0;
    }
    talk_value_release(child);
    talk_value_release(first);
    talk_value_release(result);
    talk_pending_release(pending);
    talk_value_release(count);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

static int memory_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_allocator host = {NULL, host_alloc, host_free};
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, &host, 256 * 1024, 0};
    int bad = talk_new_group(core, &options, &group) != TALK_OK;
    /* Each turn of the loop doubles the text, far past the cap long before
     * the logical budgets: the Group refuses, and the process goes on. */
    const char *source = "script variable s\non grow\n  put \"x\" into s\n  repeat 40 times\n    put s & s into s\n  end repeat\nend grow\n";
    talk_load_options load = {"hog", 3, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"grow", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OUT_OF_MEMORY;
    talk_memory memory;
    talk_group_memory(group, &memory);
    bad |= !memory.refused || memory.cap != 256 * 1024 || memory.peak > memory.cap || memory.used > memory.cap;
    /* It takes no more work. */
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OUT_OF_MEMORY;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OUT_OF_MEMORY;
    talk_group_release(group);
    /* And it gave every byte back. */
    bad |= host_live != 0;
    if (bad) fprintf(stderr, "memory: live=%zu used=%zu peak=%zu refused=%d\n%s", host_live, memory.used, memory.peak, memory.refused, trace);
    talk_core_release(core);
    return bad;
}

/* Metered suspension through the public C surface, including future lifetime. */
static talk_call *metered_call;
static int ready_count;
static void metered_ready(void *context) { (void)context; ready_count++; }
static talk_call_end metered_start(void *context, talk_call *call, talk_value *const *args, size_t len, talk_value **result, talk_script_error *error) {
    (void)context; (void)args; (void)len; (void)result; (void)error;
    metered_call = call;
    return TALK_CALL_STARTED;
}
static int metering_test(void) {
    talk_core *core = talk_new();
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0, 0};
    if (core == NULL || talk_new_group(core, &options, &group) != TALK_OK) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group_on_ready(group, metered_ready, NULL);
    ready_count = 0;
    talk_operation op = { .name = "fetch", .name_len = 5, .result = talk_number_shape(), .mode = TALK_SUSPENDING, .fn = metered_start, .metering = "read-only", .metering_len = 9 };
    talk_capability_def *def = NULL;
    talk_grant *grant = NULL;
    int bad = talk_define_capability(core, "metered", 7, &op, 1, NULL, 0, &def) != TALK_OK;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"api", 3, grant}};
    const char *source = "on go\n ask api to fetch and wait\n return it\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    talk_pending *pending = NULL;
    bad |= talk_script_request(script, &go, NULL, &pending) != TALK_OK;
    bad |= talk_pump(group, 0, 0, NULL, NULL) != TALK_OK;
    talk_owned_bytes saved = {0};
    bad |= talk_save(group, &saved) != TALK_EFFECTS_PENDING || saved.data != NULL;
    talk_charge_request *q = NULL, *invalid = NULL;
    bad |= talk_call_request_charge(metered_call, -1, &invalid) != TALK_INVALID_VALUE || invalid != NULL;
    bad |= talk_call_request_charge(metered_call, 9007199254740992LL, &invalid) != TALK_INVALID_VALUE || invalid != NULL;
    bad |= talk_call_request_charge(metered_call, 17, &q) != TALK_OK;
    bad |= ready_count != 1 || talk_charge_request_done(q);
    const char *id = NULL; size_t len = 0;
    talk_charge_request_id(q, &id, &len);
    bad |= len != 2 || memcmp(id, "q1", 2) != 0;
    talk_charge_result result;
    bad |= talk_charge_request_result(q, &result);
    bad |= talk_call_request_charge(metered_call, 0, &invalid) != TALK_INVALID_VALUE;
    talk_pump_result pumped = {0};
    bad |= talk_pump(group, 0, 0, NULL, &pumped) != TALK_OK;
    talk_reports *reports = pumped.reports;
    bad |= !talk_charge_request_done(q) || !talk_charge_request_result(q, &result);
    bad |= result.fuel != 17 || result.status_len != 8 || memcmp(result.status, "accepted", 8) != 0;
    const talk_report *items = NULL;
    size_t count = talk_reports_items(reports, &items);
    bad |= count == 0 || items[0].kind != TALK_REPORT_CHARGE_RESULT || items[0].as.charge_result.fuel != 17;
    talk_reports_release(reports);
    talk_value *answer = NULL;
    bad |= talk_int(42, &answer) != TALK_OK;
    bad |= talk_call_answer(metered_call, answer) != TALK_OK;
    talk_value_release(answer);
    bad |= talk_pump(group, 0, 0, NULL, NULL) != TALK_OK;
    bad |= talk_call_request_charge(metered_call, 19, &q) != TALK_OK;
    bad |= talk_save(group, &saved) != TALK_EFFECTS_PENDING;
    bad |= talk_pump(group, 0, 0, NULL, NULL) != TALK_OK;
    bad |= !talk_charge_request_result(q, &result) || result.status_len != 8 || memcmp(result.status, "inactive", 8) != 0;
    bad |= talk_save(group, &saved) != TALK_OK;
    talk_owned_bytes_release(&saved);
    op.mode = TALK_FIRE_AND_FORGET;
    bad |= talk_define_capability(core, "bad", 3, &op, 1, NULL, 0, &def) != TALK_INVALID_VALUE;
    op.mode = TALK_IMMEDIATE;
    op.metering = "segment-bound"; op.metering_len = 13;
    bad |= talk_define_capability(core, "bad", 3, &op, 1, NULL, 0, &def) != TALK_INVALID_VALUE;
    op.segment_bound = true;
    bad |= talk_define_capability(core, "bad", 3, &op, 1, NULL, 0, &def) != TALK_INVALID_VALUE;
    op.metering = "unknown"; op.metering_len = 7;
    bad |= talk_define_capability(core, "bad", 3, &op, 1, NULL, 0, &def) != TALK_INVALID_VALUE;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

int main(void) {
    expect_text("", 0, "");
    expect_text("cat", 3, "cat");
    /* NFC applies at the constructor: e and a combining acute become é. */
    expect_text("Cafe\xCC\x81", 6, "Caf\xC3\xA9");
    /* U+212B ANGSTROM SIGN is a singleton; NFC gives U+00C5. */
    expect_text("\xE2\x84\xAB", 3, "\xC3\x85");
    /* Embedded NUL is a scalar like any other. */
    expect_text_n("a\0b", 3, "a\0b", 3);

    expect_refused("\xC3", 1, "a truncated sequence is refused");
    expect_refused("\xC0\xAF", 2, "an overlong form is refused");
    expect_refused("\xED\xA0\x80", 3, "a surrogate is refused");
    expect_refused("\xF4\x90\x80\x80", 4, "a scalar above U+10FFFF is refused");
    expect_refused(NULL, 1, "a NULL pointer with a length is refused");


    talk_value *number = NULL, *value = NULL, *copy = NULL;
    const talk_decimal *decimal = NULL;
    talk_owned_bytes buffer = {0};
    expect(talk_dec("7.50", 4, &number) == TALK_OK, "decimal input");
    expect(talk_value_as_dec(number, &decimal), "decimal accessor");
    int64_t integer = 0;
    expect(talk_decimal_int64(decimal, &integer) == TALK_INVALID_VALUE, "fraction is not an integer");
    expect(talk_encode_value(number, &buffer) == TALK_OK, "encode decimal");
    expect(buffer.len == 15 && memcmp(buffer.data, "{\"$dec\":\"7.50\"}", 15) == 0, "trailing zeros survive");
    expect(talk_decode_value(buffer.data, buffer.len, NULL, NULL, &copy) == TALK_OK, "decode decimal");
    bool equal = false;
    expect(talk_value_equal(number, copy, &equal) == TALK_OK && equal, "encoding round trip");
    talk_value_release(copy);
    talk_owned_bytes_release(&buffer);
    expect(talk_quantity(decimal, "days", 4, &value) == TALK_OK, "plural unit constructor");
    const talk_decimal *amount = NULL;
    expect(talk_value_as_quantity(value, &amount, &buffer) == TALK_OK && buffer.len == 3 && memcmp(buffer.data, "day", 3) == 0, "canonical singular unit");
    talk_owned_bytes_release(&buffer); talk_value_release(value);
    unsigned char input[] = {1, 2, 3};
    expect(talk_bytes(input, 3, &value) == TALK_OK, "bytes constructor");
    input[0] = 9;
    expect(talk_value_as_bytes(value, &buffer) == TALK_OK && buffer.data[0] == 1, "bytes copied in");
    buffer.data[0] = 9; talk_owned_bytes_release(&buffer);
    expect(talk_value_as_bytes(value, &buffer) == TALK_OK && buffer.data[0] == 1, "bytes copied out");
    talk_owned_bytes_release(&buffer); talk_value_release(value);
    talk_pair pairs[] = {{"e\xCC\x81", 3, number}, {"\xC3\xA9", 2, number}};
    expect(talk_map(pairs, 2, &value) == TALK_INVALID_VALUE && value == NULL, "duplicate NFC keys refused");
    expect(talk_map(pairs, 1, &value) == TALK_OK, "map constructor retains child");
    talk_value_release(number);
    expect(talk_value_get(value, "\xC3\xA9", 2, &copy) == TALK_OK && talk_value_kind(copy) == TALK_KIND_NUMBER, "normalized map key");
    talk_value_release(copy); talk_value_release(value);
    expect(talk_from_float(NAN, &value) == TALK_INVALID_VALUE && value == NULL, "NaN refused");
    expect(talk_from_float(INFINITY, &value) == TALK_INVALID_VALUE, "infinity refused");
    expect(talk_from_float(-INFINITY, &value) == TALK_INVALID_VALUE, "negative infinity refused");
    expect(talk_from_float(1e34, &value) == TALK_INVALID_VALUE, "float magnitude limit");
    expect(talk_dec("10000000000000000000000000000000000", 35, &value) == TALK_INVALID_VALUE, "decimal magnitude limit");
    expect(talk_dec("1.2345678901234567890123456789012345", 36, &value) == TALK_INVALID_VALUE, "34 digit input limit");
    expect(talk_from_float(0.1, &value) == TALK_OK, "float conversion");
    expect(talk_value_string(value, &buffer) == TALK_OK && buffer.len == 3 && memcmp(buffer.data, "0.1", 3) == 0, "shortest decimal float digits");
    talk_owned_bytes_release(&buffer); talk_value_release(value);
    expect(talk_instant(-1, 999999, &value) == TALK_OK, "negative epoch constructor");
    int64_t seconds = 0; int32_t micros = 0;
    const char *text_out = NULL; size_t text_len = 0;
    expect(talk_value_as_instant(value, &seconds, &micros) && seconds == -1 && micros == 999999, "instant accessor");
    talk_value_release(value);
    expect(talk_instant(0, -1, &value) == TALK_INVALID_VALUE, "invalid microseconds refused");
    expect(talk_instant(0, 1000000, &value) == TALK_INVALID_VALUE && value == NULL, "a million microseconds refused");
    expect(talk_parse_civil_date("2026-09-27T14:30:00.1234567", 27, &value) == TALK_INVALID_VALUE, "a seven-digit fraction refused");
    expect(talk_parse_civil_date("2026-02-30", 10, &value) == TALK_INVALID_VALUE, "invalid date refused");
    expect(talk_int(INT64_MIN, &value) == TALK_OK, "minimum int64");
    expect(talk_value_as_dec(value, &decimal) && talk_decimal_int64(decimal, &integer) == TALK_OK && integer == INT64_MIN, "integer accessor");
    talk_value_release(value);
    expect(talk_list(NULL, 0, &value) == TALK_OK, "empty list constructor");
    expect(talk_value_index(value, 1, &copy) == TALK_OK && talk_value_kind(copy) == TALK_KIND_NOTHING, "missing item is Nothing");
    talk_value_release(copy); talk_value_release(value);
    talk_value_release(NULL);
    /* talk_kv builds talk_map's entries. */
    talk_value *one = NULL;
    talk_int(1, &one);
    talk_pair entries[] = {talk_kv("a", 1, one)};
    expect(talk_map(entries, 1, &value) == TALK_OK && talk_value_get(value, "a", 1, &copy) == TALK_OK && talk_value_kind(copy) == TALK_KIND_NUMBER, "talk_kv builds a map entry");
    talk_value_release(copy); talk_value_release(value);
    /* Indexed entries cross shared storage blocks in insertion order. */
    talk_pair many[65];
    char keys[65][8];
    for (size_t i = 0; i < 65; ++i) {
        int len = snprintf(keys[i], sizeof keys[i], "k%zu", i);
        many[i] = talk_kv(keys[i], (size_t)len, one);
    }
    expect(talk_map(many, 65, &value) == TALK_OK, "large Map constructor");
    for (size_t i = 0; i < 65; ++i) {
        talk_pair entry;
        expect(talk_value_entries(value, i, &entry), "large Map indexed entry");
        expect(entry.key_len == strlen(keys[i]) && memcmp(entry.key, keys[i], entry.key_len) == 0, "large Map insertion order");
        expect(talk_value_kind(entry.value) == TALK_KIND_NUMBER, "large Map retained child");
        talk_value_release(entry.value);
    }
    talk_pair past;
    expect(!talk_value_entries(value, 65, &past), "large Map entry end");
    talk_value_release(value);
    struct timespec moment = {1790000000, 250000999};
    expect(talk_instant_from_time(&moment, &value) == TALK_OK && talk_value_as_instant(value, &seconds, &micros) && seconds == 1790000000 && micros == 250000, "an Instant from a timespec truncates to microseconds");
    talk_value_release(value);
    moment.tv_nsec = 1000000000;
    expect(talk_instant_from_time(&moment, &value) == TALK_INVALID_VALUE && value == NULL, "a timespec past its nanoseconds is refused");
    /* Plain JSON keeps a number's digits, both ways. */
    const char *json = "{\"name\":\"Ann\",\"scores\":[2.50,null]}";
    expect(talk_decode_json((const unsigned char *)json, strlen(json), &value) == TALK_OK, "plain JSON decodes");
    expect(talk_encode_json(value, &buffer) == TALK_OK && buffer.len == strlen(json) && memcmp(buffer.data, json, buffer.len) == 0, "plain JSON encodes back");
    talk_owned_bytes_release(&buffer); talk_value_release(value);
    expect(talk_decode_json((const unsigned char *)"1e5", 3, &value) == TALK_OK && talk_value_string(value, &buffer) == TALK_OK && buffer.len == 6 && memcmp(buffer.data, "100000", 6) == 0, "a JSON exponent is applied");
    talk_owned_bytes_release(&buffer); talk_value_release(value);
    expect(talk_decode_json((const unsigned char *)"[1,]", 4, &value) == TALK_INVALID_VALUE && value == NULL, "invalid JSON is refused");
    expect(talk_instant(0, 0, &copy) == TALK_OK && talk_encode_json(copy, &buffer) == TALK_INVALID_VALUE, "an Instant has no plain JSON form");
    /* Add is `+`, outside any Run: dates too, and its errors are a Run's. */
    talk_value *two = NULL, *sum = NULL;
    talk_int(2, &two);
    talk_script_error added = {0};
    expect(talk_add(one, two, &sum, &added) == TALK_OK && talk_value_as_dec(sum, &decimal) && talk_decimal_int64(decimal, &integer) == TALK_OK && integer == 3, "1 + 2");
    talk_value_release(sum);
    talk_value *later = NULL, *minute = NULL;
    talk_parse_display("1 min", 5, &minute);
    expect(talk_add(copy, minute, &later, &added) == TALK_OK && talk_value_as_instant(later, &seconds, &micros) && seconds == 60, "an Instant plus a duration");
    talk_value_release(later);
    talk_value *text = NULL;
    talk_text("x", 1, &text);
    expect(talk_add(one, text, &sum, &added) == TALK_SCRIPT_FAILED && sum == NULL, "1 + \"x\" fails");
    expect(added.code_len == 10 && memcmp(added.code, "wrong kind", 10) == 0 && added.message_len > 0, "with wrong kind and its message");
    talk_value *field = NULL;
    expect(talk_value_get(added.data, "expected", 8, &field) == TALK_OK && talk_value_as_text(field, &text_out, &text_len) && text_len == 6 && memcmp(text_out, "number", 6) == 0, "and its fields as data");
    talk_value_release(field);
    talk_script_error_release(&added);
    expect(added.data == NULL && added.message == NULL, "the error released");
    talk_value_release(text); talk_value_release(minute); talk_value_release(copy); talk_value_release(two); talk_value_release(one);
    talk_versions versions;
    talk_core_versions(&versions);
    expect(versions.language_len > 0 && versions.cost_model_len > 0 && versions.unicode_len > 0, "the versions are named");
    expect(versions.core_len > 4 && memcmp(versions.core, "zig/", 4) == 0 && versions.save_format_len > 4 && memcmp(versions.save_format, "zig/", 4) == 0, "the Core and save format are the Zig Core's");
    talk_host_error host_error = {TALK_NAME_REUSED, "pricing", 7};
    expect(talk_host_error_error(&host_error, &buffer) == TALK_OK && buffer.len == 20 && memcmp(buffer.data, "name reused: pricing", 20) == 0, "a Host error's text");
    talk_owned_bytes_release(&buffer);
    talk_script_error script_error = {"empty", 5, "nothing to echo", 15, NULL};
    expect(talk_script_error_error(&script_error, &buffer) == TALK_OK && buffer.len == 22 && memcmp(buffer.data, "empty: nothing to echo", 22) == 0, "a Script error's text");
    talk_owned_bytes_release(&buffer);
    expect(group_test() == 0, "a Group loads and pumps a Script through talk.h alone");
    expect(pending_failure_test() == 0, "failed C Requests and Function calls settle");
    expect(pending_terminal_test() == 0, "C Pending handles settle for terminal outcomes");
    expect(pending_release_test() == 0, "C Pending handles take their results when released");
    expect(capability_test() == 0, "a Host defines, grants and answers a Capability through talk.h alone");
    expect(release_cancellation_test() == 0, "Stop cancels pending Calls before releasing Grants");
    expect(revoke_test() == 0, "revoke releases a Grant once, and later calls through it raise capability revoked");
    expect(sqlite_test() == 0, "sqlite refuses a malformed binding, authorizes each step and gives rows as maps");
    expect(metering_test() == 0, "metered C calls request Fuel through a Pump and retain their future and issued eligibility");
    expect(store_test() == 0, "store needs its coordinator's hooks, and get hears an omitted default as Nothing");
    expect(router_test() == 0, "the router routes commits, retries a full mailbox after a Pump, and resyncs a checkpoint after a change");
    expect(broadcast_selection_test() == 0, "Broadcast excludes cancelled waits, retains Handlers, and refuses loose limits without consuming ids");
    expect(decision_test() == 0, "a Decision is vetoed or allowed by its deciding clause, and a bad Selector is refused at the call");
    expect(segment_test() == 0, "Grants sharing a Segment Coordinator commit together, and a failed commit rolls the Segment back");
    expect(scope_test() == 0, "a Capability Scope's declarations are checked, and its Run abandons it through talk.h alone");
    expect(standard_test() == 0, "clock answers from the Pump's Clock, and say reaches console's write");
    expect(suspension_test() == 0, "a Run suspends at a suspending call and resumes with the Host's answer");
    expect(limits_test() == 0, "a Script's limits fault and roll back a Run, a loosening override is refused, and a full mailbox refuses a Delivery");
    expect(slice_test() == 0, "a Run preempted by its Fuel Slice continues in a later Pump");
    expect(cancel_test() == 0, "a cancelled Run runs its finally on its Cleanup Budget, and a cancelled Request leaves the mailbox");
    expect(library_check_test() == 0, "Library checks refuse Joins, undeclared Grants and unknown imports' names as talk.go does");
    expect(function_error_during_test() == 0, "Function error during retains fn and arguments through talk.h");
    expect(function_call_test() == 0, "Function Value calls refuse loose overrides and full or stopped Homes as talk.go does");
    expect(object_elements_test() == 0, "Object Collections are checked and copied at registration and answer their callbacks");
    expect(object_path_test() == 0, "Host Object costs, owners, full climbs and stopped receivers follow talk.go and talk.ts");
    expect(negative_override_test() == 0, "a negative override is refused with its input and refused records");
    expect(decision_cancel_test() == 0, "cancelling a Decision by delivery or broadcast id spares sealed recipients and does nothing after the seal");
    expect(stop_call_cancellation_test(false, false, false, " abandoned=[s/r1.c1]") == 0, "Stop cancels a suspended Call before release");
    expect(stop_call_cancellation_test(true, false, false, " abandoned=[s/r1.c1, s/r1.c2]") == 0, "Stop cancels pending Join Calls before release");
    expect(stop_call_cancellation_test(false, true, false, NULL) == 0, "Stop cancels an unconsumed answer before release");
    expect(stop_call_cancellation_test(true, true, false, " abandoned=[s/r1.c2]") == 0, "Stop cancels settled and pending Join Calls before release");
    expect(stop_call_cancellation_test(false, true, true, NULL) == 0, "Stop leaves a consumed answer uncancelled");
    expect(stop_test() == 0, "a stopped Script discards its Runs with no finally and drops later Deliveries");
    expect(save_test() == 0, "a save restores a waiting Run, a corrupt save is refused, and the first Pump can't go back in time");
    expect(reload_test() == 0, "Extend adds new names, Reload carries Script Variables by name, and replacing a Library rebuilds its importer");
    expect(runaway_test() == 0, "the three runaway Scripts each end in their Limit Fault in a capped Group, and a Script beside them is untouched");
    expect(user_test() == 0, "timer forwards schedule's arguments, and user's choose hears resolved options and fails an answer that isn't an item");
    expect(memory_test() == 0, "a Group past its physical cap refuses, takes no more work and gives back every byte");
    expect(host_list_memory_test() == 0, "growing a Host List uses the Group allocator and obeys its physical cap");
    expect(collecting_versions_test() == 0, "collecting and item writes preserve versions and Host inputs");
    expect(snapshot_growth_test() == 0, "appending constant-size List snapshots stays fast with unchanged charges and values");
    expect(library_constant_functions_test() == 0, "Library Constants and defaults bind Function Values to each caller and Group");
    expect(library_test() == 0, "Libraries register in import order, run in the caller's Run and import the stdlib");
    expect(host_command_test() == 0, "a Host Command is called by its name, checked as its ask, refused on a Reserved Word, and declared to Libraries and the Host Manifest");
    expect(manifest_test() == 0, "the Host Manifest is the same bytes from the same definitions, in name order, with Operation documentation");
    expect(object_test() == 0, "a Request to a Host Object climbs to its Owning Script, which sets and reads a property");
    expect(combined_test() == 0, "combined public Request and Function APIs");
    return failures == 0 ? 0 : 1;
}
