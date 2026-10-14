import { expect, test } from 'bun:test';
import { compareAPI, goNames, headerNames } from './api';

const go = `package northtalk
type Value struct { /* opaque */
}
type Kind int
const (
\tKindNothing Kind = iota
\tKindText
)
var ErrLimit error
var Nothing Value
func Text(s string) (Value, error)
func (v Value) AsText() (string, bool)
func (v Value) private() bool
type Script struct{}
func (s *Script) Deliver(m Message) (DeliveryID, error)
type Group struct{}
func (g *Group) Deliver(to *Object, m Message) (DeliveryID, error)
func (g *Group) Script(name string) *Script
func (c *Core) NewGroup(name string) *Group
type CalendarImpl interface {
\tToday(c *Call, zone string) (Value, error)
}
`;

test('talk.go names take their C spellings', () => {
  expect([...goNames(go)].sort()).toEqual(
    [
      ['TALK_ERR_LIMIT', 'ErrLimit'],
      ['TALK_KIND_NOTHING', 'KindNothing'],
      ['TALK_KIND_TEXT', 'KindText'],
      ['talk_calendar_impl', 'CalendarImpl'],
      ['talk_deliver', 'Group.Deliver'],
      ['talk_group', 'Group'],
      ['talk_group_script', 'Group.Script'],
      ['talk_kind', 'Kind'],
      ['talk_new_group', 'Core.NewGroup'],
      ['talk_nothing', 'Nothing'],
      ['talk_script', 'Script'],
      ['talk_script_deliver', 'Script.Deliver'],
      ['talk_text', 'Text'],
      ['talk_value', 'Value'],
      ['talk_value_as_text', 'Value.AsText'],
    ].sort(),
  );
});

const header = `#ifndef TALK_H
#define TALK_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Opaque. */
typedef struct talk_value talk_value;
typedef enum talk_kind {
    /* C only: a test. */
    TALK_KIND_EXTRA = -1,
    TALK_KIND_NOTHING,
    TALK_KIND_TEXT
} talk_kind;
typedef void (*talk_today)(void *context);
int talk_text(const char *s, size_t len, talk_value **out);
/* C only: ends a reference. */
void talk_value_release(talk_value *v);
#ifdef __cplusplus
}
#endif
#endif
`;

test('talk.h declarations are found, with their C only marks', () => {
  expect(Object.fromEntries(headerNames(header))).toEqual({
    TALK_KIND_EXTRA: true,
    TALK_KIND_NOTHING: false,
    TALK_KIND_TEXT: false,
    talk_kind: false,
    talk_text: false,
    talk_today: false,
    talk_value: false,
    talk_value_release: true,
  });
});

test('a name talk.go lacks and a talk.go name talk.h lacks are each reported', () => {
  const { failures, missing } = compareAPI(go, header);
  expect(failures).toEqual([
    'talk_today matches no talk.go declaration; mark it C only or rename it',
  ]);
  expect(missing).toContain('talk_new_group (Core.NewGroup)');
  expect(missing).not.toContain('talk_text (Text)');
  expect(
    compareAPI(go, '/* C only: wrong. */\nvoid talk_text(void);').failures,
  ).toEqual(['talk_text is marked C only, but talk.go declares Text']);
});
