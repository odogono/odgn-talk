# Folio groups are nested Elements with Page-wide names

For [#1142](https://github.com/odogono/odgn-talk/issues/1142), a group is a named Group Element with its own identity in both Edit and Play, so Scripts can address a composite to hide or move it. Group Elements may contain other Group Elements from the first version. Every member retains its existing name and remains directly accessible to Scripts on its Page; Group Elements share the same Page-wide namespace as other Elements.

An editor-only group would make composites easier to manipulate while leaving Scripts to show, hide and move each member separately. Group-local namespaces would allow repeated member names, but grouping existing Elements would then change their Script bindings. Keeping Page-wide names preserves the binding policy in [ADR 0084](0084-creative-tool-scripts-reach-elements-through-load-time-names-properties-and-three-grants.md). Supporting nesting from the outset avoids making authors flatten existing composites to combine them.

This records the agreed Host policy. Current support and limitations are described in the [Folio guide](../../tooling/creative/README.md#grouping-elements).

## Geometry and visibility

Member `left` and `top` remain Page-relative, so grouping does not change the coordinates existing Scripts read and write. Moving a Group Element translates every descendant by the same displacement, including empty groups' retained positions. A group's rectangle is the tight bounding box of its members, including hidden members; editing a member can therefore change the group's bounds. An empty group retains its last position with zero width and height, its name, identity and Script, and an empty collection. It contributes that position as a zero-size rectangle to its parent's bounds. Deleting its last member does not silently remove the group or stop its Script. Group width and height are initially read-only, with no resize handles, scaling or clipping. Scaling would introduce separate choices about text, border and image sizes that collective movement does not require.

Each Element retains its own `visible` value. A member is displayed only when it and every containing Group Element are visible. Hiding and showing a group preserves individually hidden members; neither action stops member Scripts. Recursively setting member visibility would lose their individual states.

During Play a group has no painted background or independent hit area. Gaps between members let pointer input pass through to underlying Elements. Visible members receive input and their messages can follow the Message Path through group Scripts. A hidden ancestor suppresses its members' pointer and keyboard interaction. In Edit, group outlines and small markers for empty groups keep them selectable.

## Stacking and messages

A Group Element is one stacking unit. Grouping preserves the selected members' relative order and places the composite at the frontmost selected position. For back-to-front Elements A, B, C, grouping A and C places the composite in front of B. This can change overlap with unselected Elements, but avoids interleaved groups whose members cannot move through the layer order as one unit.

Group Elements may own Scripts. A member's Message Path runs through its containing groups, from innermost to outermost, before the Page and Project, while `the target` remains the original member. This lets one composite handle its members' messages centrally. `hide` and `show` remain Host Commands, which do not travel along the Message Path ([ADR 0094](0094-host-commands-are-command-call-spellings-of-granted-operations.md)).

## Authoring and structural operations

At Page scope, clicking a grouped member selects its outer group. Double-clicking a group enters one level, making its immediate members selectable. Escape finishes active text editing first; otherwise it leaves one level and selects the group just exited. Clicking outside returns to Page scope. Modified Script-opening clicks and Info retain access to a group's Script.

Group operates on two or more selected siblings in the current editing scope. It preserves existing nested groups intact, gives the new composite a fresh Page-wide name and selects it. Selection does not span different immediate parents.

Newly drawn or inserted Elements join the entered group. Duplicate and layer commands operate among siblings in that scope. Existing membership is reorganized through Ungroup and Group; drag-to-reparent is deferred. Undo and redo restore the entered-group context alongside selection. Changing Pages returns to Page scope.

Ungroup dissolves exactly one level. Its immediate members become siblings in the group's former parent and layer position, preserving their identities, names, Page coordinates and relative order. If the group was hidden, its immediate members become individually hidden so ungrouping does not reveal them. The group and its Script are removed; references to its name are not rewritten. Undo restores the group, its Script and the members' prior state.

Duplicating a group copies its entire subtree with fresh names and identities throughout. The copy becomes a sibling of the original, offset 20 pixels in both directions once for the composite as a whole. Script source remains unchanged, following existing duplication behavior: a copied Script mentioning an original member by name still refers to that original member. `me` and positional member references can address the copy. Automatic reference rewriting is deferred. This issue extends the existing Duplicate action, without introducing Element clipboard copy/paste.

Deleting a group removes its entire subtree, stops its own Script and every descendant Script, and disposes every handle in that subtree. Each editor action is one undoable edit.

Creating groups, ungrouping, reparenting and inserting new members remain authoring actions initially. Scripts may move, hide, inspect, clone and delete authored groups, including deleting individual members, but there are no new group, ungroup or reparent Operations in this version. `elements.create` continues to create ordinary Elements on a Page; it does not create groups or insert into them.

## Collections and file compatibility

A Page's Object Collection continues to find every descendant by its Page-wide name. A Group Element also offers an Object Collection containing its immediate members; reaching a deeper member through groups requires following that hierarchy. Thus both `element "alertText" of thisPage` and `element "alertText" of gameOverAlert` can refer to the same direct member, without creating a new namespace. This extends Folio's collection policy in [ADR 0100](0100-object-element-references-use-a-fixed-spelling-and-a-host-collection.md); collection membership and Message Path parentage remain separate Host policies.

A Page's numeric collection counts every group and descendant. It traverses siblings back to front, listing each group after its members. For Page contents `A, G(B, C), D`, its indexed order is `A, B, C, G, D` and its count is 5. Thus a frontmost composite is the Page's last Element. A group's own numeric collection counts only its immediate members in their local layer order.

Group Elements introduce `.folio` format 2. Format-1 Projects open with their existing content unchanged through migration; older Folio versions refuse newer files. A version boundary is necessary because old readers discard unknown properties and reject unknown Element kinds, so adding membership metadata without one could silently lose structure.

The saved ownership structure is a nested tree of ordered members, with leaf coordinates still Page-relative. Nonempty group bounds are derived after loading rather than saved. Only an empty group's retained position needs saving as group geometry. Session-local ids, parent indexes and lookup caches are not persisted. Browser storage uses the same representation.

## Bounded work and operation failures

Each outermost group's subtree is limited to 1,024 Elements, counting the outer group itself, nested groups and ordinary members. At most 32 group levels may be nested. Import, authoring and runtime cloning enforce the same limits; independent Page Elements do not count against a Page-wide ceiling. Cloning a nested member must also respect the resulting outer group's size and depth.

These are visible authoring limits in exchange for bounded group work without Core API changes. Property callbacks currently accept fixed declared Fuel costs, so their costs must cover the permitted traversal and ancestor-bound maintenance before work starts. Scalar property writes maintain cached copy-work deltas along at most 32 group ancestors; unchanged content is not serialized again. Existing scalar collection callbacks must use maintained indexes rather than rebuilding a flattened tree for each lookup. Clone and delete obtain the required Fuel up front before effects, including any size-dependent work.

An invalid coordinate, exceeded size limit or refused Fuel authorization leaves a move, clone or delete unapplied. Successful cloning installs the complete subtree and its message parents before subsequent Script statements can observe it. This is operation-level preflight and publication, not a new promise to roll back all Folio effects with a Segment.

The [implementation handoff](../handoffs/1142-group-elements.md) records delivery scope and acceptance.
