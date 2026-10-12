/* talk.h's value API, called as a C Host calls it. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable total = 0\non bump n\n  add n to total\n  return total & \"!\"\nend bump\n";
    talk_load_options load = {"adder", 5, source, strlen(source), NULL, 0, false, NULL, NULL, 0};
    talk_script *script = NULL;
    if (talk_load(group, &load, &script) != TALK_OK) return 1;
    int bad = 0;
    talk_value *n = NULL;
    talk_int(41, &n);
    talk_value *args[] = {n};
    talk_message message = {"bump", 4, args, 1};
    talk_pending *pending = NULL;
    talk_owned_bytes id = {0};
    bad |= talk_script_request(script, &message, &id, &pending) != TALK_OK;
    bad |= id.len != 2 || memcmp(id.data, "d1", 2) != 0;
    talk_owned_bytes_release(&id);
    talk_value_release(n);
    talk_pump_result pumped = {0};
    bad |= talk_pump(group, 1790000000, 0, NULL, &pumped) != TALK_OK;
    bad |= pumped.state != TALK_IDLE || pumped.fuel_used <= 0;
    talk_value *result = NULL;
    const char *text = NULL;
    size_t len = 0;
    bad |= talk_pending_result(pending, &result) != TALK_OK;
    bad |= !talk_value_as_text(result, &text, &len) || len != 3 || memcmp(text, "41!", 3) != 0;
    talk_value_release(result);
    talk_inspect(group);
    bad |= strstr(trace, "vars adder total=41\n") == NULL;
    talk_load_options broken = {"broken", 6, "on t\n  put 1 into 3\nend t\n", 26, NULL, 0, false, NULL, NULL, 0};
    talk_script *refused = NULL;
    bad |= talk_load(group, &broken, &refused) != TALK_LOAD_REFUSED || refused != NULL;
    bad |= strstr(trace, "diag broken code=\"not a container\" pos=2:14\n") == NULL;
    talk_pending_release(pending);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "echo", 4, ops, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    bad |= talk_grant_capability(grant) != def;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const char *source = "script variable said\non go s\n  try\n    ask echo to twice s\n    put it into said\n  catch e\n    put e's code into said\n  end try\nend go\n";
    talk_load_options load = {"caller", 6, source, strlen(source), grants, 1, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    const char *inputs[] = {"ab", ""};
    for (int i = 0; i < 2; i++) {
        talk_value *text = NULL;
        talk_text(inputs[i], strlen(inputs[i]), &text);
        talk_value *message_args[] = {text};
        talk_message message = {"go", 2, message_args, 1};
        bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
        talk_value_release(text);
        bad |= talk_pump(group, 1790000000 + i, 0, NULL, NULL) != TALK_OK;
        talk_inspect(group);
    }
    bad |= strstr(trace, "call caller/r1.c1 op=echo.twice args=[\"ab\"] result=\"abab\" charged=3\n") == NULL;
    bad |= strstr(trace, "vars caller said=\"abab\"\n") == NULL;
    bad |= strstr(trace, "call caller/r2.c1 op=echo.twice args=[\"\"] error={code: \"empty\", message: \"nothing to echo\"}\n") == NULL;
    bad |= strstr(trace, "vars caller said=\"empty\"\n") == NULL;
    const char *wrong_source = "on go\n  ask echo to twice 5\nend go\n";
    talk_load_options wrong = {"wrong", 5, wrong_source, strlen(wrong_source), grants, 1, false, NULL, NULL, 0};
    talk_script *refused = NULL;
    bad |= talk_load(group, &wrong, &refused) != TALK_LOAD_REFUSED;
    bad |= strstr(trace, "diag wrong code=\"wrong argument\" pos=2:21\n") == NULL;
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_scope_decl opens = {"file", 4, "close", 5, NULL, 0};
    talk_scope_decl closes = {NULL, 0, NULL, 0, "file", 4};
    talk_scope_decl opens_lock = {"file", 4, "unlock", 6, NULL, 0};
    const talk_shape *one[] = {talk_text_shape()};
    talk_capability_def *def = NULL;
    int bad = 0;
    /* An opener whose abandonment Operation is missing, takes arguments,
     * closes another scope or disagrees with another opener's. */
    talk_operation missing[] = {{"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false}};
    bad |= talk_define_capability(core, "a", 1, missing, 1, &def) != TALK_INVALID_VALUE;
    talk_operation with_args[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false},
        {"close", 5, one, 1, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false},
    };
    bad |= talk_define_capability(core, "b", 1, with_args, 2, &def) != TALK_INVALID_VALUE;
    talk_operation disagreeing[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false},
        {"reopen", 6, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens_lock, false},
        {"close", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false},
        {"unlock", 6, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false},
    };
    bad |= talk_define_capability(core, "c", 1, disagreeing, 4, &def) != TALK_INVALID_VALUE;
    /* A suspending lifecycle Operation, and a Segment-bound one with no
     * Segment Coordinator. */
    talk_operation suspending[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_SUSPENDING, 0, NULL, 0, lifecycle, NULL, &opens, false},
        {"close", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false},
    };
    bad |= talk_define_capability(core, "d", 1, suspending, 2, &def) != TALK_INVALID_VALUE;
    talk_operation bound[] = {{"change", 6, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, NULL, true}};
    bad |= talk_define_capability(core, "e", 1, bound, 1, &def) != TALK_INVALID_VALUE;

    talk_operation ops[] = {
        {"open", 4, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &opens, false},
        {"close", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, &closes, false},
    };
    bad |= talk_define_capability(core, "files", 5, ops, 2, &def) != TALK_OK;
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
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    /* The opener, then the Core's abandonment, which can't charge. */
    bad |= strcmp(lifecycle_seen, "file s/r1 s/r1.s1 no\nfile s/r1 s/r1.s1 yes\n") != 0;
    bad |= strstr(trace, "scope s/r1.c1 grant=out name=file action=opened\n") == NULL;
    bad |= strstr(trace, "call s/r1.c2 op=out.close args=[] error={} automatic=yes\nscope s/r1.c2 grant=out name=file action=failed\neffect-failure s/r1 grant=out segment=s/r1.s1 phase=abandon status=unknown scope=file\n") == NULL;
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_operation ops[] = {{"write", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_IMMEDIATE, 0, NULL, 0, lifecycle, NULL, NULL, true}};
    talk_capability_def *def = NULL;
    int bad = 0;
    /* A coordinator without all three hooks, and a suspending Segment-bound
     * Operation. */
    talk_segment_lifecycle partial = {begin_hook, commit_hook, NULL, NULL};
    bad |= talk_define_segment_capability(core, "a", 1, ops, 1, &partial, &def) != TALK_INVALID_VALUE;
    talk_operation suspending[] = {{"write", 5, NULL, 0, talk_nothing_shape(), {1, 0}, TALK_SUSPENDING, 0, NULL, 0, lifecycle, NULL, NULL, true}};
    bad |= talk_define_segment_capability(core, "b", 1, suspending, 1, &shared_lifecycle, &def) != TALK_INVALID_VALUE;
    bad |= talk_define_coordinated_capability(core, "db", 2, ops, 1, coordinator_of, NULL, &def) != TALK_OK;
    talk_grant *refused = NULL, *one = NULL, *two = NULL;
    bad |= talk_capability_def_grant_all(def, "other", &refused) != TALK_INVALID_VALUE;
    bad |= talk_capability_def_grant_all(def, "shared", &one) != TALK_OK;
    bad |= talk_capability_def_grant_all(def, "shared", &two) != TALK_OK;
    talk_load_grant grants[] = {{"a", 1, one}, {"b", 1, two}};
    const char *source = "script variable n = 0\non go\n  ask a to write\n  ask b to write\n  add 1 to n\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 2, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    /* One begin for the first Grant; the commit sees both. */
    bad |= strcmp(effects_seen, "begin a s/r1.s1 1\ncommit a s/r1.s1 2\n") != 0;
    commit_status = TALK_EFFECT_FAILED;
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000001, 0, NULL, NULL) != TALK_OK;
    commit_status = TALK_EFFECT_OK;
    talk_inspect(group);
    bad |= strstr(trace, "run s/r2 outcome=effect-failed delivery=d2 handler=go effect={grant: \"a\", segment: \"s/r2.s1\", phase: \"commit\", status: \"failed\"}") == NULL;
    bad |= strstr(effects_seen, "commit a s/r2.s1 2\nrollback a s/r2.s1 2\n") == NULL;
    /* The second Run's add was rolled back. */
    bad |= strstr(trace, "vars s n=1\n") == NULL;
    if (bad) fprintf(stderr, "%s%s", trace, effects_seen);
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
static int standard_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
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
    talk_load_options load = {"timed", 5, source, strlen(source), grants, 2, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= strstr(trace, "call timed/r1.c1 op=clock.now args=[] result=2026-09-21T14:13:20Z\n") == NULL;
    bad |= shown != 1;
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

/* A Run suspends at ask … and wait, and resumes with the Host's answer. */
static int suspension_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_operation ops[] = {{"fetch", 5, NULL, 0, talk_number_shape(), {20, 0}, TALK_SUSPENDING, 1000, NULL, 0, start, NULL, NULL, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "feed", 4, ops, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"feed", 4, grant}};
    const char *source = "script variable got\non go\n  ask feed to fetch and wait\n  put it into got\nend go\n";
    talk_load_options load = {"waiter", 6, source, strlen(source), grants, 1, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0};
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
    talk_inspect(group);
    bad |= strstr(trace, "> answer waiter/r1.c1 value=42 fuel=3\n") == NULL;
    bad |= strstr(trace, "vars waiter got=42\n") == NULL;
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_text("off", 3, &lamp_state);
    talk_prop props[] = {{"state", 5, talk_text_shape(), get_state, set_state, NULL, {2, 0}, {5, 0}}};
    talk_object_kind_def lamp_def = {"lamp", 4, props, 1, NULL, NULL, 0};
    talk_object_kind_def room_def = {"room", 4, NULL, 0, NULL, NULL, 0};
    talk_object_kind *lamp = NULL, *room = NULL;
    int bad = talk_define_object_kind(core, &lamp_def, &lamp) != TALK_OK;
    bad |= talk_define_object_kind(core, &room_def, &room) != TALK_OK;
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
    talk_load_options load = {"hall", 4, source, strlen(source), NULL, 0, false, hall, bound, 1};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"toggle", 6, NULL, 0};
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

static int library_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *base_source = "constant step = 10\nfunction bump n, by = step\n  return n + by\nend bump\n";
    talk_library_source base_src = {"base", 4, "1", 1, base_source, strlen(base_source)};
    talk_library *base = NULL, *top = NULL, *clash = NULL, *broken = NULL;
    int bad = talk_compile_library(core, &base_src, NULL, 0, NULL, 0, &base) != TALK_OK;
    /* A Library may import the stdlib's, which every Group holds. */
    const char *top_source = "use bump from base\nuse padLeft from text\nfunction label n\n  return padLeft(bump(n) & \"\", 4, \"0\")\nend label\n";
    talk_library_source top_src = {"top", 3, "1", 1, top_source, strlen(top_source)};
    bad |= talk_compile_library(core, &top_src, &base, 1, NULL, 0, &top) != TALK_OK;
    talk_library_source clash_src = {"text", 4, "1", 1, base_source, strlen(base_source)};
    bad |= talk_compile_library(core, &clash_src, NULL, 0, NULL, 0, &clash) != TALK_OK;
    talk_library_source broken_src = {"broken", 6, "1", 1, "function f\n  put 1 into 3\nend f\n", 30};
    bad |= talk_compile_library(core, &broken_src, NULL, 0, NULL, 0, &broken) != TALK_LOAD_REFUSED;
    /* A Constant whose initialiser raises refuses the Library too. */
    talk_library_source failing_src = {"failing", 7, "1", 1, "constant x = 1 / 0\n", 19};
    bad |= talk_compile_library(core, &failing_src, NULL, 0, NULL, 0, &broken) != TALK_LOAD_REFUSED;
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
    const char *source = "use label from top\nscript variable got\non go\n  put label(5) into got\nend go\n";
    talk_load_options load = {"user", 4, source, strlen(source), NULL, 0, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group);
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

static int memory_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_allocator host = {NULL, host_alloc, host_free};
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, &host, 256 * 1024};
    int bad = talk_new_group(core, &options, &group) != TALK_OK;
    /* Each turn of the loop doubles the text, far past the cap long before
     * the logical budgets: the Group refuses, and the process goes on. */
    const char *source = "script variable s\non grow\n  put \"x\" into s\n  repeat 40 times\n    put s & s into s\n  end repeat\nend grow\n";
    talk_load_options load = {"hog", 3, source, strlen(source), NULL, 0, false, NULL, NULL, 0};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"grow", 4, NULL, 0};
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
    expect(talk_instant(-1, 999999999, &value) == TALK_OK, "negative epoch constructor");
    int64_t seconds = 0; int32_t nanos = 0;
    expect(talk_value_as_instant(value, &seconds, &nanos) && seconds == -1 && nanos == 999999999, "instant accessor");
    talk_value_release(value);
    expect(talk_instant(0, -1, &value) == TALK_INVALID_VALUE, "invalid nanoseconds refused");
    expect(talk_parse_civil_date("2026-02-30", 10, &value) == TALK_INVALID_VALUE, "invalid date refused");
    expect(talk_int(INT64_MIN, &value) == TALK_OK, "minimum int64");
    expect(talk_value_as_dec(value, &decimal) && talk_decimal_int64(decimal, &integer) == TALK_OK && integer == INT64_MIN, "integer accessor");
    talk_value_release(value);
    expect(talk_list(NULL, 0, &value) == TALK_OK, "empty list constructor");
    expect(talk_value_index(value, 1, &copy) == TALK_OK && talk_value_kind(copy) == TALK_KIND_NOTHING, "missing item is Nothing");
    talk_value_release(copy); talk_value_release(value);
    talk_value_release(NULL);
    expect(group_test() == 0, "a Group loads and pumps a Script through talk.h alone");
    expect(capability_test() == 0, "a Host defines, grants and answers a Capability through talk.h alone");
    expect(segment_test() == 0, "Grants sharing a Segment Coordinator commit together, and a failed commit rolls the Segment back");
    expect(scope_test() == 0, "a Capability Scope's declarations are checked, and its Run abandons it through talk.h alone");
    expect(standard_test() == 0, "clock answers from the Pump's Clock, and say reaches console's write");
    expect(suspension_test() == 0, "a Run suspends at a suspending call and resumes with the Host's answer");
    expect(memory_test() == 0, "a Group past its physical cap refuses, takes no more work and gives back every byte");
    expect(library_test() == 0, "Libraries register in import order, run in the caller's Run and import the stdlib");
    expect(object_test() == 0, "a Request to a Host Object climbs to its Owning Script, which sets and reads a property");
    return failures == 0 ? 0 : 1;
}
