'use strict';

// Generic completion contract for generated projects. This deliberately
// describes behaviours and boundaries, not any one project's filenames.
const GENERATED_PROJECT_QUALITY_CONTRACT = `
Before calling task_complete, perform a final integration pass over the generated project.

1. Start at the real user entry point. Confirm the default route/page renders without a
   click, every required screen or command is reachable, and navigation does not depend
   on stale client state.
2. Trace every frontend request to a real backend route and every backend write to the
   persistence technology named by the architecture. Remove hardcoded users, questions,
   scores, and demo responses when the specification requires durable storage.
3. Trace authentication end to end. Registration must create the documented role, login
   must verify the stored password, protected actions must verify the token and role, and
   users must not see or access another role's controls.
4. Exercise the important workflow: create or authenticate the correct actor, perform the
   primary use case, save its result, reload/read it back, and verify errors are visible.
5. Check generated answer choices, IDs, timestamps, and other dynamic data for correct
   mapping. Do not assume the first displayed option is correct; preserve the data's
   identity while allowing presentation ordering to change.
6. Run the available tests and a narrow startup/API smoke check. Repair failures before
   task_complete. If a live external service is required, report the exact prerequisite
   instead of silently substituting in-memory data.

The project is complete only when the user-visible surface, backend routes, persistence,
security rules, and tests agree with each other. These checks are generic and must be
applied to the architecture specification supplied for this run.
`;

module.exports = { GENERATED_PROJECT_QUALITY_CONTRACT };
