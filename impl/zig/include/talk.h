/*
 * The NorthTalk Zig Core's C API.
 *
 * It mirrors spec/embedding/talk.go's names in C style, as tools/zig/api.ts
 * spells them: talk.go's Value is talk_value, Text is talk_text and
 * Value.AsText is talk_value_as_text. A declaration with no talk.go
 * counterpart is marked "C only". The shape is the Zig Core's, not the Spec's.
 *
 * Results are a talk_host_error_code, with any value through an out
 * parameter. TALK_OK means success; every other code is a chapter 9 Host
 * error. A string the Core returns is UTF-8, not NUL-terminated, and lives as
 * long as the handle it came from.
 *
 * Values and their display/encoding are implemented, and step 1 of Group
 * execution: a Core, Groups, loading a Script without Grants, objects or
 * Libraries, Deliveries and Requests to a Script, Pumps and inspection.
 */
#ifndef TALK_H
#define TALK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handles. */
typedef struct talk_core talk_core;
typedef struct talk_group talk_group;
typedef struct talk_script talk_script;

/* One immutable Script value. A function that returns one passes the caller a
 * reference, which the caller ends with talk_value_release. */
typedef struct talk_value talk_value;

/* The Host error codes of chapter 9. */
typedef enum talk_host_error_code {
    /* C only: success, which talk.go reports as a nil error. */
    TALK_OK = 0,
    TALK_CLOCK_BACKWARDS,
    TALK_PARENT_CYCLE,
    TALK_DUPLICATE_OBJECT_ID,
    TALK_NAME_REUSED,
    TALK_REENTRANT_CALL,
    TALK_WRONG_GROUP,
    TALK_LIBRARY_MISMATCH,
    TALK_RESERVED_NAME,
    TALK_NOT_ADOPTABLE,
    TALK_INVALID_VALUE,
    TALK_INVALID_SAVE,
    TALK_SAVE_MISMATCH,
    TALK_UNKNOWN_CALL,
    TALK_STATE_TOO_LARGE,
    TALK_EFFECTS_PENDING,
    TALK_EFFECT_STATE_UNKNOWN,
    /* Call.Charge's refusal: the Run can't cover the charge. */
    TALK_ERR_LIMIT,
    /* C only: a Load refused with diagnostics, which talk.go reports as a
     * LoadError. The Trace has a diag record for each. */
    TALK_LOAD_REFUSED,
    /* C only: the Core couldn't allocate, which Go would report by
     * panicking. Nothing the call would have built exists. */
    TALK_OUT_OF_MEMORY
} talk_host_error_code;

typedef enum talk_kind {
    TALK_KIND_NOTHING,
    TALK_KIND_BOOL,
    TALK_KIND_NUMBER,
    TALK_KIND_QUANTITY,
    TALK_KIND_TEXT,
    TALK_KIND_BYTES,
    TALK_KIND_LIST,
    TALK_KIND_MAP,
    TALK_KIND_RANGE,
    TALK_KIND_INSTANT,
    TALK_KIND_CIVIL_DATE,
    TALK_KIND_PATTERN,
    TALK_KIND_FUNCTION,
    TALK_KIND_OBJECT
} talk_kind;

/* All constructors return an owned reference through out and clear it on
 * refusal. Inputs are borrowed for the duration of the call. Children are
 * retained, bytes are copied, and text (including map keys) becomes NFC.
 * Handles are confined to one thread unless the Host synchronizes access. */
typedef struct talk_decimal talk_decimal;
typedef struct talk_pair { const char *key; size_t key_len; talk_value *value; } talk_pair;
typedef struct talk_date_fields {
    int year, month, day;
    bool has_time;
    int hour, minute, second, nanosecond;
} talk_date_fields;
/* C only: owns an allocated byte slice. Release with talk_owned_bytes_release. */
typedef struct talk_owned_bytes { unsigned char *data; size_t len; } talk_owned_bytes;

talk_host_error_code talk_nothing(talk_value **out);
talk_host_error_code talk_bool(bool b, talk_value **out);
/* Builds text from len bytes of UTF-8 at s, normalised to NFC, uncharged
 * (ADR 0030). Invalid UTF-8 is refused with TALK_INVALID_VALUE. */
talk_host_error_code talk_text(const char *s, size_t len, talk_value **out);
talk_host_error_code talk_int(int64_t n, talk_value **out);
talk_host_error_code talk_uint(uint64_t n, talk_value **out);
/* Shortest round-trip digits. NaN, infinities and |f| >= 1e34 are refused. */
talk_host_error_code talk_from_float(double f, talk_value **out);
/* Chapter 3 number syntax: no rounding, at most 34 significant digits,
 * |n| < 1e34, at most 6176 fraction digits. */
talk_host_error_code talk_dec(const char *s, size_t len, talk_value **out);
talk_host_error_code talk_quantity(const talk_decimal *n, const char *unit, size_t len, talk_value **out);
talk_host_error_code talk_civil_date(talk_date_fields f, talk_value **out);
talk_host_error_code talk_parse_civil_date(const char *s, size_t len, talk_value **out);
talk_host_error_code talk_instant(int64_t seconds, int32_t nanos, talk_value **out);
talk_host_error_code talk_bytes(const unsigned char *s, size_t len, talk_value **out);
talk_host_error_code talk_list(talk_value *const *values, size_t len, talk_value **out);
talk_host_error_code talk_map(const talk_pair *pairs, size_t len, talk_value **out);
talk_host_error_code talk_range(talk_value *from, talk_value *to, talk_value **out);

talk_kind talk_value_kind(const talk_value *v);
bool talk_value_as_bool(const talk_value *v, bool *out);
/* Sets *s and *len to the text's UTF-8, always NFC, and returns true, or
 * returns false for any other kind. The text borrows v until it is released. */
bool talk_value_as_text(const talk_value *v, const char **s, size_t *len);
/* Sets *out to the number's Decimal, borrowed from v until it is released,
 * and returns true, or returns false for any other kind. */
bool talk_value_as_dec(const talk_value *v, const talk_decimal **out);
/* The unit buffer is owned, the Decimal is borrowed. Word units are singular. */
talk_host_error_code talk_value_as_quantity(const talk_value *v, const talk_decimal **n, talk_owned_bytes *unit);
bool talk_value_as_civil_date(const talk_value *v, talk_date_fields *out);
bool talk_value_as_instant(const talk_value *v, int64_t *seconds, int32_t *nanos);
/* Bytes are copied out, in an owned buffer. */
talk_host_error_code talk_value_as_bytes(const talk_value *v, talk_owned_bytes *out);
/* Range ends and indexed/map values return owned references. */
bool talk_value_as_range(const talk_value *v, talk_value **from, talk_value **to);
size_t talk_value_len(const talk_value *v);
/* 1-based; out-of-range indexes and absent keys give Nothing. */
talk_host_error_code talk_value_index(const talk_value *v, size_t index, talk_value **out);
talk_host_error_code talk_value_get(const talk_value *v, const char *key, size_t len, talk_value **out);
/* 0-based insertion-order iteration. False at the end or for another kind.
 * The key borrows v; the value is an owned reference. */
bool talk_value_entries(const talk_value *v, size_t index, talk_pair *out);
bool talk_value_pattern_source(const talk_value *v, const char **s, size_t *len);
bool talk_value_home_script(const talk_value *v, const char **s, size_t *len);
/* The chapter 11 display form, in an owned buffer. */
talk_host_error_code talk_value_string(const talk_value *v, talk_owned_bytes *out);
talk_host_error_code talk_value_equal(const talk_value *v, const talk_value *w, bool *out);
talk_host_error_code talk_decimal_string(const talk_decimal *n, talk_owned_bytes *out);
/* Refused with TALK_INVALID_VALUE unless the Decimal is an integer in range. */
talk_host_error_code talk_decimal_int64(const talk_decimal *n, int64_t *out);
talk_host_error_code talk_decimal_uint64(const talk_decimal *n, uint64_t *out);
double talk_decimal_float64_lossy(const talk_decimal *n);
/* The chapter 9 Value Encoding, in an owned buffer. A Function at any depth
 * is refused with TALK_INVALID_VALUE. */
talk_host_error_code talk_encode_value(const talk_value *v, talk_owned_bytes *out);
/* C only: returns a borrowed, existing object or NULL. Decode retains it. */
typedef talk_value *(*talk_resolve_object)(void *context, const char *kind, size_t kind_len, const char *id, size_t id_len);
/* Reads the Value Encoding. Any number, tag or payload the encoder would not
 * write is refused with TALK_INVALID_VALUE; JSON white space and string
 * escapes are syntax, and text is normalised to NFC as talk_text does.
 * Nesting beyond 128 levels is refused, and an $object is refused unless
 * resolve returns the object it names. */
talk_host_error_code talk_decode_value(const unsigned char *s, size_t len, talk_resolve_object resolve, void *context, talk_value **out);
/* C only: reads the chapter 11 display form, including NFC normalization.
 * Host objects and functions require a Group reader. Patterns are reparsed. */
talk_host_error_code talk_parse_display(const char *s, size_t len, talk_value **out);
/* C only: acquires another reference to v. */
void talk_value_retain(talk_value *v);
/* C only: ends the caller's reference to v. NULL is ignored. */
void talk_value_release(talk_value *v);
/* C only: frees an owned buffer and clears its fields. */
void talk_owned_bytes_release(talk_owned_bytes *b);

/* Shapes (chapter 9). A constructor's Shape is owned by the caller; a
 * function that takes Shapes retains what it keeps. */
typedef struct talk_shape talk_shape;

/* The kind Shapes, which live as long as the process. */
const talk_shape *talk_any_shape(void);
const talk_shape *talk_value_shape(void);
const talk_shape *talk_nothing_shape(void);
const talk_shape *talk_bool_shape(void);
const talk_shape *talk_number_shape(void);
const talk_shape *talk_text_shape(void);
const talk_shape *talk_bytes_shape(void);
const talk_shape *talk_instant_shape(void);
const talk_shape *talk_range_shape(void);
const talk_shape *talk_civil_date_shape(void);
const talk_shape *talk_pattern_shape(void);
const talk_shape *talk_function_shape(void);

typedef struct talk_field {
    const char *key;
    size_t key_len;
    const talk_shape *shape;
    bool optional;
} talk_field;

talk_host_error_code talk_quantity_of(const char *unit, size_t len, talk_shape **out);
talk_host_error_code talk_quantity_kind(const char *kind, size_t len, talk_shape **out);
talk_host_error_code talk_list_of(const talk_shape *s, talk_shape **out);
talk_host_error_code talk_map_shape(const talk_field *fields, size_t len, talk_shape **out);
talk_host_error_code talk_open_map(const talk_field *fields, size_t len, talk_shape **out);
talk_host_error_code talk_one_of(const talk_shape *const *shapes, size_t len, talk_shape **out);
talk_host_error_code talk_optional(const talk_shape *s, talk_shape **out);
/* C only: ends the caller's reference to a Shape. */
void talk_shape_release(const talk_shape *s);

/* Capabilities and Operations (chapter 9). */
typedef enum talk_mode {
    TALK_IMMEDIATE,
    TALK_SUSPENDING,
    TALK_FIRE_AND_FORGET
} talk_mode;

typedef struct talk_cost {
    int64_t fuel;
    int64_t alloc;
} talk_cost;

typedef struct talk_error_decl {
    const char *code;
    size_t code_len;
    const talk_field *fields;
    size_t fields_len;
} talk_error_decl;

/* What an Operation's Host function receives. It lives until the function
 * returns. */
typedef struct talk_call talk_call;

/* A Script error an Operation fails with. The Core takes data, a map or
 * Nothing, or NULL for none. */
typedef struct talk_script_error {
    const char *code;
    size_t code_len;
    const char *message; /* NULL: no message */
    size_t message_len;
    talk_value *data;
} talk_script_error;

/* C only: how a Host function ended, which talk.go gives as its result and
 * error. */
typedef enum talk_call_end {
    /* C only: *result holds the result, owned by the Core. */
    TALK_CALL_ANSWERED,
    /* C only: *error holds a Script error. */
    TALK_CALL_FAILED,
    /* C only: a Charge was refused, so the work wasn't done. */
    TALK_CALL_LIMITED,
    /* C only: any other failure, which the Script sees as host error. */
    TALK_CALL_BROKEN,
    /* C only: a suspending call started; answer it later through the call. */
    TALK_CALL_STARTED
} talk_call_end;

/* C only: an immediate Operation's Do, a suspending one's Start, or a
 * fire-and-forget one's Fire. The arguments are borrowed. Start returns
 * TALK_CALL_STARTED, or fails as Do does. */
typedef talk_call_end (*talk_operation_fn)(void *context, talk_call *call, talk_value *const *args, size_t args_len, talk_value **result, talk_script_error *error);

typedef struct talk_operation {
    const char *name;
    size_t name_len;
    const talk_shape *const *args; /* an Optional suffix may be left off */
    size_t args_len;
    const talk_shape *result; /* NULL: none to check, as for fire-and-forget */
    talk_cost cost;
    talk_mode mode;
    int64_t max_pending_ms; /* suspending only; 0: the Script's MaxWait */
    const talk_error_decl *errors;
    size_t errors_len;
    talk_operation_fn fn;
    void *context;
} talk_operation;

/* A Capability's definition, owned by its Core. */
typedef struct talk_capability_def talk_capability_def;
/* A reusable Grant, owned by its Core. */
typedef struct talk_grant talk_grant;

void talk_capability_def_name(const talk_capability_def *d, const char **s, size_t *len);
/* Grants the named Operations, refusing an unknown one. binding is the
 * Host's own, which each Call gives back. */
talk_host_error_code talk_capability_def_grant(talk_capability_def *d, const char *const *ops, const size_t *lens, size_t len, void *binding, talk_grant **out);
talk_host_error_code talk_capability_def_grant_all(talk_capability_def *d, void *binding, talk_grant **out);
talk_capability_def *talk_grant_capability(const talk_grant *g);
void *talk_grant_binding(const talk_grant *g);

/* Standard Capabilities (chapter 7). Each factory takes a cost for every
 * Operation, by name, and the Host's implementation, one function per
 * Operation, which receives the resolved arguments: omitted optional ones as
 * Nothing, and a Locale's options map complete, in its documented key order.
 * The Core makes the chapter's checks before and after each call. The
 * definition lives as long as the Core. */

/* C only: one Operation's cost in a talk_costs. */
typedef struct talk_named_cost {
    const char *name;
    size_t name_len;
    talk_cost cost;
} talk_named_cost;

typedef struct talk_costs {
    const talk_named_cost *entries;
    size_t len;
} talk_costs;

/* calendar: the Grant's binding is its default IANA zone, as NUL-terminated
 * text, or NULL. Each function receives its Operation's arguments, then the
 * zone, text or Nothing; to_instant receives the civil date, the resolved
 * disambiguation and the zone. */
typedef struct talk_calendar_impl {
    void *context;
    talk_operation_fn today, now, to_civil, to_instant, offset, zone;
} talk_calendar_impl;

/* locale: the Grant's binding is its default BCP 47 tag, as NUL-terminated
 * text, or NULL for und. Each function receives its Operation's arguments,
 * then the complete options map for compare, rank, month_names and
 * day_names, then the tag, text or Nothing. */
typedef struct talk_locale_impl {
    void *context;
    talk_operation_fn compare, rank, upper, lower, number_symbols, month_names, day_names, tag;
} talk_locale_impl;

/* console: write receives the value to show. read is suspending, and
 * suspending calls aren't made yet. */
typedef struct talk_console_impl {
    void *context;
    talk_operation_fn write, read;
} talk_console_impl;

/* clock: now is answered from the Pump's Clock, so there is nothing to
 * implement. */
talk_host_error_code talk_clock_capability(talk_core *c, const talk_costs *costs, talk_capability_def **out);
talk_host_error_code talk_calendar_capability(talk_core *c, const talk_calendar_impl *impl, const talk_costs *costs, talk_capability_def **out);
talk_host_error_code talk_locale_capability(talk_core *c, const talk_locale_impl *impl, const talk_costs *costs, talk_capability_def **out);
talk_host_error_code talk_console_capability(talk_core *c, const talk_console_impl *impl, const talk_costs *costs, talk_capability_def **out);

/* The call's id, such as "pricing/r1.c1", borrowed from the call. */
void talk_call_id(const talk_call *c, const char **s, size_t *len);
void talk_call_script_name(const talk_call *c, const char **s, size_t *len);
void talk_call_grant_name(const talk_call *c, const char **s, size_t *len);
void *talk_call_binding(const talk_call *c);
/* The Pump's Clock reading. */
void talk_call_now(const talk_call *c, int64_t *seconds, int32_t *nanos);
/* Answer, AnswerWithCost and Fail settle a suspending call. Its talk_call
 * stays valid until its Group is released. Each queues a Host Input, which
 * the next Pump drains; one for a call that no longer waits is recorded and
 * ignored. The Core retains v and the error's data. A NULL error is a
 * failure that isn't a Script error. */
talk_host_error_code talk_call_answer(talk_call *c, talk_value *v);
talk_host_error_code talk_call_answer_with_cost(talk_call *c, talk_value *v, int64_t fuel);
talk_host_error_code talk_call_fail(talk_call *c, const talk_script_error *e);
/* Draws Fuel before the work. TALK_ERR_LIMIT when the Run can't cover it:
 * the function then returns TALK_CALL_LIMITED without doing the work. */
talk_host_error_code talk_call_charge(talk_call *c, int64_t fuel);

/* Groups (chapter 9). Worker calls come from the thread that pumps the Group.
 * A string a call takes is borrowed for the duration of the call. */

/* Receives the Trace one canonical line at a time, without its LF. The line
 * lives until the callback returns. */
typedef void (*talk_trace_sink)(void *context, const char *line, size_t len);

typedef struct talk_group_options {
    const char *name;
    size_t name_len;
    talk_trace_sink trace; /* NULL: no Trace is recorded */
    void *trace_context;
} talk_group_options;

/* C only: a Grant bound by the name the Script uses. */
typedef struct talk_load_grant {
    const char *name;
    size_t name_len;
    talk_grant *grant;
} talk_load_grant;

typedef struct talk_load_options {
    const char *name;
    size_t name_len;
    const char *source;
    size_t source_len;
    const talk_load_grant *grants;
    size_t grants_len;
    bool grants_as_used;
} talk_load_options;

typedef struct talk_message {
    const char *name;
    size_t name_len;
    talk_value *const *args; /* borrowed; the Core retains what it keeps */
    size_t args_len;
} talk_message;

/* A Request's result, settled by a Pump. */
typedef struct talk_pending talk_pending;

typedef enum talk_group_state {
    TALK_IDLE,
    TALK_SLICED,
    TALK_STOPPED,
    TALK_REWOUND
} talk_group_state;

typedef struct talk_pump_options {
    int64_t fuel_slice; /* 0: no slicing */
    int64_t fuel_cap;   /* 0: no cap */
} talk_pump_options;

typedef struct talk_pump_result {
    talk_group_state state;
    int64_t fuel_used;
} talk_pump_result;

/* Makes a Core. NULL when it can't allocate. */
talk_core *talk_new(void);
/* C only: ends the Core. Its Groups must be released first. */
void talk_core_release(talk_core *c);
talk_host_error_code talk_new_group(talk_core *c, const talk_group_options *o, talk_group **out);
/* Defines a Capability, once per process: its Operations, which the Core
 * orders by name. The definition lives as long as the Core. */
talk_host_error_code talk_define_capability(talk_core *c, const char *name, size_t len, const talk_operation *ops, size_t ops_len, talk_capability_def **out);
/* C only: ends the Group and every handle it gave out. */
void talk_group_release(talk_group *g);
/* Loads a Script. A refusal with diagnostics is TALK_LOAD_REFUSED. The Script
 * handle lives as long as its Group. */
talk_host_error_code talk_load(talk_group *g, const talk_load_options *o, talk_script **out);
/* Queues a Delivery to the Script. id, if not NULL, receives its delivery
 * id, such as "d1", owned by the caller. */
talk_host_error_code talk_script_deliver(talk_script *s, const talk_message *m, talk_owned_bytes *id);
/* Queues a Request; *out settles when a Pump ends its Run. */
talk_host_error_code talk_script_request(talk_script *s, const talk_message *m, talk_owned_bytes *id, talk_pending **out);
/* A Script's Counters: its lifetime work since load, live Runs included,
 * and its current Persistent State and mailbox. */
typedef struct talk_counters {
    int64_t fuel_total;
    int64_t alloc_total;
    int64_t runs;
    int64_t faults;
    int64_t persistent_state;
    int64_t mailbox_len;
} talk_counters;
/* Reads the Script's Counters between Pumps, as the Host Input counters
 * does: it charges nothing, drains no Host Inputs and writes a counters
 * record to the Trace. */
void talk_script_counters(talk_script *s, talk_counters *out);
/* The Request's result, an owned reference: Nothing until it settles. */
talk_host_error_code talk_pending_result(const talk_pending *p, talk_value **out);
/* C only: ends the caller's handle on a Request. */
void talk_pending_release(talk_pending *p);
/* Runs a Pump with one Clock reading. o may be NULL. */
talk_host_error_code talk_pump(talk_group *g, int64_t seconds, int32_t nanos, const talk_pump_options *o, talk_pump_result *out);
/* Inspects the Group. In step 1 it writes a vars record for each Script to
 * the Trace, as the Host Input vars does. */
void talk_inspect(talk_group *g);

#ifdef __cplusplus
}
#endif

#endif /* TALK_H */
