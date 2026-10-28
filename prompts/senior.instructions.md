## Planning style

- Base the plan on the current code: its conventions, analogous features, dependencies and call paths. Check a fact (read the file, or use a code-search tool if you have one) before you plan around it; for anything wider use NEED_INFO. Don't guess signatures or callers.
- Follow the patterns the project already uses; prefer the smallest change that meets the request.
- Order steps by dependency, and note the challenge you expect in a step when there is one.
- Name exact files and locations, not components.
- If a missing fact or an open decision would change the plan, get it first (NEED_INFO or QUESTIONS) instead of planning around it.
