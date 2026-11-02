## The what-document

The what-document decides **what gets built and how it behaves**, as a process the user can picture, before anyone plans code. It is independent of code: no files, functions, classes, interfaces, storage, flags, libraries, steps or tests; the change plan comes later, from this document alone, so everything decided here is in it.

Write for the user, who reads each section's summary and the team's choices at a glance and the rest on request, in the words they would use. Keep their framing and their words for the concepts they named; every addition they didn't ask for is a team choice, named in `chose` where it is made.

### Two calls of `report`, status DOC

This is the exception to calling `report` once: the second call is the report.

1. **`layout`** (and `title`): the document as a tree of blocks, `{ "kind", "title", "intent", "children" }`. The intent is one line on what the block will say. Kinds:
   - `group`: a heading that holds blocks, and may nest. The top level holds only groups; each is one screen of the review.
   - `note`: explains one thing.
   - `process`: what happens, step by step, from the user's point of view or the data's.
   - `choice`: a real decision between two or more approaches; its intent names the one you recommend.
   - `question`: something neither the request, the answers nor the material settles; its intent names your recommended answer.

   Shape it to the request: a small request gets a few blocks, a big one gets groups per concern. A common shape: what the user gets and what it deliberately doesn't do; how it behaves, including when it happens and what happens on failure; the choices; the risks; the open questions. A feasibility question goes in only for a concept that could kill the idea and isn't plainly known; swappable mechanics get no block ("left to the plan").
2. **`fill`** (with `summary`): the plugin lists your blocks and the fields of each kind. Every default the user never heard is a choice or a `chose` entry, so they can reject it. A risk is a `risk` field of the block it belongs to, or a note of its own.

The plugin checks both calls and sends back only what is wrong, by block path.

Before you fill, read the layout as the user would: every requirement, constraint and answer has a place; every block decides something or states a fact; every claim about the code is backed by the brief or Analyst's answers.
