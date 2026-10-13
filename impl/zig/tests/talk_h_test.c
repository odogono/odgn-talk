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
    talk_load_options broken = {"broken", 6, "on t\n  put 1 into 3\nend t\n", 26, NULL, 0, false, NULL, NULL, 0, NULL};
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
        talk_inspect(group);
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
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
    talk_core_release(core);
    return bad;
}

/* A release hook: counts its calls and keeps what the last one was told. */
static int released = 0;
static talk_release_reason released_reason = TALK_RELEASE_STOP;
static char released_grant[16];
static void release(void *context, const talk_grant_context *g) {
    (void)context;
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL, NULL, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "echo", 4, ops, 1, &def) != TALK_OK;
    bad |= talk_with_release_hook(core, def, NULL, NULL) != TALK_INVALID_VALUE;
    bad |= talk_with_release_hook(core, def, release, NULL) != TALK_OK;
    bad |= talk_with_release_hook(core, def, release, NULL) != TALK_INVALID_VALUE;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const char *source = "script variable said\non go\n  try\n    ask echo to twice \"ab\"\n  catch e\n    put e's code into said\n  end try\nend go\n";
    talk_load_options load = {"s", 1, source, strlen(source), grants, 1, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    released = 0;
    bad |= talk_script_revoke(script, "echo", 4) != TALK_OK;
    bad |= talk_script_revoke(script, "echo", 4) != TALK_OK;
    bad |= talk_script_revoke(script, "other", 5) != TALK_OK;
    talk_message go = {"go", 2, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &go, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group);
    bad |= released != 1 || released_reason != TALK_RELEASE_REVOKE || strcmp(released_grant, "echo") != 0;
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
    talk_load_options load = {"s", 1, source, strlen(source), grants, 2, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
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

/* Decisions: a `, deciding` clause vetoes or allows, and a Selector that
 * isn't one is refused at the call. */
static int decision_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_named_cost entries[] = {{"get", 3, {1, 0}}, {"set", 3, {1, 0}}, {"delete", 6, {1, 0}}, {"keys", 4, {1, 0}}, {"increment", 9, {1, 0}}, {"swap", 4, {1, 0}}, {"watch", 5, {1, 0}}, {"unwatch", 7, {1, 0}}};
    talk_costs costs = {entries, 8};
    talk_store_impl impl = {NULL, store_get, unused, unused, unused, unused, unused, unused, unused, {NULL, NULL, NULL, NULL}, NULL};
    talk_capability_def *def = NULL;
    int bad = talk_store_capability(core, &impl, &costs, &def) != TALK_INVALID_VALUE;
    impl.coordinator = (talk_segment_lifecycle){begin_hook, commit_hook, rollback_hook, NULL};
    bad |= talk_store_capability(core, &impl, &costs, &def) != TALK_OK;
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
static const char *n_column[] = {"n"};
static const size_t n_len[] = {1};
static talk_sql_value one_row[1];
static talk_call_end sql_query(void *context, talk_call *call, const char *sql, size_t sql_len, const talk_sql_params *params, int64_t max, talk_sql_rows *rows, talk_script_error *error) {
    (void)context; (void)call; (void)sql; (void)sql_len; (void)error;
    sql_max = max;
    one_row[0] = (talk_sql_value){TALK_SQL_INTEGER, (int64_t)params->len, 0, NULL, 0};
    *rows = (talk_sql_rows){n_column, n_len, 1, one_row, 1, 0};
    return TALK_CALL_ANSWERED;
}

static const talk_segment_lifecycle *database_coordinator(void *context, const char *database, size_t len) {
    (void)context; (void)database; (void)len;
    return &shared_lifecycle;
}

/* sqlite: a malformed binding refuses the Grant, max defaults to the row
 * cap and is charged per row, and rows come back as maps. */
static int sqlite_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    trace_len = 0;
    memset(trace, 0, sizeof trace);
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
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
    bad |= strstr(trace, "result=[{n: 2}] charged=8\n") == NULL;
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_limits negative = {0};
    negative.fuel_per_run = -1;
    const char *source = "script variable n = 0\non spin\n  repeat forever\n    add 1 to n\n  end repeat\nend spin\n";
    talk_load_options refused = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, &negative};
    talk_script *script = NULL;
    bad |= talk_load(group, &refused, &script) != TALK_INVALID_VALUE;
    talk_limits limits = {0};
    limits.fuel_per_run = 100;
    limits.mailbox_depth = 1;
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, &limits};
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_limit_override looser = {TALK_OVERRIDE_FUEL_PER_RUN, 200, 0, 0, 0};
    talk_message loose = {"spin", 4, NULL, 0, &looser};
    bad |= talk_script_deliver(script, &loose, NULL) != TALK_INVALID_VALUE;
    talk_message spin = {"spin", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &spin, NULL) != TALK_OK;
    bad |= talk_script_deliver(script, &spin, NULL) != TALK_ERR_MAILBOX_FULL;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group);
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
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
    talk_pump_result result = {TALK_IDLE, 0};
    bad |= talk_pump(group, 1790000000, 0, &sliced, &result) != TALK_OK;
    bad |= result.state != TALK_SLICED || result.fuel_used < 20;
    bad |= strstr(trace, "> pump clock=2026-09-21T14:13:20Z fuel-slice=20\n") == NULL;
    bad |= strstr(trace, "preempt s/r1 start delivery=d1 handler=count clause=1 by=slice fuel=") == NULL;
    bad |= strstr(trace, "pumped state=sliced fuel=") == NULL;
    bad |= talk_pump(group, 1790000000, 0, NULL, &result) != TALK_OK;
    bad |= result.state != TALK_IDLE;
    talk_inspect(group);
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
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
    talk_inspect(group);
    bad |= strstr(trace, "> cancel-run s/r1\n") == NULL || strstr(trace, "> cancel-delivery d2\n") == NULL;
    bad |= strstr(trace, "run s/r1 outcome=cancelled delivery=d1 handler=hold") == NULL;
    bad |= strstr(trace, "vars s n=9\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
    talk_group_release(group);
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable n = 0\non hold\n  try\n    wait 1 s\n  finally\n    put 9 into n\n  end try\nend hold\n";
    talk_load_options load = {"s", 1, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    int bad = talk_load(group, &load, &script) != TALK_OK;
    talk_message hold = {"hold", 4, NULL, 0, NULL};
    bad |= talk_script_deliver(script, &hold, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= talk_script_stop(script, "done", 4) != TALK_OK;
    talk_pump_result result = {TALK_IDLE, 0};
    bad |= talk_pump(group, 1790000000, 0, NULL, &result) != TALK_OK;
    bad |= result.state != TALK_STOPPED;
    bad |= talk_script_deliver(script, &hold, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    talk_inspect(group);
    bad |= strstr(trace, "> stop s reason=\"done\"\n") == NULL;
    bad |= strstr(trace, "stopped s reason=\"done\" discarded=[s/r1]\n") == NULL;
    bad |= strstr(trace, "stopped s reason=\"done\" dropped=[d2]\n") == NULL;
    bad |= strstr(trace, "vars s n=0\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 128u << 20};
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
    talk_inspect(group);
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
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
    talk_inspect(group);
    bad |= strstr(trace, "call-failed s/r1.c2 op=user.choose\n") == NULL;
    bad |= strstr(trace, "vars s got=\"host error\"\n") == NULL;
    if (bad) fprintf(stderr, "%s", trace);
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
    talk_group_options options = {"g", 1, record, NULL, NULL, 0};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_operation ops[] = {{"fetch", 5, NULL, 0, talk_number_shape(), {20, 0}, TALK_SUSPENDING, 1000, NULL, 0, start, NULL, NULL, false}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "feed", 4, ops, 1, &def) != TALK_OK;
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
    talk_load_options load = {"user", 4, source, strlen(source), NULL, 0, false, NULL, NULL, 0, NULL};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0, NULL};
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

static int host_list_memory_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_allocator host = {NULL, host_alloc, host_free};
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, NULL, NULL, &host, 64 * 1024};
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

/* Every root visibly stays [nothing]. Older slices must not make appending
 * these constant-size snapshots walk an ever-growing hidden ownership graph. */
static int snapshot_growth_test(void) {
    talk_core *core = talk_new();
    if (core == NULL) return 1;
    talk_group *group = NULL;
    talk_group_options options = {"g", 1, NULL, NULL, NULL, 0};
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
    talk_group_options options = {"g", 1, record, NULL, &host, 256 * 1024};
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
    expect(revoke_test() == 0, "revoke releases a Grant once, and later calls through it raise capability revoked");
    expect(sqlite_test() == 0, "sqlite refuses a malformed binding, charges max per row and gives rows as maps");
    expect(store_test() == 0, "store needs its coordinator's hooks, and get hears an omitted default as Nothing");
    expect(decision_test() == 0, "a Decision is vetoed or allowed by its deciding clause, and a bad Selector is refused at the call");
    expect(segment_test() == 0, "Grants sharing a Segment Coordinator commit together, and a failed commit rolls the Segment back");
    expect(scope_test() == 0, "a Capability Scope's declarations are checked, and its Run abandons it through talk.h alone");
    expect(standard_test() == 0, "clock answers from the Pump's Clock, and say reaches console's write");
    expect(suspension_test() == 0, "a Run suspends at a suspending call and resumes with the Host's answer");
    expect(limits_test() == 0, "a Script's limits fault and roll back a Run, a loosening override is refused, and a full mailbox refuses a Delivery");
    expect(slice_test() == 0, "a Run preempted by its Fuel Slice continues in a later Pump");
    expect(cancel_test() == 0, "a cancelled Run runs its finally on its Cleanup Budget, and a cancelled Request leaves the mailbox");
    expect(stop_test() == 0, "a stopped Script discards its Runs with no finally and drops later Deliveries");
    expect(runaway_test() == 0, "the three runaway Scripts each end in their Limit Fault in a capped Group, and a Script beside them is untouched");
    expect(user_test() == 0, "timer forwards schedule's arguments, and user's choose hears resolved options and fails an answer that isn't an item");
    expect(memory_test() == 0, "a Group past its physical cap refuses, takes no more work and gives back every byte");
    expect(host_list_memory_test() == 0, "growing a Host List uses the Group allocator and obeys its physical cap");
    expect(snapshot_growth_test() == 0, "appending constant-size List snapshots stays fast with unchanged charges and values");
    expect(library_test() == 0, "Libraries register in import order, run in the caller's Run and import the stdlib");
    expect(object_test() == 0, "a Request to a Host Object climbs to its Owning Script, which sets and reads a property");
    return failures == 0 ? 0 : 1;
}
