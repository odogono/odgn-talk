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
 * Values and their display/encoding are implemented, and Group execution so
 * far: a Core, Groups, Capabilities and Grants, Host Objects, loading a
 * Script without Libraries, Deliveries and Requests to a Script or an
 * object, Pumps, counters and inspection.
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
     * panicking. Nothing the call would have built exists, unless a Group's
     * allocator refused partway: that Group then takes no more work, and
     * answers every call but talk_group_memory, talk_inspect and
     * talk_group_release with this code. */
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
/* C only: memory in the Core's address space, aligned to 16, for a Host in
 * another, such as a WASM runtime, to pass structs and text through; NULL
 * when it can't allocate. talk_free takes back the same size. */
void *talk_alloc(size_t size);
/* C only: takes back talk_alloc's memory. */
void talk_free(void *p, size_t size);

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

/* A lifecycle Operation's Capability Scope (embedding/scoped-effects.md):
 * an opener sets opens and abandon, a closer sets closes, and the other
 * names are NULL. Names are nonempty identifier words. The abandonment
 * Operation is one of the same Capability's, closes the same scope, takes no
 * arguments and returns Nothing. */
typedef struct talk_scope_decl {
    const char *opens;
    size_t opens_len;
    const char *abandon;
    size_t abandon_len;
    const char *closes;
    size_t closes_len;
} talk_scope_decl;

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
    const talk_scope_decl *scope; /* NULL: none; immediate only */
    /* Immediate only, and only through talk_define_segment_capability or
     * talk_define_coordinated_capability, which supply Segment
     * Coordinators. */
    bool segment_bound;
} talk_operation;

/* A Segment Coordinator's hooks report one of these
 * (embedding/scoped-effects.md). failed is a definite outcome: no
 * acquisition for begin, no commit for commit, an unsuccessful rollback for
 * rollback. unknown is a Host contract failure. */
typedef enum talk_effect_status {
    TALK_EFFECT_OK,
    TALK_EFFECT_FAILED,
    TALK_EFFECT_UNKNOWN
} talk_effect_status;

typedef struct talk_effect_result {
    talk_effect_status status;
    const char *detail; /* Host-only, outside parity; may be NULL */
    size_t detail_len;
} talk_effect_result;

/* A Grant enrolled in a Segment's participant. */
typedef struct talk_segment_grant {
    const char *grant_name;
    size_t grant_name_len;
    void *binding;
} talk_segment_grant;

/* What a hook is told, borrowed for the call: whose Segment it is, the last
 * Clock reading, the first enrolled Grant, and every enrolled Grant in
 * enrollment order, of which begin sees only the first. */
typedef struct talk_segment_context {
    talk_group *group;
    const char *script_name;
    size_t script_name_len;
    const char *run_id;
    size_t run_id_len;
    const char *grant_name;
    size_t grant_name_len;
    const char *segment_id;
    size_t segment_id_len;
    void *binding;
    int64_t now_seconds;
    int32_t now_nanos;
    const talk_segment_grant *grants;
    size_t grants_len;
} talk_segment_context;

/* C only: a synchronous lifecycle hook. It may not make worker calls. */
typedef talk_effect_result (*talk_segment_hook)(void *context, const talk_segment_context *s);

/* A Segment Coordinator: its three hooks and their context. The Core
 * compares coordinators by the address of this struct, which must outlive
 * every Grant mapped to it. */
typedef struct talk_segment_lifecycle {
    talk_segment_hook begin;
    talk_segment_hook commit;
    talk_segment_hook rollback;
    void *context;
} talk_segment_lifecycle;

/* C only: maps a new Grant's binding to its Segment Coordinator, once, when
 * the Grant is made. NULL refuses the Grant. */
typedef const talk_segment_lifecycle *(*talk_coordinator_fn)(void *context, void *binding);

/* A Capability's definition, owned by its Core. */
typedef struct talk_capability_def talk_capability_def;
/* A reusable Grant, owned by its Core. */
typedef struct talk_grant talk_grant;

void talk_capability_def_name(const talk_capability_def *d, const char **s, size_t *len);
/* Grants the named Operations, refusing an unknown one, or an opener of a
 * Capability Scope without its abandonment Operation. binding is the Host's
 * own, which each Call gives back. */
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

/* C only: a SQL value's storage class. */
typedef enum talk_sql_kind {
    /* C only: NULL. */
    TALK_SQL_NULL,
    /* C only: INTEGER, in integer. */
    TALK_SQL_INTEGER,
    /* C only: REAL, in real. */
    TALK_SQL_REAL,
    /* C only: TEXT, as UTF-8 in bytes. */
    TALK_SQL_TEXT,
    /* C only: BLOB, in bytes. */
    TALK_SQL_BLOB
} talk_sql_kind;

/* A SQL value: NULL, an INTEGER, a REAL, or TEXT or a BLOB of len bytes. */
typedef struct talk_sql_value {
    talk_sql_kind kind;
    int64_t integer;
    double real;
    const char *bytes;
    size_t len;
} talk_sql_value;

/* A call's parameters, borrowed for the call: a list bound to ? and ?NNN,
 * or when named, values bound to :name by names, written without the
 * colon. */
typedef struct talk_sql_params {
    bool named;
    const talk_sql_value *values;
    const char *const *names;
    const size_t *name_lens;
    size_t len;
} talk_sql_params;

/* A result the implementation fills: its column names, and rows_len rows of
 * columns_len values, row by row. changes is change's only. It stays valid
 * until release_rows, or until the implementation's next call. */
typedef struct talk_sql_rows {
    const char *const *columns;
    const size_t *column_lens;
    size_t columns_len;
    const talk_sql_value *values;
    size_t rows_len;
    int64_t changes;
} talk_sql_rows;

/* A sqlite Grant's binding, which the Grant borrows for its life: the
 * Host's database, the tables it may use when has_tables, and its row cap,
 * from 0 to 9007199254740991. */
typedef struct talk_sqlite_binding {
    const char *database;
    size_t database_len;
    const char *const *tables;
    const size_t *table_lens;
    size_t tables_len;
    bool has_tables;
    int64_t max_rows;
} talk_sqlite_binding;

/* C only: query or change. The Core has checked the Shapes and max,
 * converted params and charged max times the per-row cost. Fill rows, or
 * fail with a Script error: sql {reason}, constraint {kind}, sqlite busy,
 * not read-only or too many rows {max}. */
typedef talk_call_end (*talk_sql_fn)(void *context, talk_call *call, const char *sql, size_t sql_len, const talk_sql_params *params, int64_t max, talk_sql_rows *rows, talk_script_error *error);

/* sqlite's implementation. coordinator maps a database to its Segment
 * Coordinator, the same one for the same database; begin, commit and
 * rollback open, release and roll back a savepoint; release_rows, if not
 * NULL, ends a result once the Core has converted it. */
typedef struct talk_sqlite_impl {
    void *context;
    const talk_segment_lifecycle *(*coordinator)(void *context, const char *database, size_t len);
    talk_sql_fn query, change;
    talk_operation_fn begin, commit, rollback;
    void (*release_rows)(void *context, talk_sql_rows *rows);
} talk_sqlite_impl;

/* store's implementation: a function for each Operation, and the Segment
 * Coordinator every Store maps to. */
typedef struct talk_store_impl {
    void *context;
    talk_operation_fn get, set, del, keys, increment, swap, watch, unwatch;
    talk_segment_lifecycle coordinator;
} talk_store_impl;

/* timer: both Operations are fire-and-forget. schedule receives the name,
 * the Instant, the message name and the list of arguments; cancel the name.
 * The Host stores timers durably, by Script and name, and when one is due
 * delivers it as an ordinary Delivery. */
typedef struct talk_timer_impl {
    void *context;
    talk_operation_fn schedule, cancel;
} talk_timer_impl;

/* user: confirm receives the message; choose the items, the prompt and
 * multiple; enter the message and the default; notify the message and the
 * title. An omitted prompt, default or title is "", and an omitted multiple
 * false. confirm, choose and enter are suspending, and the Core checks each
 * answer; notify is fire-and-forget. Fail with user busy while the Script
 * has another prompt unanswered. */
typedef struct talk_user_impl {
    void *context;
    talk_operation_fn confirm, choose, enter, notify;
} talk_user_impl;

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
talk_host_error_code talk_timer_capability(talk_core *c, const talk_timer_impl *impl, const talk_costs *costs, talk_capability_def **out);
talk_host_error_code talk_console_capability(talk_core *c, const talk_console_impl *impl, const talk_costs *costs, talk_capability_def **out);
/* store: the Grant's binding is the Store's name, as NUL-terminated text.
 * The Core has checked the Shapes, refused an empty key with invalid key and
 * an invalid watch with invalid watch. Each function receives its
 * Operation's arguments with the defaults resolved: get and increment
 * Nothing for an omitted default or by, keys empty text for an omitted
 * prefix, and watch the effective message, storeChanged when omitted or
 * Nothing. set, del, increment and swap are Segment-bound, and every binding
 * maps to coordinator, which the Core copies. Fail with can't store {kind},
 * store full {limit} or store busy {key}, and from increment with the error
 * + would raise (chapter 7). */
talk_host_error_code talk_store_capability(talk_core *c, const talk_store_impl *impl, const talk_costs *costs, talk_capability_def **out);
/* sqlite is optional (chapter 7). per_row is whole Fuel charged per row of
 * max, from 0 to 9007199254740991. Each Grant's binding is a
 * talk_sqlite_binding; a malformed one refuses the Grant. The Core converts
 * values and rows by chapter 7's rules, raising sql for a column named twice
 * and unrepresentable for a value it can't hold. */
talk_host_error_code talk_sqlite_capability(talk_core *c, const talk_sqlite_impl *impl, const talk_costs *costs, int64_t per_row, talk_capability_def **out);
/* user is optional (chapter 7), and has no binding. The Core refuses an
 * empty items with out of domain before calling choose. */
talk_host_error_code talk_user_capability(talk_core *c, const talk_user_impl *impl, const talk_costs *costs, talk_capability_def **out);

/* The call's id, such as "pricing/r1.c1", borrowed from the call. */
void talk_call_id(const talk_call *c, const char **s, size_t *len);
void talk_call_script_name(const talk_call *c, const char **s, size_t *len);
void talk_call_grant_name(const talk_call *c, const char **s, size_t *len);
void *talk_call_binding(const talk_call *c);
/* The Pump's Clock reading. */
void talk_call_now(const talk_call *c, int64_t *seconds, int32_t *nanos);
/* The Run's id, such as "pricing/r1", and its current Segment's, such as
 * "pricing/r1.s1", which together with the Grant name own a Capability
 * Scope. */
void talk_call_run_id(const talk_call *c, const char **s, size_t *len);
void talk_call_segment_id(const talk_call *c, const char **s, size_t *len);
/* The scope a lifecycle Operation opens or closes; empty for one without
 * scope metadata. */
void talk_call_scope_name(const talk_call *c, const char **s, size_t *len);
/* True only when the Core abandons a scope its Run left open. Such a call
 * may not charge, and only a normal return counts as success. */
bool talk_call_automatic(const talk_call *c);
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

/* C only: an allocator the Host supplies for a Group. alloc returns memory
 * aligned to alignment, or NULL to refuse; free gets back the same size and
 * alignment. */
typedef struct talk_allocator {
    void *context;
    void *(*alloc)(void *context, size_t size, size_t alignment);
    void (*free)(void *context, void *ptr, size_t size, size_t alignment);
} talk_allocator;

typedef struct talk_group_options {
    const char *name;
    size_t name_len;
    talk_trace_sink trace; /* NULL: no Trace is recorded */
    void *trace_context;
    /* C only: what the Group allocates from; NULL, the Core's allocator. */
    const talk_allocator *allocator;
    /* C only: the most bytes the Group may hold, a physical cap above the
     * logical budgets, so a Core defect becomes TALK_OUT_OF_MEMORY rather
     * than a crash; 0, 256 MiB. */
    size_t memory_cap;
} talk_group_options;

/* C only: what a Group's allocator holds now, the most it has held, its
 * cap, and whether it has refused an allocation. */
typedef struct talk_memory {
    size_t used;
    size_t peak;
    size_t cap;
    bool refused;
} talk_memory;

/* Host Objects (ADRs 0012, 0016). A property's Get and Set run inside the
 * Run, like an immediate Operation, and are charged the same way. Get
 * answers with TALK_CALL_ANSWERED and *result, an owned reference; Set with
 * TALK_CALL_ANSWERED. TALK_CALL_FAILED or TALK_CALL_BROKEN is host error.
 * A NULL set makes the property read-only. */
typedef struct talk_object talk_object;
typedef struct talk_object_kind talk_object_kind;
/* C only: Prop.Get. */
typedef talk_call_end (*talk_prop_get_fn)(void *context, talk_object *o, talk_value **result, talk_script_error *error);
/* C only: Prop.Set. */
typedef talk_call_end (*talk_prop_set_fn)(void *context, talk_object *o, const talk_value *v, talk_script_error *error);
typedef struct talk_prop {
    const char *name;
    size_t name_len;
    const talk_shape *shape;
    talk_prop_get_fn get;
    talk_prop_set_fn set; /* NULL: read-only */
    void *context;
    talk_cost get_cost;
    talk_cost set_cost;
} talk_prop;
typedef struct talk_object_kind_def {
    const char *name;
    size_t name_len;
    const talk_prop *props;
    size_t props_len;
    /* For the Host Manifest only; talk_set_parent doesn't check it. */
    const char *const *parent_kinds;
    const size_t *parent_kinds_lens;
    size_t parent_kinds_len;
} talk_object_kind_def;
/* Defines an Object Kind, once per process. It lives as long as the Core. */
talk_host_error_code talk_define_object_kind(talk_core *c, const talk_object_kind_def *k, talk_object_kind **out);

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
    talk_object *owner; /* NULL: the Script owns no object */
    const struct talk_load_object *objects;
    size_t objects_len;
} talk_load_options;

/* C only: a well-known object bound to a name at load. */
typedef struct talk_load_object {
    const char *name;
    size_t name_len;
    talk_object *object;
} talk_load_object;

typedef struct talk_message {
    const char *name;
    size_t name_len;
    talk_value *const *args; /* borrowed; the Core retains what it keeps */
    size_t args_len;
} talk_message;

/* A Request's result, settled by a Pump. */
typedef struct talk_pending talk_pending;

/* A Decision's Verdict (chapter 9, Decisions). */
typedef enum talk_verdict {
    TALK_ALLOWED,
    TALK_VETOED,   /* some Run reached `veto` */
    TALK_UNDECIDED /* a deciding Run failed, was cancelled, dropped or stopped before sealing; the Host chooses */
} talk_verdict;

/* How a Run ended. */
typedef enum talk_outcome {
    TALK_COMPLETED,
    TALK_ERRORED,
    TALK_LIMIT_FAULT,
    TALK_CANCELLED,
    TALK_UNHANDLED_OUTCOME,
    TALK_DROPPED,
    TALK_EFFECT_FAILURE_OUTCOME
} talk_outcome;

typedef struct talk_veto {
    const char *script;
    size_t script_len;
    const char *run;
    size_t run_len;
    talk_value *reason; /* borrowed; Nothing for a bare `veto` */
} talk_veto;

typedef struct talk_undecided_by {
    const char *script;
    size_t script_len;
    const char *run; /* empty for a Delivery that never started */
    size_t run_len;
    talk_outcome outcome;
} talk_undecided_by;

/* A Decision's sealed Verdict, with its vetoes and undecided recipients in
 * recipient order. */
typedef struct talk_decided {
    const char *delivery; /* empty for a Broadcast Decision */
    size_t delivery_len;
    const char *broadcast; /* empty unless it was a Broadcast Decision */
    size_t broadcast_len;
    talk_verdict verdict;
    const talk_veto *vetoes;
    size_t vetoes_len;
    const talk_undecided_by *undecided;
    size_t undecided_len;
} talk_decided;

/* A Decision's future, settled when a Pump seals its Verdict, often before
 * the deciding Run ends. It lives as long as its Group. */
typedef struct talk_deciding talk_deciding;

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
/* C only: the Group's physical memory. */
void talk_group_memory(const talk_group *g, talk_memory *out);
/* Defines a Capability, once per process: its Operations, which the Core
 * orders by name. The definition lives as long as the Core. */
talk_host_error_code talk_define_capability(talk_core *c, const char *name, size_t len, const talk_operation *ops, size_t ops_len, talk_capability_def **out);
/* talk_define_capability with Segment-bound Operations. The first makes each
 * Grant its own Segment Coordinator, with lifecycle's hooks, which must
 * outlive the Core. The second maps each Grant's binding to one, so Grants
 * mapped to the same coordinator share a Segment's participant. */
talk_host_error_code talk_define_segment_capability(talk_core *c, const char *name, size_t len, const talk_operation *ops, size_t ops_len, const talk_segment_lifecycle *lifecycle, talk_capability_def **out);
talk_host_error_code talk_define_coordinated_capability(talk_core *c, const char *name, size_t len, const talk_operation *ops, size_t ops_len, talk_coordinator_fn coordinator, void *context, talk_capability_def **out);
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
/* Queues a Decision to the Script; *out settles when a Pump seals it. */
talk_host_error_code talk_script_decide(talk_script *s, const talk_message *m, talk_owned_bytes *id, talk_deciding **out);
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
bool talk_deciding_done(const talk_deciding *d);
/* The Verdict, borrowed from the Group, or NULL until a Pump seals it. */
const talk_decided *talk_deciding_decided(talk_deciding *d);
/* Runs a Pump with one Clock reading. o may be NULL. */
talk_host_error_code talk_pump(talk_group *g, int64_t seconds, int32_t nanos, const talk_pump_options *o, talk_pump_result *out);
/* Makes the Group's handle for a Host-owned thing, the first time it
 * crosses into the Group. A reused id within the kind is
 * TALK_DUPLICATE_OBJECT_ID. The handle lives as long as the Group. */
talk_host_error_code talk_group_object(talk_group *g, const talk_object_kind *kind, const char *id, size_t id_len, void *native, talk_object **out);
/* The handle with this Object Kind name and id, disposed or not; false if
 * the Group never made one. */
bool talk_object_by_id(talk_group *g, const char *kind, size_t kind_len, const char *id, size_t id_len, talk_object **out);
void talk_object_id(const talk_object *o, const char **s, size_t *len);
void *talk_object_native(const talk_object *o);
/* The object as a Script value, an owned reference. */
talk_host_error_code talk_object_value(const talk_object *o, talk_value **out);
/* The handle an object value is. Unlike talk.go's, it takes the Group,
 * since a value doesn't hold one. */
bool talk_value_as_object(talk_group *g, const talk_value *v, talk_object **out);
/* SetParent and Dispose are queued as Host Inputs. A cycle is
 * TALK_PARENT_CYCLE, and a disposed child TALK_INVALID_VALUE, at the call;
 * a parent of NULL ends the chain. */
talk_host_error_code talk_set_parent(talk_group *g, talk_object *o, talk_object *parent);
talk_host_error_code talk_dispose(talk_group *g, talk_object *o);
/* A Delivery or Request to a Host Object: it goes to the object's Owning
 * Script, or its nearest ancestor's, when the queue is drained. */
talk_host_error_code talk_deliver(talk_group *g, talk_object *to, const talk_message *m, talk_owned_bytes *id);
talk_host_error_code talk_request(talk_group *g, talk_object *to, const talk_message *m, talk_owned_bytes *id, talk_pending **out);
/* A Decision to a Host Object: it routes like talk_deliver, and the first
 * `, deciding` clause it reaches holds its Verdict until the end of that
 * Run's first Segment. */
talk_host_error_code talk_decide(talk_group *g, talk_object *to, const talk_message *m, talk_owned_bytes *id, talk_deciding **out);
/* A Broadcast reaches only the Scripts that want the message when the queue
 * is drained: those with a Handler for it, or a `wait for` pending on it.
 * Each recipient gets its own delivery id under the broadcast id, such as
 * "b1", which id receives. A Broadcast never climbs and never reaches a
 * Fallback. */
talk_host_error_code talk_broadcast(talk_group *g, const talk_message *m, talk_owned_bytes *id);
/* A Broadcast Decision: *out settles once every recipient has sealed, and
 * at once when there are none. */
talk_host_error_code talk_decide_broadcast(talk_group *g, const talk_message *m, talk_owned_bytes *id, talk_deciding **out);

/* Libraries (ADR 0020). A Library is compiled once per process and lives
 * as long as the Core. The stdlib Libraries are always there. */
typedef struct talk_library talk_library;
typedef struct talk_library_source {
    const char *name;
    size_t name_len;
    const char *version; /* the Host's own label */
    size_t version_len;
    const char *source;
    size_t source_len;
} talk_library_source;
/* Compiles a Library. imports must hold every Library its `use` lines name,
 * besides the stdlib's. declarations are talk.go's GrantDecls: Grants by the
 * names the source uses, whose Operations' modes and Shapes its Capability
 * calls are checked and lowered against; NULL gives none, enough only for a
 * Library that makes no direct Capability call. A source that fails to
 * parse or check is TALK_LOAD_REFUSED. */
talk_host_error_code talk_compile_library(talk_core *c, const talk_library_source *src, talk_library *const *imports, size_t imports_len, const talk_load_grant *declarations, size_t declarations_len, talk_library **out);
void talk_library_name(const talk_library *l, const char **s, size_t *len);
void talk_library_version(const talk_library *l, const char **s, size_t *len);
void talk_library_identity(const talk_library *l, uint8_t out[32]);
/* Adds a compiled Library to the Group, writing its add-library record. A
 * stdlib name is TALK_RESERVED_NAME, a name the Group holds
 * TALK_NAME_REUSED, and an import the Group doesn't hold with the same
 * identity TALK_LIBRARY_MISMATCH, each also a refused record. */
talk_host_error_code talk_add_library(talk_group *g, talk_library *l);

/* Inspects the Group. In step 1 it writes a vars record for each Script to
 * the Trace, as the Host Input vars does. */
void talk_inspect(talk_group *g);

#ifdef __cplusplus
}
#endif

#endif /* TALK_H */
