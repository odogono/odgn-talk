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
 * The Core declares names here as it implements them. Step 1.1 covers text.
 */
#ifndef TALK_H
#define TALK_H

#include <stdbool.h>
#include <stddef.h>

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

/* Builds text from len bytes of UTF-8 at s, normalised to NFC, uncharged.
 * Invalid UTF-8 is refused with TALK_INVALID_VALUE. */
talk_host_error_code talk_text(const char *s, size_t len, talk_value **out);

talk_kind talk_value_kind(const talk_value *v);

/* Sets *s and *len to the text's UTF-8, always NFC, and returns true, or
 * returns false for any other kind. */
bool talk_value_as_text(const talk_value *v, const char **s, size_t *len);

/* C only: ends the caller's reference to v. NULL is ignored. */
void talk_value_release(talk_value *v);

#ifdef __cplusplus
}
#endif

#endif /* TALK_H */
