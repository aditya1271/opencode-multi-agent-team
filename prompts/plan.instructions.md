## The what-document

The what-document decides **what gets built and how it behaves**, as a process the user can picture, before anyone plans code. It is independent of code: no files, functions, classes, interfaces, storage, flags, libraries or tests. The how stage turns it into a change plan later, from this document alone, so everything decided here must be in it.

Write for the user, who reads each section's summary and the team's choices at a glance and the rest on request, in the words they would use: the team's own terms (what-document, how stage, Intern, `A9`) mean nothing to them. Keep their framing and their words for the concepts they named; every addition they didn't ask for is a team choice, named as such where it is made. A section's Team chose and Risk lines are there when it has a choice or a risk of its own, and left out otherwise.

### Sections

1. **What it does**: in a few lines, what the user gets and why, and a closing line on what it deliberately doesn't do.
2. **The process**: what happens, step by step, from the user's point of view or the data's: inputs, what is done to them, outputs, what the user sees and decides along the way. Number the steps.
3. **When it happens**: what triggers it, how often, and what happens on failure or on input it can't handle (as behaviour, not error codes).
4. **Choices**: for each concept that decides whether the result is good, the two or three real approaches, what each trades off, and which one is chosen and why, as a list with one item per concept, each ending `**Recommended:**`. The concepts the user stressed come first. When there is genuinely one sensible way, say so in one line.
5. **Feasibility**: only for a concept that could kill the idea or force a different one and isn't plainly known (work nobody has done before, an assumption about how parts fit, a solution assumed to exist): what is uncertain, what the brief or answers show, and what happens if it fails, ending `**Recommended:**`. Swappable mechanics (how a model or service is connected, which file format or parser, storage, configuration) get no feasibility note and no options: one line, "left to the plan". In a code project, code facts count where they rule a behaviour in or out (what the language, platform or module supports), with the evidence.
6. **Decisions**: the team's defaults that Choices doesn't already cover, a list, one line each: the default, the alternative passed over, and the reason, ending `**Recommended:**` (the default is **assumed**: the user can reject it). What the user said is already the request, so it isn't repeated here; a point their files settle names the file. A default the user never heard is one they couldn't reject, so each one is in Choices or here.
7. **Risks**: what could make the result disappoint, or can't be undone, as the list of everything the user should weigh; another section's Risk line holds only a risk of that section.
8. **Open questions**: anything neither the request, the answers nor the material settles, each with the recommended answer.

Leave out a section that doesn't apply (say so in one line). Scale to the request: a small feature gets a short document that covers the same points in a line or two each.

Before you report, read it as the user would: every requirement, constraint and answer is handled; no file, function, interface or test names remain; every line decides something or states a fact ("TBD", "handle edge cases" decide nothing); and every claim about the material or the code is backed by the brief or Analyst's answers.
