// 工具 description（docs/PERMISSION-MODE-FLAG.md plan 模式节）：正文沿 Claude Code
// ExitPlanMode 语义按本仓形态改写——审批经 permission broker（用户侧确认条），
// 批准即解档（liftTo 宿主装配缺省），拒绝留在 plan 档继续 refine。

export const PLAN_SUBMIT_DESCRIPTION = `Submit a plan for user approval during plan mode

- Use only while in plan mode (writes and mutating commands are denied there)
- The plan field carries the complete proposal: goals, approach, files or areas to be touched, and verification steps
- The user is asked to approve or reject it
- On approval, plan mode is lifted and you may implement the plan as approved
- On rejection, stop and wait for the user's direction: their next message either continues the planning or ends it — do not resubmit unless asked
- Do not attempt any changes while waiting for approval`;
