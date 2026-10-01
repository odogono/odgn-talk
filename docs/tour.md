# Learn NorthTalk in Y minutes

> **Status: design only.** No Core (implementation of the language) exists yet, so nothing below runs. This tour is an informative introduction. The rules are in [the spec](../spec/), and where the two disagree, the spec wins. Each section heading names the [ADRs](adr/) behind it. Capitalised terms (Script, Handler, Run, …) are defined in the glossary, [`CONTEXT.md`](../CONTEXT.md). Anything still undecided is left out.

NorthTalk is a HyperTalk-descended scripting language for untrusted end-user Scripts, run in a sandbox inside Go servers, Bun servers and browsers. It reads like English (`put word 2 of line 3 of report into w`). Values are strict, with one exact decimal number type. Each Script is an actor with its own mailbox, and every effect goes through a Capability the Host grants.

Script files end in `.talk`.

```talk
-- Comments start with two dashes and run to the end of the line.
-- There are no block comments.

-- A Script is a unit of source code, written by an end user, that a Host
-- (the application embedding the language) loads and runs. It is made of
-- top-level declarations: Script Variables, Constants, Imports, functions
-- and Handlers (`on … end` blocks that run when a message arrives).
-- Statements live inside Handlers, so every section below wraps its
-- examples in one.

-- 1. Values (ADR 0001, 0002, 0003, 0011, 0029) --------------------------------

on valuesTour
  -- One number type: an exact 34-digit decimal. No floats, NaN or Infinity.
  put 0.1 + 0.2 into x              -- 0.3, exactly
  put 2.50 * 3 into y               -- 7.50: trailing zeros are kept...
  if y = 7.5 then say "equal"       -- ...but `=` compares by value

  -- `1 / 0` is an error, not Infinity. (`say` writes to the Host's console.)
  -- Text is double-quoted, on one line. It is a sequence of Characters,
  -- each one character as a reader sees it, and compares exactly.
  put "naïve" into word1            -- 5 Characters
  -- There are no escapes: "C:\new" is exactly what it shows. Line breaks,
  -- tabs and quotes come from the Built-in Constants `newline`, `tab`, `quote`.
  put "say " & quote & "hi" & quote & newline into shout

  -- Booleans are `true` and `false`. Conditions must be booleans:
  -- `if 0 then …` and `if "yes" then …` are errors.
  -- Nothing is the one value meaning "no value here". It is not empty text,
  -- an empty list or an empty map.
  put nothing into nickname
  if nickname is nothing then say "no nickname"
  if "" is empty then say "empty, but still text"

  -- Lists and maps.
  put ["apples", "pears", "figs"] into fruit
  put {name: "Ann", age: 34} into person
  put item 2 of fruit into p        -- "pears": lists count from 1
  put the name of person into n     -- "Ann"
  put person's age into a           -- 34, the same thing written with 's
  put the "full name" of person into fn   -- a quoted key can be any text
  put [...fruit, "plums"] into more -- spread builds a new list

  -- Value Semantics: changing a value through one name is never visible
  -- through another. Only Host Objects (opaque handles to things the Host
  -- owns) have identity.
  put fruit into basket
  put "kiwis" into item 1 of basket

  -- `fruit` still starts with "apples".
end valuesTour

-- 2. Containers (ADR 0001, 0019, 0020) ----------------------------------------

-- A Script Variable is shared by all of this Script's Handlers and kept for
-- as long as the Host keeps the Script loaded. `=` means "starts as" here, and
-- only here. Everywhere else `=` is a test.
script variable visits = 0

-- A Constant is fixed when the Script loads and can never be put into. Its
-- value may use only literals, other Constants and Built-ins (the functions
-- that are always there, without an Import).
constant welcome = "Hello"

-- A Container is somewhere a value can be put: a variable, or a chunk or
-- key rooted in one. Putting into it rebinds that variable.
on containersTour person
  put 3 into count                  -- a local, made on first use
  put "tea" into drink
  put " please" after drink         -- "tea please"
  put "A cup of " before drink      -- "A cup of tea please"
  put 35 into the age of person     -- a key path is a Container too
  let total be 10                   -- `let` binds by Destructuring (matching
                                    -- a value's shape and naming its parts)...
  let [a, b, ...rest] be [10, 20, 30, 40]   -- ...a = 10, rest = [30, 40]

  -- A `let` whose shape doesn't match raises a `no match` Error.
  add 5 to total                    -- 15
  subtract 2 from count             -- 1
  multiply total by 3               -- 45
  divide total by 9                 -- 5
  add 1 to visits                   -- Script Variables work the same way
  put [1, 2] into xs
  put [3, 4] into ys
  put ys after xs                   -- [1, 2, [3, 4]]: a list is one value
  put ...ys after xs                -- [1, 2, [3, 4], 3, 4]: `...` splices
end containersTour

-- 3. Operators and conversion (ADR 0003, 0019) --------------------------------

on operatorsTour row
  put "Total: " & 42 into label     -- `&` joins text, showing any value as text
  put "007" into code

  -- `"007" + 1` is an error: values never change kind by themselves.
  put code as number + 1 into n     -- 8: convert explicitly with `as`

  -- `"lots" as number` raises {code: "can't convert", to: "number", …}.
  put 7 mod 3 into r                -- 1
  put 2 ^ 10 into big               -- 1024

  -- `as` binds tighter than every binary operator, and looser than `of`:
  put item 2 of row as number * 2 into doubled

  -- means ((item 2 of row) as number) * 2
  -- `name(` with no space is a function call. With a space, `(` groups.
  put max([3, 9, 4]) into top       -- 9
  say (1 + 2) & "!"                 -- "3!"

  -- A newline ends a statement. A line goes on while a bracket is open, or
  -- after a trailing operator, `&` or comma.
  put [1, 2,
       3] into listed
end operatorsTour

-- 4. Comparison and kinds (ADR 0003, 0011) ------------------------------------

on comparisonTour input
  -- Text compares exactly, so case matters unless you say otherwise.
  if "abc" = "ABC" then say "never"
  if "abc" is "ABC" ignoring case then say "same letters"

  -- `=` never errors: values of different kinds are simply unequal.
  if 1 = "1" then say "never"

  -- `1 < "1"`, though, is an error: `<` only orders values that compare.
  if [1, "b"] < [2, "a"] then say "lists order element by element"
  -- `is a` tests the kind a value has now. `can be a` asks if it would convert.
  if input is a number then say "a number already"
  if input can be a number then put input as number into n
  if 3.0 is an integer then say "whole"   -- a test on the value, not a kind
  if "banana" contains "nan" then say "contains"   -- also: begins with, ends with
  if 3 is in [1, 2, 3] then say "found it"
end comparisonTour

-- 5. Control flow (ADR 0003, 0019) --------------------------------------------

on controlTour fruit
  -- One-line `if`. Its `else` must be on the same line.
  if the length of fruit > 3 then say "lots" else say "a few"
  if fruit is empty then
    say "no fruit"
  else if the length of fruit = 1 then
    say "one fruit"
  else
    say "some fruit"
  end if
  repeat for each f in fruit        -- loops walk a snapshot of the list
    say f
  end repeat
  repeat for each i in 1..3         -- `..` makes a range
    say i & ": " & item i of fruit
  end repeat
  repeat 3 times
    say "hip hip"
  end repeat
  put 3 into count
  repeat while count > 0
    subtract 1 from count
  end repeat

  -- `repeat until …` is the same, the other way round.
  repeat forever
    add 1 to count
    if count mod 2 = 0 then next repeat   -- skip to the next pass
    if count > 9 then exit repeat         -- leave the loop
  end repeat

  -- `match` tries each `when` in order: Destructuring, plus an optional Guard.
  match fruit
    when [] then put "none" into shape
    when [one] then put "just " & one into shape
    when [x, y, ...] then put "starts " & x & ", " & y into shape
    else put "something else" into shape
  end match
end controlTour

-- 6. Chunk Expressions (ADR 0011, 0019) ---------------------------------------

-- A Chunk Expression names part of a text or list by ordinal and kind.
on chunksTour
  put "The quick brown fox" into s
  put word 2 of s into w            -- "quick"
  put character 1 of w into c       -- "q"
  put characters 2..4 of w into mid -- "uic"
  put the last word of s into tail  -- "fox"
  put word -1 of s into tail2       -- "fox": negative counts from the end
  put the length of s into len      -- 19 Characters
  put the words of s into ws        -- ["The", "quick", "brown", "fox"]
  put the length of the words of s into wordCount   -- 4
  put "a,b,c" into row
  put item 2 of row into b          -- "b": items are comma-separated...
  put item 2 of "a;b;c" delimited by ";" into b2   -- ...unless you say
  put "X" into item 2 of row        -- `row` is now "a,X,c"

  -- Chunks of text are text, so arithmetic needs `as number`.
  put word 1 of "12 apples" as number * 2 into dozen2   -- 24

  -- Reading past the end gives "". Writing past the end pads items and
  -- lines, and is an error for characters and words.
end chunksTour

-- 7. Units and Quantities (ADR 0022) ------------------------------------------

-- A numeric literal directly followed by a Unit makes a Quantity.
-- The Unit is part of the value: `5 kg` and `5` are different values.
on unitsTour
  put 5 kg into bag
  put bag + 250 g into heavier      -- the left operand's Unit wins: kg
  put 500 mi / 4 hr into speed      -- 125 mi/hr (a spaced `/` divides)
  put speed as km/hr into metric    -- 201.168 km/hr, exactly
  put 9.81 m/s^2 into gravity       -- Compound Units have no spaces
  put 3 as kg into w                -- `as` gives a plain number a Unit

  -- `5 kg + 3` and `5 kg + 2 m` are errors.
  put 2 m * 3 ft into area          -- 1.8288 m^2, in the left operand's Units
  put 4 yd / 2 ft into ratio        -- 6: no Units left, a plain number
  put 100 EUR * 1.1 USD/EUR into price   -- 110.0 USD: rates are values
  put 9 degF as degC into warmer    -- 5: temperatures are differences

  -- Exact durations: ms, s, min, hr, day, week. Calendar Units: month, year.
  put 90 min + 1 day into wait1     -- converts into the left Unit: 1530 min

  -- `1 month + 1 day` is an error: a month has no fixed length.
end unitsTour

-- 8. Handlers and functions (ADR 0004, 0016, 0019, 0020, 0021) ----------------

-- A Handler runs when its message reaches the Script. Its Run lasts from
-- that message to its end.
on greet name
  if name is empty then return      -- a bare `return` leaves early
  add 1 to visits
  say welcome & ", " & name & "! Visit number " & visits
end greet
-- Calling it from another Handler is a Command Call: `greet "Ann"`.

-- Handler Clauses: several Handlers for one message, tried top to bottom.
-- Each Destructures the arguments and may add a `where` Guard, a condition
-- the clause needs before it's chosen.
on handle {type: "invoice", amount: a} as inv where a > 1000
  send review with inv to approvals -- `as inv` names the whole argument
end handle

on handle {type: "invoice"} as inv
  file inv                          -- a Command Call to a Handler `file`
end handle

on handle other
  pass handle                       -- hand it on up the Message Path
end handle
-- With no matching clause, the message climbs the Message Path: the parent
-- objects the Host declares.

on move [x, y], speed where speed > 0 m/s   -- one Destructuring each
  put x & "," & y into position
end move

on order {customer: {name: n}, items: [first, ...rest]}
  say n & " ordered " & (the length of rest + 1) & " things"
end order

-- A Guard may call Built-ins only, never Script or Library code. An Error
-- inside a Guard just skips the clause.
on score {player: p, points: pts} where max(pts) >= 100
  say p & " wins"
end score

-- A function is called `f(x)` and returns a value. It can never suspend.
function tax amount, rate
  return amount * rate
end tax

on checkout
  say "Tax is " & tax(100, 0.2)     -- "Tax is 20.0"
end checkout

-- 9. Messages and waiting (ADR 0004, 0016, 0019, 0026, 0031) ------------------

-- Every Script is an actor with one FIFO mailbox. It never executes two Runs
-- at the same instant, but a new Run may start while another is suspended.
-- Runs interleave only at Suspension Points, and every one of them is
-- written with the word `wait`. There is no `await`.

on submit order
  send review with order to approvals            -- into its mailbox; go on
  send review with order to approvals and wait   -- suspend until it answers
  if it is "approved" then ship order            -- the answer is in `it`
end submit

on review order                     -- the receiving side
  if the amount of order > 1000 then return "needs a human"
  return "approved"
end review

-- A Queueing Policy says what happens when a message arrives while an
-- earlier Run of the same clause is still suspended.
on tick                             -- no suffix: the Runs run concurrently
  advance world
end tick
on save doc, queued                 -- one at a time, in order
  ask storage to save doc and wait
end save
on keypress k, dropping             -- ignore arrivals while one is running
  handleKey k
end keypress
on search term, replacing           -- cancel the earlier Run, start this one
  send query with term to index and wait
  showResults it
end search

on blink
  show light
  wait 500 ms                       -- a short pause is a Suspension Point
  hide light
end blink

on flash
  blink and wait                    -- a call to a Handler that may suspend
end flash                           -- must say so

on awaitPayment order
  put the id of order into orderId
  send pay with order to payments
  wait for                          -- wait for one of several messages
    when paid {order: o} where o = orderId then
      ship order
    when failed {order: o, reason: r} where o = orderId then
      send refused with r to customer
    after 2 min then
      cancel order
  end wait
end awaitPayment

on confirm
  wait for click from okButton or 30 s
  if it is nothing then say "timed out"   -- `it`: the message, or Nothing
end confirm

-- A Decision is the Host asking "may this happen?". A `, deciding` Handler
-- answers it: `veto` refuses, with a reason, and ends the Run. Reaching the
-- first `wait`, or the end, allows. So every `veto` (and `pass`) must come
-- before any `wait`; the loader checks.
on beforeMove m, deciding
  if the to of m is in ownSquares then veto "Your own piece is there."
  pass beforeMove                   -- let the board decide too
end beforeMove
on beforeMove m, deciding           -- in the board's Script
  if paused then veto "The game is paused."
  ask replay to record m and wait   -- the move is allowed from here on
end beforeMove

-- 10. Libraries (ADR 0020, 0021, 0022, 0023) ----------------------------------

-- A Library is shared code the Host supplies, with no state of its own. Its
-- code runs inside the caller's Run. An Import names exactly what it brings in.
-- The Standard Library is seven Libraries written in the language itself:
use pad, split, join, format from text   -- also: padLeft, repeated, …
use average, filter, map, reduce, sortBy, any, partition from list
use merge from map
use toHex from bytes
use decodeJson from json
use makeDate, formatDate from date
use celsiusToFahrenheit from units
use trim from text as tidy          -- renamed as it comes in
-- Two definitions with the same name are a load error, never a shadow.

on librariesTour body
  put average([18, 21, 24]) into mean              -- 21
  put pad("id", 6) & "|" into cell                 -- "id    |"
  put tidy("  hi  ") into hi                       -- "hi"
  put join(split("a b c", " "), "-") into dashed   -- "a-b-c"
  put merge({a: 1}, {b: 2}) into ab
  put decodeJson(body) into data    -- JSON null becomes Nothing
  put toHex(<<0x0D, 0x0A>>) into hex
  put celsiusToFahrenheit(20) into f               -- 68
  -- There is no interpolation syntax. `format` fills a template from a map:
  put format("{who} has {n} items", {who: "Ann", n: 3}) into summary

  -- Civil Dates, built with the `date` Library:
  put makeDate(2026, 9, 27) into launch            -- a Civil Date: no time zone
  put launch + 1 month into nextMonth              -- 27 October 2026
  put "2026-09-27" as civil date into sameDay      -- no date literal: convert text
  put launch as text into iso                      -- "2026-09-27"
  put formatDate(launch, "{day:2}/{month:2}/{year}") into shown  -- a template: "27/09/2026"

  -- Built-ins are always there, without an Import:
  put weekday(launch) into wd       -- 7: Sunday (Monday is 1)
  put round(2.5) into three         -- 3: half away from zero by default
  put round(2.345, 2, "half even") into cents      -- 2.34
  put upper("straße") into shout    -- "STRASSE"
  put sqrt(2) * pi into odd         -- correctly rounded to 34 digits
end librariesTour

-- 11. Errors (ADR 0006, 0017) -------------------------------------------------

-- An Error is a plain map with a text `code`. `catch` clauses Destructure it,
-- with optional Guards, and are tried top to bottom like Handler Clauses.
on addUp csvLine
  put 0 into runningTotal
  repeat for each part in the items of csvLine
    try
      add part as number to runningTotal
    catch {code: "can't convert", value: v}
      tell log to write "skipping " & v
    end try
  end repeat
  return runningTotal
end addUp

script variable balance = 100 GBP

on withdraw amount
  if amount <= 0 GBP then throw "bad amount"   -- short for {code: "bad amount"}
  if amount > balance then
    throw {code: "insufficient funds", balance: balance, wanted: amount}
  end if
  subtract amount from balance
end withdraw

on pay amount
  try
    withdraw amount                 -- its Error unwinds straight into here
  catch {code: "insufficient funds", balance: left}
    say "only " & left & " left"
  catch "bad amount"                -- short for a {code: "bad amount"} head
    say "pay something"
  catch e                           -- catches any Error
    throw e                         -- rethrows, keeping where it came from
  finally
    tell log to write "pay attempted"   -- no Suspension Points in here
  end try
end pay

-- A failed `send … and wait` raises {code: "send failed", reason: …} at the
-- sender. A Handler can end in `finally` too, which wraps its whole body.

-- An uncaught Error ends the Run as errored, and the Core then sends this
-- Script an `error` message. (`on error "timeout"` would catch just one code.)
on error {code: c, message: m}, during msg
  tell log to write "a Run failed: " & c & ": " & m
end error

-- A Limit Fault (running out of Fuel, the measure of work a Run may do, or
-- of memory) is never an Error: no `catch` sees it, and the failing
-- Segment (the Run since its last Suspension Point) is rolled back.

-- 12. Text Patterns (ADR 0007, 0011, 0019) ------------------------------------

-- A Text Pattern is a readable alternative to regular expressions, written
-- in <…>. It is a value, so it can be stored and spliced.
on patternsTour msg
  if "ID-0042" matches <"ID-", 4 digits> then say "an id"   -- the whole text
  if msg contains <3 digits> then say "has a number"        -- anywhere in it
  match msg
    when <"ID-", num: 4 digits as number, " ", name: word> then
      put num + 1 into nextId       -- a Capture `name:` binds what it matched
    when <qty: a number, " x ", sku: word> then
      put qty * 2 into twice        -- a Typed Element converts as it matches
    when contains <"WARN"> then
      tell log to write "warning: " & msg
  end match
  put "Smith, Ann" into names
  replace <last: word, ", ", first: word> in names with first & " " & last

  -- `names` is now "Ann Smith". Every match is replaced; `replace first`
  -- replaces one. The expression form gives back the new text:
  put replace <"-"> in "a-b-c" with "+" into plussed   -- "a+b+c"
  put <4 digits> into yearPat
  put <(yearPat), "-", 2 digits> into yearMonth        -- ( … ) splices
  put <one or more of <letter or digit>> into ident    -- nested <…> groups
  if msg contains <word break, "cat", word break> then say "a cat"   -- anchors
  put offset(<"warn" ignoring case>, msg) into pos     -- where it starts

  -- A Match Search gives a list with one match per hit:
  put every match of <digits> in "a1 b22 c333" into hits
  put the length of hits into hitCount                 -- 3
  -- Each match is a map: {text, range, captures, ranges}.
  put the text of item 2 of hits into middle           -- "22"
  put the range of item 2 of hits into span           -- 5..6

  -- Matching runs in linear time: no backreferences, no lookaround, and
  -- repetition is greedy.
end patternsTour

-- 13. Lambdas and Function Values (ADR 0025) ----------------------------------

-- A Lambda, `given <params>: <expr>`, makes a Function Value: a value you can
-- call, store and pass around.
script variable double = given n: n * 2

function isWindy r
  return the wind of r > 30 km/hr
end isWindy

on lambdasTour readings
  put double(21) into answer                        -- 42
  put filter(readings, isWindy) into windy          -- a function's name is a value
  put map(readings, given {temp: t}: t) into temps  -- params can Destructure
  put reduce(readings, given worst, r: max([worst, the wind of r]), 0 km/hr) into peak
  put sortBy(readings, given r: the temp of r) into coolestFirst
  put sortBy(readings, given r: the temp of r, "descending") into warmestFirst
  put sortBy(readings, given r: [the city of r, the temp of r]) into byCity
  if any(readings, isWindy) then say "windy somewhere"
  let [gusty, calm] be partition(readings, isWindy)
  put given k: given x: x * k into multiplier
  put multiplier(3) into triple
  put triple(14) into fortyTwo      -- `multiplier(3)(14)` is a syntax error

  -- A Lambda captures the locals it uses by value, and can't change them.
  -- It reads and writes Script Variables live.
  -- The `given … end given` form can suspend. Calling it then says `and wait`.
  put given url
    ask http to get url and wait
    return the status of it
  end given into statusOf
  statusOf("https://example.com/health") and wait
  put it into status                -- the result lands in `it`
end lambdasTour

-- 14. Joins (ADR 0026) --------------------------------------------------------

-- A Join starts several requests at once and suspends once, at `end wait`.
-- Each `… and wait` it reaches is a Join Member.
on compare stations
  wait for all
    repeat for each s in stations
      send allReadings with s to me and wait
    end repeat
  end wait
  put it into perStation            -- one answer per member, in start order
end compare
-- The first member to fail raises its own Error at `end wait`, with `index`
-- (its start position) added, so `catch {code: "timeout", index: i}` works
-- around the whole Join.

-- 15. Binary Patterns (ADR 0013) ----------------------------------------------

-- A Binary Pattern Destructures Bytes, left to right, in << … >>.
on packet << 0x02, id: uint32, x: int16 little, y: int16 little >>
  send moved with {id: id, x: x, y: y} to lobby
end packet

on frame << len: uint16, body: len bytes, ...rest >>   -- sizes can use
  send framed with body to parser   -- earlier fields; `...rest` keeps the rest
end frame

-- The same brackets build Bytes, with `value as type` fields:
on encodeMove id, x, y
  return << 0x02, id as uint32, x as int16, y as int16 >>
end encodeMove
-- `byte 1 of b` and `bytes 2..5 of b` are chunks. `b as text` decodes UTF-8.

-- 16. Capabilities (ADR 0012, 0019, 0023, 0024) -------------------------------

-- Scripts have no ambient I/O. Every effect is an Operation on a Capability
-- the Host has granted, and the loader checks every call against the Grants.
on capabilitiesTour key
  tell log to write "starting"      -- `tell`: fire and forget
  ask clock to now                  -- `ask`: the answer lands in `it`
  put it into started               -- an Instant: a point on the timeline
  ask calendar to today             -- a Civil Date, in the Grant's time zone
  put it into thisDay
  ask storage to load key and wait  -- a suspending Operation says `and wait`
  put it into saved
  ask locale to compare "a", "B", {sensitivity: "base"}, "de"
  say "hi"                          -- short for: tell console to write "hi"
  set the state of door to "open"   -- `set` writes a Host Object's property
end capabilitiesTour
-- `and wait` must be there exactly when the Operation can suspend. The
-- loader checks both ways, so a wrong guess fails at load, not at run time.

-- 17. Advanced Constructs (ADR 0007, 0011, 0013, 0027) ------------------------

-- Every Core accepts these, but tooling warns beginners about them. Each one
-- has a form on the Beginner Surface (the rest of the language, everything
-- above) that does the same job.

script variable pending = 0

-- The pin `^` compares with an existing variable instead of binding a name.
on answered {id: ^pending, answer: a}
  say a
end answered
-- Beginner Surface form: on answered {id: i, answer: a} where i = pending

on advancedTour s
  put code point 1 of s into cp     -- instead: work in Characters
  put <"<", body: text lazily, ">"> into angled   -- instead: a narrower element
end advancedTour
-- A pinned outer variable can also size a Binary Pattern field:
on firstBytes data, n
  match data
    when << head: ^n bytes, ... >> then return head
  end match
end firstBytes
-- Beginner Surface form: `when << ...rest >>`, then `bytes 1..n of rest`.
```

## Further reading

- [`CONTEXT.md`](../CONTEXT.md): the glossary.
- [`docs/adr/`](adr/): every decision and why it was made.
- [`corpus/examples/orders-pricing/`](../corpus/examples/orders-pricing/): two Scripts talking to each other, as a conformance case.
