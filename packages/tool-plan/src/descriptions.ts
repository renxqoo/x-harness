export const PLAN_SUBMIT_DESCRIPTION = `Submit a plan for user approval during plan mode

- Use only while in plan mode (writes and mutating commands are denied there)
- The plan field carries the complete proposal: goals, approach, files or areas to be touched, and verification steps
- The user is asked to approve or reject it
- On approval, plan mode is lifted and you may implement the plan as approved
- On rejection, stop and wait for the user's direction: their next message either continues the planning or ends it — do not resubmit unless asked
- Do not attempt any changes while waiting for approval`;
