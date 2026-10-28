# Pointer messages carry an event map

Folio's `click` carries one argument, the map `{button, x, y}`, and the new `pointerHeld` carries `{held, x, y}`. `button` is the browser's numbering (0 primary, 1 middle, 2 secondary), and `x` and `y` are Page units from the Element's top-left corner. A Handler chooses a button or a region with Destructuring and Guards, as in `on click {button: 2}` or `on click {button} where button is 0`. A click no clause matches climbs the Message Path, like any message. `pointerHeld` goes once per displayed frame, while a press lasts, to an Element whose Message Path handles it. A long press is a Guard on `held`.

We chose this because Dispatch matches exact arity, so a message can grow only by growing a value it already carries. A map pattern matches any map that has its listed keys, so later keys, such as modifiers, will reach every existing Handler without changing it. This is how other exact-arity systems carry input: Smalltalk's Morphic passes one event object, and Phoenix LiveView passes one params map.

The change breaks every zero-parameter `on click`, which no click now reaches. Format 5 of the Project file rewrites each `on click` as `on click {button: 0}`, keeping it to the primary button as before, and gives each argument-free `click` a Script sends the same map. A send with a computed name can't be seen, and is left alone. The Code Browser warns about an `on click` without a parameter, and advises about a clause such as `on click {}` that every button reaches.

We considered four alternatives:

- **A `secondaryClick` or `auxClick button` message beside `click`.** It breaks nothing, but every new input would need its own message.
- **Choosing `click`'s arity from the Script that will handle it.** Folio would send `click button` to a Script declaring a one-parameter clause, and plain `click` otherwise. It keeps old Scripts working, but no other language does it, and a reader can't predict it once the message climbs the Message Path.
- **A HyperTalk-style query, such as `the clickButton`, read while a click Handler runs.** It changes no arity, but the value means something only during that Run.
- **`pointerDown` and `pointerUp held` primitives in place of `pointerHeld`.** A Guard on the release can't give feedback while the press lasts.
