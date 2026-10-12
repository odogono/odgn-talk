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

typedef struct talk_load_options {
    const char *name;
    size_t name_len;
    const char *source;
    size_t source_len;
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
