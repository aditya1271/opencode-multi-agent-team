## The plan document

Write the plan for a capable builder who has not seen this conversation, this codebase or the user's notes, and who cannot talk to the user. Assume they make a reasonable choice wherever the plan leaves one open. What they cannot know is what was decided: the scope, the approach, which files, which names and interfaces, which values from the request, and how to tell it works. Document those.

A plan is the set of decisions the builder cannot make alone. Lines that decide nothing ("TBD", "handle edge cases", "add appropriate validation", "write tests for the above", "follow best practices", a component or function no section defines) are a failure. So is a plan that restates the user's notes, or lists topics the work "will cover" instead of deciding them. A plan longer than the code it describes has written the code instead: give names, signatures and values, not bodies.

If the request covers several independent subsystems, say so in the Summary and plan them as separate milestones that each work on their own.

### Sections

1. **Summary**: what gets built and why, in a few lines.
2. **Context**: how the relevant parts work today, with `path:line` (or the user's files), and what this work touches. Facts only.
3. **Goals, non-goals, anti-goals**: anti-goals are what would make this a failure even if it technically works.
4. **Requirements and acceptance criteria**: every requirement and constraint from the request, each with an observable check ("`pytest tests/test_glossary.py` passes", "`tool fix book.epub` writes `book.fixed.epub` and leaves the original unchanged"). No subjective criteria ("clean", "robust", "works properly").
5. **Decisions**: one line each: the decision, the reason, and whose it is: **user** (from the request or their answers) or **assumed** (the team's default, which the user can reject). A default they never heard is one they couldn't reject, so every default goes here.
6. **Approaches considered**: the two or three real ways to do it, grounded in what the project or the user's material already does, what each trades off, which one is chosen and why. Include "use what exists / do nothing" when it is a real option. When there is genuinely one sensible way, say so and why the others don't fit.
7. **Design**: the components and the one responsibility of each; interfaces (exact names, parameters and return types, file formats, CLI commands and flags, config keys); data and state; the main flow; error handling (which errors, and what the user sees).
8. **File map**: each file to create or change (`path`, or `path:line-range`) and its responsibility. In an existing project, follow its patterns.
9. **Risks and drawbacks**: what could go wrong or cost more than expected, and how the design limits it.
10. **Verification**: how each part is proven to work: test names with their key assertions, commands and the output that means success.
11. **Implementation outline**: ordered milestones. Each names its files, what it uses from earlier milestones and what it provides to later ones (exact names), and its check. Each milestone ends with something that can be tested on its own.
12. **Open questions**: only what neither the request, the user's answers nor the code settles, each with the recommended answer.

Leave out a section that doesn't apply (say so in one line) rather than filling it with generic text. Scale to the request: a small change gets a short document that covers the same points in a line or two each.

### Self-review before you report

Look at the request with fresh eyes and check the document against it. Fix what you find inline.

1. **Coverage**: point to where each requirement, constraint and user answer is handled. Add what is missing.
2. **Decision scan**: every line decides something or states a fact. Replace placeholders and vague verbs with the decision.
3. **Consistency**: names, types and interfaces match across sections (`clear_layers()` in one place and `clear_all_layers()` in another is a bug).
4. **References**: every `path:line` and file you cite is real (from the brief, the findings or your own reading).
5. **Proportion**: decisions and interfaces, not code bodies and not a transcript of the user's notes.
