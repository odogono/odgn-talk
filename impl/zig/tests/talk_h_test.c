/* talk.h's value API, called as a C Host calls it. */
#include <stdio.h>
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
    talk_group_options options = {"g", 1, record, NULL};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const char *source = "script variable total = 0\non bump n\n  add n to total\n  return total & \"!\"\nend bump\n";
    talk_load_options load = {"adder", 5, source, strlen(source), NULL, 0, false};
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
    talk_load_options broken = {"broken", 6, "on t\n  put 1 into 3\nend t\n", 26, NULL, 0, false};
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
    talk_group_options options = {"g", 1, record, NULL};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    const talk_shape *args[] = {talk_text_shape()};
    talk_operation ops[] = {{"twice", 5, args, 1, talk_text_shape(), {7, 0}, TALK_IMMEDIATE, 0, NULL, 0, twice, NULL}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "echo", 4, ops, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    bad |= talk_grant_capability(grant) != def;
    talk_load_grant grants[] = {{"echo", 4, grant}};
    const char *source = "script variable said\non go s\n  try\n    ask echo to twice s\n    put it into said\n  catch e\n    put e's code into said\n  end try\nend go\n";
    talk_load_options load = {"caller", 6, source, strlen(source), grants, 1, false};
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
    talk_load_options wrong = {"wrong", 5, wrong_source, strlen(wrong_source), grants, 1, false};
    talk_script *refused = NULL;
    bad |= talk_load(group, &wrong, &refused) != TALK_LOAD_REFUSED;
    bad |= strstr(trace, "diag wrong code=\"wrong argument\" pos=2:21\n") == NULL;
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
    talk_group_options options = {"g", 1, record, NULL};
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
    talk_load_options load = {"timed", 5, source, strlen(source), grants, 2, false};
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
    talk_group_options options = {"g", 1, record, NULL};
    if (talk_new_group(core, &options, &group) != TALK_OK) return 1;
    talk_operation ops[] = {{"fetch", 5, NULL, 0, talk_number_shape(), {20, 0}, TALK_SUSPENDING, 1000, NULL, 0, start, NULL}};
    talk_capability_def *def = NULL;
    int bad = talk_define_capability(core, "feed", 4, ops, 1, &def) != TALK_OK;
    talk_grant *grant = NULL;
    bad |= talk_capability_def_grant_all(def, NULL, &grant) != TALK_OK;
    talk_load_grant grants[] = {{"feed", 4, grant}};
    const char *source = "script variable got\non go\n  ask feed to fetch and wait\n  put it into got\nend go\n";
    talk_load_options load = {"waiter", 6, source, strlen(source), grants, 1, false};
    talk_script *script = NULL;
    bad |= talk_load(group, &load, &script) != TALK_OK;
    talk_message message = {"go", 2, NULL, 0};
    bad |= talk_script_deliver(script, &message, NULL) != TALK_OK;
    bad |= talk_pump(group, 1790000000, 0, NULL, NULL) != TALK_OK;
    bad |= started == NULL;
    bad |= strstr(trace, "end=ask-wait\n") == NULL;
    bad |= strstr(trace, "pumped state=idle fuel=") == NULL || strstr(trace, " next=") == NULL;
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
    expect(standard_test() == 0, "clock answers from the Pump's Clock, and say reaches console's write");
    expect(suspension_test() == 0, "a Run suspends at a suspending call and resumes with the Host's answer");
    return failures == 0 ? 0 : 1;
}
