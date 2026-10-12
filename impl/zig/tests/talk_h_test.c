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
    talk_load_options load = {"adder", 5, source, strlen(source)};
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
    talk_load_options broken = {"broken", 6, "on t\n  put 1 into 3\nend t\n", 26};
    talk_script *refused = NULL;
    bad |= talk_load(group, &broken, &refused) != TALK_LOAD_REFUSED || refused != NULL;
    bad |= strstr(trace, "diag broken code=\"not a container\" pos=2:14\n") == NULL;
    talk_pending_release(pending);
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
    return failures == 0 ? 0 : 1;
}
